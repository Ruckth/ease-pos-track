import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { internalJobAction, internalJobMutation } from "./functions";
import { internal } from "./_generated/api";
import { createPasswordRecord } from "./password";
import { applyTicketChange, createTicketRecord } from "./domain/tickets";
import { requireUsableProject } from "./domain/projects";
import { requireActor } from "./session_auth";
import { actorFields, newTicketOwnership } from "./authz";
import { ticketRequestFingerprintInput } from "../shared/ticket-contracts";
import { hashTicketRequest } from "./ticket_requests";
import { commitTicketRequest, replayTicketRequest, type RequestScope } from "./domain/requests";
import { requireLocalFixtures } from "./local_fixtures";

/** Opt-in internal fixture only. No reset and no provider I/O. Repeated runs reuse Projects, customers and Tickets; each run issues fresh random sessions. */
export const install = internalJobMutation({
  name: "seed:install",
  args: {
    passwordAlgorithm: v.string(), passwordSalt: v.string(),
    passwordHash: v.string(), passwordIterations: v.number(),
  },
  handler: async (ctx, record) => {
    requireLocalFixtures();
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
    const customers = [];
    for (const email of ["alice@local.test", "bob@local.test"]) {
      let customer = await ctx.db.query("customers").withIndex("by_email", q => q.eq("email", email)).unique();
      if (!customer) {
        const id = await ctx.db.insert("customers", { email, ...record, createdAt: now, updatedAt: now });
        customer = (await ctx.db.get(id))!;
      }
      customers.push(customer);
    }
    const project = projects[0];
    for (const customer of customers) {
      const membership = await ctx.db.query("projectMembers").withIndex("by_project", q =>
        q.eq("projectId", project._id).eq("customerId", customer._id)).unique();
      if (!membership) await ctx.db.insert("projectMembers", { projectId: project._id, customerId: customer._id, createdAt: now });
    }
    const actors = [
      { name: "staff", actor: { role: "staff" as const } },
      { name: "Alice", actor: { role: "customer" as const, customerId: customers[0]._id } },
      { name: "Bob", actor: { role: "customer" as const, customerId: customers[1]._id } },
    ];
    const tickets = [];
    const sessions: string[] = [];
    for (const { name, actor } of actors) {
      const token = crypto.randomUUID();
      sessions.push(token);
      const sessionId = await ctx.db.insert("sessions", {
        token, ...actor, createdAt: now, expiresAt: now + 14 * 86_400_000,
      });
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
    return { projects: projects.map(p => ({ id: p._id, key: p.key })), tickets, sessions };
  },
});

export const run = internalJobAction({
  name: "seed:run",
  args: { largeDataset: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<{ projects: { id: Id<"projects">; key: string }[]; tickets: Id<"tickets">[]; sessions: string[] }> => {
    requireLocalFixtures();
    const pepper = process.env.CUSTOMER_PASSWORD_PEPPER;
    if (!pepper) throw new Error("CUSTOMER_AUTH_NOT_CONFIGURED");
    const record = await createPasswordRecord("LocalCustomer123!", pepper);
    const seed = await ctx.runMutation(internal.seed.install, record);
    if (args.largeDataset) {
      for (const project of seed.projects) {
        for (let start = 0; start < 150; start += 25) await ctx.runMutation(internal.seed.largeBatch, { projectId: project.id, sessions: seed.sessions, start });
      }
    }
    return seed;
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
    if (![0, 25, 50, 75, 100, 125].includes(args.start) || args.sessions.length !== 3) throw new Error("INVALID_INPUT");
    const accesses = await Promise.all(args.sessions.map(token => requireActor(ctx, token)));
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
