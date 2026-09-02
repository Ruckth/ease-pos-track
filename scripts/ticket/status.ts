/**
 * User-facing workflow language and its one translation to stored Convex values.
 * Internal literals never cross this module into CLI parsing or JSON output.
 */
export const TICKET_STATUSES = [
  "new",
  "acknowledged",
  "in_progress",
  "waiting_for_customer",
  "resolved",
] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];
export type StoredTicketStatus = "new" | "acknowledged" | "in_progress" | "waiting" | "done";

const STORED_BY_PUBLIC: Record<TicketStatus, StoredTicketStatus> = {
  new: "new",
  acknowledged: "acknowledged",
  in_progress: "in_progress",
  waiting_for_customer: "waiting",
  resolved: "done",
};

const PUBLIC_BY_STORED: Record<StoredTicketStatus, TicketStatus> = {
  new: "new",
  acknowledged: "acknowledged",
  in_progress: "in_progress",
  waiting: "waiting_for_customer",
  done: "resolved",
};

export function isTicketStatus(value: string): value is TicketStatus {
  return (TICKET_STATUSES as readonly string[]).includes(value);
}

export function toStoredTicketStatus(status: TicketStatus): StoredTicketStatus {
  return STORED_BY_PUBLIC[status];
}

export function toPublicTicketStatus(status: StoredTicketStatus): TicketStatus {
  return PUBLIC_BY_STORED[status];
}
