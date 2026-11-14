import { activeProjects, publicProject, projectByKey, requireUsableProject } from "./domain/projects";
import { actorQuery, staffMutation, staffQuery } from "./functions";
/**
 * Projects group Tickets. Each Project has its own Ticket numbering, and
 * customers only see the Projects staff have added them to.
 */

import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { validateCustomerEmail } from "./customer_validation";
import { normalizeProjectKey, validateProjectName } from "../shared/ticket-numbers";

/** Projects the signed-in actor can use, by name. */
export const listProjects = actorQuery({
  name: "projects:listProjects",
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const { actor } = ctx;
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

export const createProject = staffMutation({
  name: "projects:createProject",
  args: { token: v.string(), name: v.string(), key: v.string() },
  handler: async (ctx, args) => {
    const name = validateProjectName(args.name);
    const key = normalizeProjectKey(args.key);
    if (await projectByKey(ctx, key)) throw new Error("PROJECT_KEY_TAKEN");
    const now = Date.now();
    const id = await ctx.db.insert("projects", { name, key, createdAt: now, updatedAt: now });
    return { _id: id, name, key };
  },
});

export const listProjectMembers = staffQuery({
  name: "projects:listProjectMembers",
  args: { token: v.string(), projectId: v.id("projects") },
  handler: async (ctx, args) => {
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
export const addProjectMember = staffMutation({
  name: "projects:addProjectMember",
  args: { token: v.string(), projectId: v.id("projects"), email: v.string() },
  handler: async (ctx, args) => {
    const { actor } = ctx;
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

export const removeProjectMember = staffMutation({
  name: "projects:removeProjectMember",
  args: { token: v.string(), projectId: v.id("projects"), customerId: v.id("customers") },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("projectMembers")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId).eq("customerId", args.customerId))
      .unique();
    if (row) await ctx.db.delete(row._id);
  },
});
