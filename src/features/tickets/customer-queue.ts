import type { TicketSummary } from "../../../shared/ticket-contracts";
import { formatTicketNumber } from "../../../shared/ticket-numbers";

export type CustomerQueueFilter = "all" | "active" | TicketSummary["status"];

/** These counts describe the loaded page window, never the whole Project. */
export function customerQueueCounts(rows: TicketSummary[]) {
  return { all: rows.length, active: rows.filter(row => row.status !== "done").length,
    waiting: rows.filter(row => row.status === "waiting").length, done: rows.filter(row => row.status === "done").length };
}

export function customerQueue(rows: TicketSummary[], filter: string, query: string) {
  const text = query.trim().toLocaleLowerCase();
  return rows.filter(row => (filter === "all" || filter === "active" && row.status !== "done" || row.status === filter)
    && (!text || `${formatTicketNumber(row.ticketNumber, row.projectKey)} ${row.title} ${row.excerpt}`.toLocaleLowerCase().includes(text)))
    .sort((a, b) => Number(b.status === "waiting") - Number(a.status === "waiting") || b.createdAt - a.createdAt || String(a._id).localeCompare(String(b._id)));
}
