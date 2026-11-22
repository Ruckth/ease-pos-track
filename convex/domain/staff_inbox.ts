import { activeDeploymentProject, epochStamp } from "../pilot_access";
import { ROUTING_LIMITS } from "../../shared/ticket-routing";
import { inboxEpoch, inboxRetentionMs } from "./inbox";
import { routingStaffById } from "./routing_identity";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

type Reader = Pick<QueryCtx, "db">;
type Category = Doc<"staffInbox">["category"];
type Preference = Doc<"staffInboxPreferences"> | null;

export function staffPreferences(ctx: Reader, projectId: Id<"projects">, staffId: string) {
  return ctx.db.query("staffInboxPreferences").withIndex("by_project_staff",
    q => q.eq("projectId", projectId).eq("staffId", staffId)).unique();
}

const generationField = { intake: "intakeGeneration", assignment: "assignmentGeneration" } as const;
const generation = (preference: Preference, category: Category) => preference?.[generationField[category]] ?? 0;
export const categoryEnabled = (preference: Preference, category: Category) => preference?.[category] !== false;

/**
 * Preference rows are never deleted. Each change advances that category's
 * generation, so items from before a withdrawal stay hidden after re-opting in.
 */
export async function setStaffPreference(ctx: MutationCtx, projectId: Id<"projects">, staffId: string, category: Category, enabled: boolean) {
  const preference = await staffPreferences(ctx, projectId, staffId);
  if (categoryEnabled(preference, category) === enabled) return;
  const next = {
    intake: categoryEnabled(preference, "intake"), assignment: categoryEnabled(preference, "assignment"), [category]: enabled,
    [generationField[category]]: generation(preference, category) + 1,
  };
  if (preference) await ctx.db.patch(preference._id, next);
  else await ctx.db.insert("staffInboxPreferences", { projectId, staffId, ...next });
}

// Called only by the mutation committing the corresponding Ticket change. A replay
// of an existing create or assignment receipt never reaches this insertion.
export async function notifyAssignee(ctx: MutationCtx, ticket: Doc<"tickets">, staffId: string, eventId: Id<"ticketAssignmentEvents">) {
  const preference = await staffPreferences(ctx, ticket.projectId, staffId);
  if (!categoryEnabled(preference, "assignment")) return;
  const project = await activeDeploymentProject(ctx, ticket.projectId);
  if (!project) return;
  await ctx.db.insert("staffInbox", {
    projectVisibilityVersion: project.inboxVisibilityVersion ?? 0, projectId: ticket.projectId, ticketId: ticket._id, category: "assignment", staffId, assignmentEventId: eventId,
    visibilityVersion: ticket.inboxVisibilityVersion ?? 0, preferenceGeneration: generation(preference, "assignment"),
    ...epochStamp(await inboxEpoch(ctx)),
  });
}

export async function notifyIntake(ctx: MutationCtx, ticket: Doc<"tickets">) {
  const intake = await ctx.db.query("projectIntakeStaff").withIndex("by_project_staff",
    q => q.eq("projectId", ticket.projectId)).collect();
  if (!intake.length) return;
  const project = await activeDeploymentProject(ctx, ticket.projectId);
  if (!project) return;
  const epoch = epochStamp(await inboxEpoch(ctx));
  for (const member of intake) {
    if (!(await routingStaffById(ctx, member.staffId))?.active) continue;
    const preference = await staffPreferences(ctx, ticket.projectId, member.staffId);
    if (!categoryEnabled(preference, "intake")) continue;
    await ctx.db.insert("staffInbox", {
      projectVisibilityVersion: project.inboxVisibilityVersion ?? 0, projectId: ticket.projectId, ticketId: ticket._id, category: "intake",
      staffId: member.staffId, intakeMembership: member._id,
      visibilityVersion: ticket.inboxVisibilityVersion ?? 0, preferenceGeneration: generation(preference, "intake"), ...epoch,
    });
  }
}

/**
 * Loads the recipient's current Project, preferences and epoch once. An item
 * displays, counts and marks read only inside the interval it was created in:
 * same epoch, Project and Ticket visibility, preference generation (with the
 * category still enabled), intake membership row, and assignment interval.
 */
export async function staffInboxReader(ctx: Reader, projectId: Id<"projects">, staffId: string) {
  const [project, preference, epoch] = await Promise.all([
    activeDeploymentProject(ctx, projectId), staffPreferences(ctx, projectId, staffId), inboxEpoch(ctx),
  ]);
  return async (item: Doc<"staffInbox">) => {
    if (!project || item.staffId !== staffId || item.projectId !== projectId || item.pilotEpoch !== epoch
      || item._creationTime < Date.now() - inboxRetentionMs
      || !categoryEnabled(preference, item.category) || (item.preferenceGeneration ?? 0) !== generation(preference, item.category)
      || (item.projectVisibilityVersion ?? 0) !== (project.inboxVisibilityVersion ?? 0)) return null;
    if (item.category === "intake") {
      const member = item.intakeMembership && await ctx.db.get(item.intakeMembership);
      if (!member || member.staffId !== staffId || member.projectId !== item.projectId) return null;
    }
    const ticket = await ctx.db.get(item.ticketId);
    if (!ticket || ticket.projectId !== item.projectId || ticket.lifecycle !== "active" ||
      (ticket.inboxVisibilityVersion ?? 0) !== item.visibilityVersion) return null;
    // A later reassignment back to this person starts a new interval with its own item.
    if (item.category === "assignment" && (ticket.assigneeStaffId !== staffId
      || item.assignmentEventId === undefined || ticket.assigneeEventId !== item.assignmentEventId)) return null;
    return ticket;
  };
}

export async function visibleStaffInboxTicket(ctx: Reader, item: Doc<"staffInbox">, staffId: string) {
  return (await staffInboxReader(ctx, item.projectId, staffId))(item);
}

// The Owner-facing operation validates both IDs against the active staff roster.
// Preserve rows that stay designated so their current visibility interval continues.
export async function replaceIntakeTeam(ctx: MutationCtx, projectId: Id<"projects">, staffIds: string[]) {
  const wanted = new Set(staffIds);
  if (wanted.size !== staffIds.length || wanted.size > ROUTING_LIMITS.staff) throw new Error("INVALID_INTAKE_TEAM");
  const current = await ctx.db.query("projectIntakeStaff").withIndex("by_project_staff", q => q.eq("projectId", projectId)).collect();
  for (const member of current) {
    if (!wanted.delete(member.staffId)) await ctx.db.delete(member._id);
  }
  for (const staffId of Array.from(wanted)) await ctx.db.insert("projectIntakeStaff", { projectId, staffId });
}
