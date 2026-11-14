import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { actorFields, canReadTicket, type Actor } from "../authz";
import { isMember } from "./projects";

export type RequestScope = {
  operation: "ticket.create" | "ticket.attach_media";
  requestId: string;
  actor: Actor<Id<"customers">>;
  projectId: Id<"projects">;
  digestVersion: number;
  inputDigest: string;
};

/** The indexed read also makes competing creates conflict and retry atomically. */
export async function replayTicketRequest(ctx: MutationCtx, input: RequestScope) {
  const receipt = await ctx.db.query("ticketRequests").withIndex("by_operation_request", q =>
    q.eq("operation", input.operation).eq("requestId", input.requestId)).unique();
  if (!receipt) return null;
  // Even global staff may not adopt a customer's request identity. No content
  // comparison or result is exposed until the durable scope is authorized.
  if (receipt.actorRole !== input.actor.role || receipt.actorCustomerId !== input.actor.customerId
    || (input.actor.role === "customer" && !await isMember(ctx, receipt.projectId, input.actor))) {
    throw new Error("TICKET_UNAVAILABLE");
  }
  const ticket = receipt.outcome === "committed" && receipt.ticketId ? await ctx.db.get(receipt.ticketId) : null;
  if (receipt.outcome === "committed" && (!ticket || ticket.lifecycle === "purging" || !canReadTicket(input.actor, ticket))) {
    throw new Error("TICKET_UNAVAILABLE");
  }
  if (receipt.projectId !== input.projectId || receipt.digestVersion !== input.digestVersion
    || receipt.inputDigest !== input.inputDigest) throw new Error("REQUEST_ID_CONFLICT");
  if (!ticket) throw new Error("TICKET_UNAVAILABLE");
  return { receipt, ticket };
}

export async function commitTicketRequest(ctx: MutationCtx, input: RequestScope, result: {
  ticketId: Id<"tickets">;
  version: number;
  eventId?: Id<"ticketEvents">;
}) {
  const { actor, ...identity } = input;
  await ctx.db.insert("ticketRequests", {
    ...identity, ...actorFields(actor), ...result, outcome: "committed", createdAt: Date.now(),
  });
}

/** P4 finalization calls this in the transaction removing the Ticket. Keep only
 * the duplicate identity, digest, durable scope and safe outcome references.
 * No raw Ticket/media/annotation input is ever stored in a receipt.
 */
export async function tombstoneTicketRequests(ctx: MutationCtx, ticketId: Id<"tickets">) {
  const receipts: Doc<"ticketRequests">[] = await ctx.db.query("ticketRequests")
    .withIndex("by_ticket", q => q.eq("ticketId", ticketId)).collect();
  for (const receipt of receipts) {
    if (receipt.outcome !== "unavailable") await ctx.db.patch(receipt._id, { outcome: "unavailable" });
  }
}
