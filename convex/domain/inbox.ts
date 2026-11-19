import { activeDeploymentProject, epochStamp, namedIdentityEpoch } from "../pilot_access";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

type Reader = Pick<QueryCtx, "db">;

export async function inboxMembership(ctx: Reader, projectId: Id<"projects">, customerId: Id<"customers">) {
  const project = await activeDeploymentProject(ctx, projectId);
  if (!project) return null;
  return ctx.db.query("projectMembers")
    .withIndex("by_project", q => q.eq("projectId", projectId).eq("customerId", customerId)).unique();
}

/**
 * Every inbox row carries the pilot epoch it was committed under (none outside a
 * pilot). A restored snapshot's rows keep their older epoch, so a fresh epoch
 * hides them permanently even when restored visibility counters line up again.
 */
export const inboxEpoch = (ctx: Reader) => namedIdentityEpoch(ctx);

export async function recordCustomerUpdate(ctx: MutationCtx, ticket: Doc<"tickets">, eventId: Id<"ticketEvents">,
  status: Doc<"tickets">["status"], visibilityVersion: number, restored: boolean) {
  if (!ticket.ownerCustomerId) return;
  const member = await inboxMembership(ctx, ticket.projectId, ticket.ownerCustomerId);
  if (!member || member.statusInboxEnabled === false) return;
  const project = await activeDeploymentProject(ctx, member.projectId);
  await ctx.db.insert("customerInbox", {
    memberId: member._id, customerId: member.customerId, projectId: member.projectId, ticketId: ticket._id,
    projectVisibilityVersion: project?.inboxVisibilityVersion ?? 0, eventId, status, visibilityVersion, restored,
    preferenceGeneration: member.statusInboxGeneration ?? 0, ...epochStamp(await inboxEpoch(ctx)),
  });
}

/** Each change advances the generation, so re-enabling never revives items from before a withdrawal. */
export async function setStatusInboxPreference(ctx: MutationCtx, member: Doc<"projectMembers">, enabled: boolean) {
  if ((member.statusInboxEnabled !== false) === enabled) return;
  await ctx.db.patch(member._id, { statusInboxEnabled: enabled, statusInboxGeneration: (member.statusInboxGeneration ?? 0) + 1 });
}

export const inboxRetentionMs = 30 * 24 * 60 * 60 * 1000;

/** Loads the member's current interval once; list and mark-read both apply the returned check. */
export async function customerInboxReader(ctx: Reader, member: Doc<"projectMembers">) {
  const [project, epoch] = await Promise.all([activeDeploymentProject(ctx, member.projectId), inboxEpoch(ctx)]);
  return async (item: Doc<"customerInbox">) => {
    if (!project || item.memberId !== member._id || item.customerId !== member.customerId || item.projectId !== member.projectId
      || item.pilotEpoch !== epoch || item._creationTime < Date.now() - inboxRetentionMs
      || member.statusInboxEnabled === false || (item.preferenceGeneration ?? 0) !== (member.statusInboxGeneration ?? 0)
      || (project.inboxVisibilityVersion ?? 0) !== (item.projectVisibilityVersion ?? 0)) return null;
    const ticket = await ctx.db.get(item.ticketId);
    if (!ticket || ticket.lifecycle !== "active" || ticket.ownerCustomerId !== member.customerId ||
      ticket.projectId !== member.projectId || (ticket.inboxVisibilityVersion ?? 0) !== item.visibilityVersion) return null;
    return ticket;
  };
}

export async function visibleInboxTicket(ctx: Reader, item: Doc<"customerInbox">, member: Doc<"projectMembers">) {
  return (await customerInboxReader(ctx, member))(item);
}
