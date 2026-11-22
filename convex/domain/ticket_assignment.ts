import { notifyAssignee } from "./staff_inbox";
import { v } from "convex/values";
import { requireCurrentVersion } from "../../shared/ticket-state";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { mutationOperation, queryOperation } from "./operation";
import { findUsableProject, requireUsableProject } from "./projects";
import { requireRoutingStaff, routingStaffById, routingStaffForSession, type RoutingDb } from "./routing_identity";
import { currentRoutingPolicy, eligibleStaff, rosterFor, type Policy } from "./routing_policy";

export async function activeRoutingTicket(ctx: RoutingDb, ticketId: Id<"tickets">) {
  const ticket = await ctx.db.get(ticketId);
  if (!ticket || ticket.lifecycle !== "active") throw new Error("TICKET_UNAVAILABLE");
  return ticket;
}

type WriteAssignment = {
  area?: string; assignee?: string; held: boolean; staffId: string;
};

/** Shared by direct human edits and human acceptance of a routing suggestion. */
export async function assignManually(ctx: MutationCtx, ticket: Doc<"tickets">, policy: Policy, expectedVersion: number, input: WriteAssignment, now: number) {
  const version = requireCurrentVersion(ticket, expectedVersion) + 1;
  const roster = rosterFor(policy, input.area);
  const retainingAssignee = input.area === ticket.assignment?.area && input.assignee === ticket.assigneeStaffId;
  if (!retainingAssignee) {
    if (input.area !== undefined && !roster) throw new Error("UNKNOWN_ROUTING_CODE");
    if (input.assignee !== undefined && ((roster && !roster.includes(input.assignee))
      || !await eligibleStaff(ctx, ticket.projectId, input.assignee, now))) throw new Error("INELIGIBLE_ASSIGNEE");
  }
  // Releasing a hold alone resumes eligibility. A deliberate area/assignee
  // change stays authoritative, including when the staff member unassigns.
  const manualOverride = !retainingAssignee || ticket.assignment?.manualOverride === true;
  const after = { ...input, manualOverride, source: "manual" as const, version };
  const eventId = await ctx.db.insert("ticketAssignmentEvents", {
    projectId: ticket.projectId, ticketId: ticket._id, before: ticket.assignment, after,
    staffId: input.staffId, source: after.source, version, createdAt: now,
  });
  // A changed assignee begins a new interval; items from an earlier one (A to B to A) stay hidden.
  const assigneeChanged = input.assignee !== ticket.assigneeStaffId;
  await ctx.db.patch(ticket._id, {
    assignment: after, assigneeStaffId: input.assignee, version, updatedAt: now,
    ...(assigneeChanged ? { assigneeEventId: input.assignee === undefined ? undefined : eventId } : {}),
  });
  if (input.assignee && assigneeChanged) await notifyAssignee(ctx, ticket, input.assignee, eventId);
  return { version, eventId };
}

export const assign = mutationOperation({
  args: {
    ticketId: v.id("tickets"), expectedVersion: v.number(),
    area: v.optional(v.string()), assignee: v.optional(v.string()), held: v.boolean(),
  },
  handler: async (ctx, { ticketId, expectedVersion, area, assignee, held }) => {
    const staff = await requireRoutingStaff(ctx, ctx.session);
    const ticket = await activeRoutingTicket(ctx, ticketId);
    await requireUsableProject(ctx, ctx.actor, ticket.projectId);
    const policy = await currentRoutingPolicy(ctx, ticket.projectId);
    return await assignManually(ctx, ticket, policy, expectedVersion, { area, assignee, held, staffId: staff.staffId }, Date.now());
  },
});

export const getAssignment = queryOperation({
  args: { ticketId: v.id("tickets") },
  handler: async (ctx, { ticketId }) => {
    const staff = await routingStaffForSession(ctx, ctx.session);
    if (!staff?.active) return null;
    const ticket = await ctx.db.get(ticketId);
    if (!ticket || ticket.lifecycle === "purging" || !await findUsableProject(ctx, ctx.actor, ticket.projectId)) return null;
    const [events, person, policy] = await Promise.all([
      ctx.db.query("ticketAssignmentEvents").withIndex("by_ticket", q => q.eq("ticketId", ticketId)).order("desc").take(20),
      ticket.assigneeStaffId ? routingStaffById(ctx, ticket.assigneeStaffId) : null,
      currentRoutingPolicy(ctx, ticket.projectId),
    ]);
    return {
      version: ticket.version, value: ticket.assignment, classification: ticket.routingClassification,
      assigneeName: person?.name,
      needsReview: ticket.lifecycle === "active" && ticket.assigneeStaffId !== undefined && (
        !!ticket.assignment?.area && !(rosterFor(policy, ticket.assignment.area) ?? []).includes(ticket.assigneeStaffId)
        || !await eligibleStaff(ctx, ticket.projectId, ticket.assigneeStaffId, Date.now())
      ),
      events: await Promise.all(events.map(async event => ({
        id: event._id, date: event.createdAt, source: event.source, area: event.after.area,
        held: event.after.held, reviewer: (await routingStaffById(ctx, event.staffId))?.name,
        assignee: event.after.assignee ? (await routingStaffById(ctx, event.after.assignee))?.name : undefined,
      }))),
    };
  },
});
