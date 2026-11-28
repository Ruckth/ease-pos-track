import { ticketCustomerQueueGroup } from "../../../shared/ticket-state";
import type { TicketSummary } from "../../../shared/ticket-contracts";

export type CustomerQueueFilter = "all" | "active" | "waiting" | "done";

export function customerSearchScope(filter: CustomerQueueFilter) {
  return {
    status: filter === "waiting" || filter === "done" ? filter : undefined,
    activeOnly: filter === "active" || undefined,
  };
}

/** These counts describe the loaded page window, never the whole Project. */
export function customerQueueCounts(rows: TicketSummary[]) {
  return { all: rows.length, active: rows.filter(row => ticketCustomerQueueGroup(row.status) === "active").length,
    waiting: rows.filter(row => row.status === "waiting").length, done: rows.filter(row => row.status === "done").length };
}

function needsReply(row: TicketSummary) {
  return row.status === "waiting" && row.latestReply?.awaitingCustomer === true;
}

export function customerQueue(rows: TicketSummary[], filter: CustomerQueueFilter) {
  const scoped = rows.filter(row => filter === "all" || ticketCustomerQueueGroup(row.status) === filter);
  return filter === "active" ? scoped.sort((a, b) => b.ticketNumber - a.ticketNumber) : scoped.sort((a, b) => Number(needsReply(b)) - Number(needsReply(a))
      || Number(b.status === "waiting") - Number(a.status === "waiting")
      || (b.latestReply?.at ?? b.createdAt) - (a.latestReply?.at ?? a.createdAt)
      || String(a._id).localeCompare(String(b._id)));
}
