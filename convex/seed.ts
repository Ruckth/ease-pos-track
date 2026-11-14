import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { internalJobAction, internalJobMutation } from "./functions";
import { internal } from "./_generated/api";
import { createPasswordRecord } from "./password";
import { createTicketRecord } from "./domain/tickets";
import { requireUsableProject } from "./domain/projects";
import { actorFields, newTicketOwnership } from "./authz";

export function requireLocalFixtures() {
  let host: string | undefined;
  try { host = new URL(process.env.CONVEX_CLOUD_URL ?? "").hostname; } catch { /* Fail closed. */ }
  if (process.env.LOCAL_FIXTURES_ENABLED !== "true" || !["127.0.0.1", "localhost", "[::1]"].includes(host ?? "")) {
    throw new Error("LOCAL_FIXTURES_DISABLED");
  }
}

/** Opt-in internal fixture only. No reset and no provider I/O. Repeated runs reuse Projects, customers and Tickets; each run issues fresh random sessions. */
export const install = internalJobMutation({
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
      let ticket = await ctx.db.query("tickets").withIndex("by_external_request", q => q.eq("externalRequestId", requestId)).unique();
      if (!ticket) ticket = await createTicketRecord(ctx, {
        project: await requireUsableProject(ctx, actor, project._id),
        title: actor.role === "staff" ? "Printer needs review" : `Ticket from ${name}`,
        description: "Deterministic local text-only example", media: [],
        ownership: newTicketOwnership(actor), author: { sessionId, ...actorFields(actor) },
        externalRequestId: requestId, now,
      });
      tickets.push(ticket._id);
    }
    return { projects: projects.map(p => ({ id: p._id, key: p.key })), tickets, sessions };
  },
});

export const run = internalJobAction({
  args: {},
  handler: async (ctx): Promise<{ projects: { id: Id<"projects">; key: string }[]; tickets: Id<"tickets">[]; sessions: string[] }> => {
    requireLocalFixtures();
    const pepper = process.env.CUSTOMER_PASSWORD_PEPPER;
    if (!pepper) throw new Error("CUSTOMER_AUTH_NOT_CONFIGURED");
    const record = await createPasswordRecord("LocalCustomer123!", pepper);
    return await ctx.runMutation(internal.seed.install, record);
  },
});
