import type { FeedbackStatus } from "@/lib/types";

const STATUS_ORDER: FeedbackStatus[] = ["new", "in_progress", "waiting", "done"];

export function formatTicketNumber(ticketNumber: number | undefined) {
  if (ticketNumber === undefined || !Number.isInteger(ticketNumber) || ticketNumber < 1) return "TKT—";
  return `TKT-${String(ticketNumber).padStart(4, "0")}`;
}

export function nextFeedbackStatus(status: FeedbackStatus): FeedbackStatus | null {
  const index = STATUS_ORDER.indexOf(status);
  if (index < 0 || index === STATUS_ORDER.length - 1) return null;
  return STATUS_ORDER[index + 1];
}
