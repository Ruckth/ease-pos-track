import { activeProjects, publicProject, projectByKey } from "./domain/projects";
import { actorQuery, internalJobMutation, ownerMutation, staffQuery } from "./functions";
/**
 * Projects group Tickets. Each Project has its own Ticket numbering, and
 * customers only see the Projects they joined by invitation. The Owner
 * administers Projects and membership.
 */

import { activeDeploymentProject, hasLegacyAccess, requireLegacyAccess, requirePilotAdmission } from "./pilot_access";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { normalizeProjectKey, validateProjectName } from "../shared/ticket-numbers";

/** Projects the signed-in actor can use, by name. */
export const listProjects = actorQuery({
  name: "projects:listProjects",
  args: {},
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
      const allowed = await hasLegacyAccess(ctx) ? null : (await requirePilotAdmission(ctx)).projectIds;
      const rows = await Promise.all(memberships.filter(row => !allowed || allowed.includes(row.projectId))
        .map(row => ctx.db.get(row.projectId)));
      projects = rows.filter((project): project is Doc<"projects"> => project !== null && project.archivedAt === undefined);
    }
    return projects.sort((a, b) => a.name.localeCompare(b.name)).map(publicProject);
  },
});

export const createProject = ownerMutation({
  name: "projects:createProject",
  args: { name: v.string(), key: v.string() },
  handler: async (ctx, args) => {
    // The pilot Project set is fixed by its reviewed release manifest.
    await requireLegacyAccess(ctx);
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
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    // A named pilot manages membership only inside its Project allowlist.
    if (!await activeDeploymentProject(ctx, args.projectId)) throw new Error("PROJECT_NOT_FOUND");
    const rows = await ctx.db
      .query("projectMembers")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    const members = await Promise.all(rows.map(async (row) => {
      const customer = await ctx.db.get(row.customerId);
      return customer ? { customerId: customer._id, username: customer.username, displayName: customer.displayName, status: customer.status } : null;
    }));
    return members
      .filter((member) => member !== null)
      .sort((a, b) => a.username.localeCompare(b.username));
  },
});

export const removeProjectMember = ownerMutation({
  name: "projects:removeProjectMember",
  args: { projectId: v.id("projects"), customerId: v.id("customers") },
  handler: async (ctx, args) => {
    if (!await activeDeploymentProject(ctx, args.projectId)) throw new Error("PROJECT_NOT_FOUND");
    const row = await ctx.db
      .query("projectMembers")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId).eq("customerId", args.customerId))
      .unique();
    if (row) await ctx.db.delete(row._id);
  },
});

/** All operator archive/restore writes advance the inbox visibility interval. */
export const setArchived = internalJobMutation({
  name: "projects:setArchived",
  args: { projectId: v.id("projects"), archived: v.boolean() },
  handler: async (ctx, { projectId, archived }) => {
    const project = await ctx.db.get(projectId);
    if (!project) throw new Error("PROJECT_NOT_FOUND");
    if ((project.archivedAt !== undefined) === archived) return;
    const now = Date.now();
    await ctx.db.patch(projectId, {
      archivedAt: archived ? now : undefined, updatedAt: now,
      inboxVisibilityVersion: (project.inboxVisibilityVersion ?? 0) + 1,
    });
  },
});
