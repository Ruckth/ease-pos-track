import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { canUseProject, type Actor } from "../authz";
import { normalizeProjectKey } from "../../shared/ticket-numbers";

type Ctx = QueryCtx | MutationCtx;

export function publicProject(project: Doc<"projects">) {
  return { _id: project._id, name: project.name, key: project.key };
}

export async function isMember(ctx: Ctx, projectId: Id<"projects">, actor: Actor<Id<"customers">>) {
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

export async function activeProjects(ctx: Ctx) {
  const projects = await ctx.db.query("projects").collect();
  return projects.filter((project) => project.archivedAt === undefined);
}

/**
 * Resolve an active Project identity. Callers must check actor access before
 * comparing a request receipt.
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

