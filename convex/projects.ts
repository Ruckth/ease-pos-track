/**
 * Projects group Tickets. Each Project has its own Ticket numbering, and
 * customers only see the Projects staff have added them to.
 */

import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { assertStaffActor, canUseProject, type Actor } from "./authz";
import { validateCustomerEmail } from "./customer_validation";
import { requireActor } from "./session_auth";
import { projectCounterName } from "./tickets";
import { LEGACY_PROJECT_KEY, normalizeProjectKey, validateProjectName } from "./ticket_numbers";

type Ctx = QueryCtx | MutationCtx;

/** The counter every Ticket shared before Projects existed. */
const LEGACY_COUNTER_NAME = "feedback";

function publicProject(project: Doc<"projects">) {
  return { _id: project._id, name: project.name, key: project.key };
}

async function isMember(ctx: Ctx, projectId: Id<"projects">, actor: Actor<Id<"customers">>) {
  if (actor.role !== "customer") return false;
  const row = await ctx.db
    .query("projectMembers")
    .withIndex("by_project", (q) => q.eq("projectId", projectId).eq("customerId", actor.customerId))
    .unique();
  return row !== null;
}

/**
 * Loads a Project the actor may use. A Project the actor cannot use is reported
 * as missing, so customers cannot probe for other Projects.
 */
export async function requireUsableProject(ctx: Ctx, actor: Actor<Id<"customers">>, projectId: Id<"projects">) {
  const project = await ctx.db.get(projectId);
  if (!project || !canUseProject(actor, project, await isMember(ctx, project._id, actor))) {
    throw new Error("PROJECT_NOT_FOUND");
  }
  return project;
}

export async function projectByKey(ctx: Ctx, key: string) {
  return await ctx.db
    .query("projects")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
}

async function activeProjects(ctx: Ctx) {
  const projects = await ctx.db.query("projects").collect();
  return projects.filter((project) => project.archivedAt === undefined);
}

/**
 * The Project a staff tool writes to: the one named, or the only active Project
 * when none is named. With several Projects the caller must choose.
 */
export async function resolveStaffProject(ctx: Ctx, key: string | undefined) {
  if (key !== undefined) {
    const project = await projectByKey(ctx, normalizeProjectKey(key));
    if (!project || project.archivedAt !== undefined) throw new Error("PROJECT_NOT_FOUND");
    return project;
  }
  const projects = await activeProjects(ctx);
  if (projects.length !== 1) throw new Error(projects.length === 0 ? "PROJECT_NOT_FOUND" : "PROJECT_REQUIRED");
  return projects[0];
}

/** Projects the signed-in actor can use, by name. */
export const listProjects = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const { actor } = await requireActor(ctx, args.token);
    let projects: Doc<"projects">[];
    if (actor.role === "staff") {
      projects = await activeProjects(ctx);
    } else {
      const memberships = await ctx.db
        .query("projectMembers")
        .withIndex("by_customer", (q) => q.eq("customerId", actor.customerId))
        .collect();
      const rows = await Promise.all(memberships.map((row) => ctx.db.get(row.projectId)));
      projects = rows.filter((project): project is Doc<"projects"> => project !== null && project.archivedAt === undefined);
    }
    return projects.sort((a, b) => a.name.localeCompare(b.name)).map(publicProject);
  },
});

export const createProject = mutation({
  args: { token: v.string(), name: v.string(), key: v.string() },
  handler: async (ctx, args) => {
    const { actor } = await requireActor(ctx, args.token);
    assertStaffActor(actor);
    const name = validateProjectName(args.name);
    const key = normalizeProjectKey(args.key);
    if (await projectByKey(ctx, key)) throw new Error("PROJECT_KEY_TAKEN");
    const now = Date.now();
    const id = await ctx.db.insert("projects", { name, key, createdAt: now, updatedAt: now });
    return { _id: id, name, key };
  },
});

export const listProjectMembers = query({
  args: { token: v.string(), projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const { actor } = await requireActor(ctx, args.token);
    assertStaffActor(actor);
    const rows = await ctx.db
      .query("projectMembers")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    const members = await Promise.all(rows.map(async (row) => {
      const customer = await ctx.db.get(row.customerId);
      return customer ? { customerId: customer._id, email: customer.email } : null;
    }));
    return members
      .filter((member) => member !== null)
      .sort((a, b) => a.email.localeCompare(b.email));
  },
});

/** Adds a customer, by the email they signed up with. Adding twice is a no-op. */
export const addProjectMember = mutation({
  args: { token: v.string(), projectId: v.id("projects"), email: v.string() },
  handler: async (ctx, args) => {
    const { actor } = await requireActor(ctx, args.token);
    assertStaffActor(actor);
    const project = await requireUsableProject(ctx, actor, args.projectId);
    const email = validateCustomerEmail(args.email);
    const customer = await ctx.db
      .query("customers")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    if (!customer) throw new Error("CUSTOMER_NOT_FOUND");
    const existing = await ctx.db
      .query("projectMembers")
      .withIndex("by_project", (q) => q.eq("projectId", project._id).eq("customerId", customer._id))
      .unique();
    if (!existing) {
      await ctx.db.insert("projectMembers", { projectId: project._id, customerId: customer._id, createdAt: Date.now() });
    }
    return { customerId: customer._id, email: customer.email };
  },
});

export const removeProjectMember = mutation({
  args: { token: v.string(), projectId: v.id("projects"), customerId: v.id("customers") },
  handler: async (ctx, args) => {
    const { actor } = await requireActor(ctx, args.token);
    assertStaffActor(actor);
    const row = await ctx.db
      .query("projectMembers")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId).eq("customerId", args.customerId))
      .unique();
    if (row) await ctx.db.delete(row._id);
  },
});

/**
 * One-time move of Tickets created before Projects existed into a `TKT`
 * Project, so their references (`TKT-0007`) do not change. Existing customers
 * become members so they keep seeing their Tickets. Safe to run again.
 *
 *   pnpm exec convex run projects:migrateLegacyTickets '{"name":"Ease POS"}' [--prod]
 */
export const migrateLegacyTickets = internalMutation({
  args: { name: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const legacy = await ctx.db
      .query("feedback")
      .withIndex("by_project_ticket", (q) => q.eq("projectKey", undefined))
      .collect();
    const legacyCounter = await ctx.db
      .query("ticketCounters")
      .withIndex("by_name", (q) => q.eq("name", LEGACY_COUNTER_NAME))
      .unique();
    if (legacy.length === 0 && !legacyCounter) return { project: null, moved: 0, members: 0 };

    const now = Date.now();
    const existing = await projectByKey(ctx, LEGACY_PROJECT_KEY);
    const projectId = existing?._id ?? await ctx.db.insert("projects", {
      name: validateProjectName(args.name ?? "Ease POS"),
      key: LEGACY_PROJECT_KEY,
      createdAt: now,
      updatedAt: now,
    });

    for (const ticket of legacy) {
      await ctx.db.patch(ticket._id, { projectId, projectKey: LEGACY_PROJECT_KEY });
    }

    // Continue numbering after the highest legacy number, never reusing one.
    const highest = legacy.reduce((max, ticket) => Math.max(max, ticket.ticketNumber ?? 0), 0);
    const counterName = projectCounterName(projectId);
    const counter = await ctx.db
      .query("ticketCounters")
      .withIndex("by_name", (q) => q.eq("name", counterName))
      .unique();
    const nextNumber = Math.max(highest + 1, legacyCounter?.nextNumber ?? 1, counter?.nextNumber ?? 1);
    if (counter) await ctx.db.patch(counter._id, { nextNumber, updatedAt: now });
    else await ctx.db.insert("ticketCounters", { name: counterName, nextNumber, updatedAt: now });
    if (legacyCounter) await ctx.db.delete(legacyCounter._id);

    let members = 0;
    for (const customer of await ctx.db.query("customers").collect()) {
      const row = await ctx.db
        .query("projectMembers")
        .withIndex("by_project", (q) => q.eq("projectId", projectId).eq("customerId", customer._id))
        .unique();
      if (row) continue;
      await ctx.db.insert("projectMembers", { projectId, customerId: customer._id, createdAt: now });
      members += 1;
    }

    return { project: LEGACY_PROJECT_KEY, moved: legacy.length, members, nextNumber };
  },
});
