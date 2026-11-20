import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { internalJobAction, internalJobMutation } from "./functions";
import { components, internal } from "./_generated/api";
import { applyTicketChange, createTicketRecord } from "./domain/tickets";
import { requireUsableProject } from "./domain/projects";
import { ensureFixtureCustomer, ensureFixtureStaff, fixtureAccess, LOCAL_CUSTOMERS, LOCAL_STAFF, mintFixtureSession } from "./local_identity";
import { actorFields, newTicketOwnership } from "./authz";
import { ticketRequestFingerprintInput } from "../shared/ticket-contracts";
import { hashTicketRequest } from "./ticket_requests";
import { commitTicketRequest, replayTicketRequest, type RequestScope } from "./domain/requests";
import { requireLocalFixtures } from "./local_fixtures";
import { requireLegacyAccess } from "./pilot_access";

/** Opt-in internal fixture only. No reset and no provider I/O. Repeated runs reuse Projects, principals and Tickets; each run mints fresh fixture sessions with admission. */
export const install = internalJobMutation({
  name: "seed:install",
  args: {},
  handler: async (ctx) => {
    requireLocalFixtures();
    await requireLegacyAccess(ctx);
    const now = Date.now();
    const projects = [];
    for (const [key, name] of [["POS", "Point of Sale"], ["APP", "Customer App"]]) {
      let project = await ctx.db.query("projects").withIndex("by_key", q => q.eq("key", key)).unique();
      if (!project) {
        const id = await ctx.db.insert("projects", { key, name, createdAt: now, updatedAt: now });
        project = (await ctx.db.get(id))!;
      }
      projects.push(project);
    }
    const staffMembers = [];
    for (const input of LOCAL_STAFF) staffMembers.push(await ensureFixtureStaff(ctx, input));
    const customers = [];
    for (const input of LOCAL_CUSTOMERS) customers.push(await ensureFixtureCustomer(ctx, input));
    const project = projects[0];
    for (const customer of customers) {
      const membership = await ctx.db.query("projectMembers").withIndex("by_project", q =>
        q.eq("projectId", project._id).eq("customerId", customer._id)).unique();
      if (!membership) await ctx.db.insert("projectMembers", { projectId: project._id, customerId: customer._id, createdAt: now });
    }
    const principals = [
      { name: "staff", principal: { principal: "staff" as const, staff: staffMembers[0] } },
      { name: "Alice", principal: { principal: "customer" as const, customer: customers[0] } },
      { name: "Bob", principal: { principal: "customer" as const, customer: customers[1] } },
    ];
    const tickets = [];
    const sessions: string[] = [];
    // Local browser fixtures need real access tokens for their HTTP client.
    const accessTokens: string[] = [];
    for (const { name, principal } of principals) {
      const minted = await mintFixtureSession(ctx, principal);
      sessions.push(minted.authSessionId);
      accessTokens.push(minted.tokens.accessToken);
      const sessionId = minted.admissionId;
      const { actor } = await fixtureAccess(ctx, minted.authSessionId);
      const requestId = `seed-${name}`;
      const title = actor.role === "staff" ? "Printer needs review" : `Ticket from ${name}`;
      const description = "Deterministic local text-only example";
      const request: RequestScope = {
        operation: "ticket.create", requestId, actor, projectId: project._id,
        ...await hashTicketRequest(ticketRequestFingerprintInput({ actor, projectId: project._id, title, description })),
      };
      let ticket = (await replayTicketRequest(ctx, request))?.ticket;
      if (!ticket) {
        ticket = await createTicketRecord(ctx, {
          project: await requireUsableProject(ctx, actor, project._id),
          title, description, media: [],
          ownership: newTicketOwnership(actor), author: { sessionId, ...actorFields(actor) },
          now,
        });
        await commitTicketRequest(ctx, request, { ticketId: ticket._id, version: ticket.version });
      }
      tickets.push(ticket._id);
    }
    return { projects: projects.map(p => ({ id: p._id, key: p.key })), tickets, sessions, accessTokens };
  },
});

/**
 * Disposable rehearsal stand-in for the Owner's first Google sign-in: the
 * verified pending identity that the real one-use `identity:bootstrapOwner`
 * then promotes. Only before any staff exists.
 */
export const localPendingOwner = internalJobMutation({
  name: "seed:localPendingOwner",
  args: {},
  handler: async (ctx) => {
    requireLocalFixtures();
    await requireLegacyAccess(ctx);
    if (await ctx.db.query("staff").first()) throw new Error("BOOTSTRAP_ALREADY_USED");
    const owner = LOCAL_STAFF[0];
    const existing = await ctx.db.query("users").withIndex("by_google_subject", q => q.eq("googleSubject", owner.subject)).unique();
    const now = Date.now();
    if (!existing) await ctx.db.insert("users", {
      kind: "pending", googleSubject: owner.subject, googleEmail: owner.email, googleEmailVerified: true, googleVerifiedAt: now, googleName: owner.name, createdAt: now,
    });
    else if (existing.kind !== "pending") throw new Error("PENDING_IDENTITY_REQUIRED");
    return { googleSubject: owner.subject, email: owner.email };
  },
});

export const run = internalJobAction({
  name: "seed:run",
  args: { largeDataset: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<{ projects: { id: Id<"projects">; key: string }[]; tickets: Id<"tickets">[]; sessions: string[]; accessTokens: string[] }> => {
    requireLocalFixtures();
    const seed = await ctx.runMutation(internal.seed.install, {});
    if (args.largeDataset) {
      for (const project of seed.projects) {
        for (let start = 0; start < 150; start += 25) await ctx.runMutation(internal.seed.largeBatch, { projectId: project.id, sessions: seed.sessions, start });
      }
    }
    return seed;
  },
});

/** Separate local identities for destructive browser tests of staff account changes. */
export const installBrowserStaffAccounts = internalJobMutation({
  name: "seed:installBrowserStaffAccounts",
  args: {},
  handler: async (ctx): Promise<{
    ownerEmail: string; memberEmail: string; memberId: Id<"staff">;
    candidate: { email: string; subject: string; accessToken: string; refreshToken: string };
  }> => {
    requireLocalFixtures();
    const suffix = crypto.randomUUID();
    const ownerEmail = `browser-owner-${suffix}@local.test`;
    const memberEmail = `browser-staff-${suffix}@local.test`;
    await ensureFixtureStaff(ctx, { email: ownerEmail, name: "Browser Owner", role: "owner", subject: `owner-${suffix}` });
    const member = await ensureFixtureStaff(ctx, { email: memberEmail, name: "Browser Staff", role: "staff", subject: `staff-${suffix}` });
    const email = `browser-replacement-${suffix}@local.test`;
    const subject = `replacement-${suffix}`;
    const userId = await ctx.runMutation(internal.identity.createGoogleUser, {
      method: { name: "google", profile: { id: subject, email, emailVerified: true } },
    });
    await ctx.runMutation(components.authGoogle.provider._internal_dangerous_createAccount, { providerAccountId: subject, userId });
    const { tokens } = await mintFixtureSession(ctx, { principal: "pending", userId });
    return { ownerEmail, memberEmail, memberId: member._id, candidate: { email, subject, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken } };
  },
});

/** 300 additional text-only Tickets across two Projects, through domain writes.
 * Batches keep the fixture's own reads/writes bounded. Replays do not reset edits.
 */
export const largeBatch = internalJobMutation({
  name: "seed:largeBatch",
  args: { projectId: v.id("projects"), sessions: v.array(v.string()), start: v.number() },
  handler: async (ctx, args) => {
    requireLocalFixtures();
    await requireLegacyAccess(ctx);
    if (![0, 25, 50, 75, 100, 125].includes(args.start) || args.sessions.length !== 3) throw new Error("INVALID_INPUT");
    const accesses = await Promise.all(args.sessions.map(session => fixtureAccess(ctx, session)));
    for (const { actor } of accesses) if (actor.role === "customer") {
      const membership = await ctx.db.query("projectMembers").withIndex("by_project", q => q.eq("projectId", args.projectId).eq("customerId", actor.customerId)).unique();
      if (!membership) await ctx.db.insert("projectMembers", { projectId: args.projectId, customerId: actor.customerId, createdAt: Date.now() });
    }
    const statuses = ["new", "acknowledged", "in_progress", "waiting", "done"] as const;
    for (let index = args.start; index < args.start + 25; index++) {
      const { actor, session } = accesses[index % 3];
      const project = await requireUsableProject(ctx, actor, args.projectId);
      const title = index === 0 ? "quartz" : index === 1 ? "Printer calibration" : index === 2 ? "quartz calibration" : `Printer queue fixture ${index}`;
      const description = index === 1 ? `quartz ${"receipt context ".repeat(150)}` : index < 3 ? "" : `Receipt printing ${"local context ".repeat(index % 20)}`;
      const request: RequestScope = { operation: "ticket.create", requestId: `seed-large-${project.key}-${index}`, actor, projectId: project._id,
        ...await hashTicketRequest(ticketRequestFingerprintInput({ actor, projectId: project._id, title, description })) };
      if (await replayTicketRequest(ctx, request)) continue;
      const author = { sessionId: session._id, ...actorFields(actor) };
      const ticket = await createTicketRecord(ctx, { project, title, description, media: [], ownership: newTicketOwnership(actor), author, now: Date.now() });
      await commitTicketRequest(ctx, request, { ticketId: ticket._id, version: ticket.version });
      const status = statuses[index % 5];
      if (status !== "new") await applyTicketChange(ctx, { doc: ticket, expectedVersion: ticket.version, changes: { status }, action: "status_changed", author, now: Date.now() });
    }
  },
});
