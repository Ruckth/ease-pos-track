import type { FeedbackStatus } from "@/lib/types";

/** The workflow, in order. A ticket only ever moves forward through it. */
export const STATUS_ORDER: FeedbackStatus[] = ["new", "acknowledged", "in_progress", "waiting", "done"];

export function formatTicketNumber(ticketNumber: number | undefined) {
  if (ticketNumber === undefined || !Number.isInteger(ticketNumber) || ticketNumber < 1) return "TKT—";
  return `TKT-${String(ticketNumber).padStart(4, "0")}`;
}

export function nextFeedbackStatus(status: FeedbackStatus): FeedbackStatus | null {
  const index = STATUS_ORDER.indexOf(status);
  if (index < 0 || index === STATUS_ORDER.length - 1) return null;
  return STATUS_ORDER[index + 1];
}

/**
 * How far a ticket has travelled through the workflow, for the card's progress
 * bar: the step it is on (1-based) and the share of the way to `done`.
 *
 * The percentage counts the moves that have happened, not the steps reached, so
 * a brand new ticket reads 0% and only `done` reads 100%. An unrecognised status
 * is treated as the first step, matching `statusMeta`.
 */
export function feedbackProgress(status: FeedbackStatus) {
  const total = STATUS_ORDER.length;
  const index = Math.max(STATUS_ORDER.indexOf(status), 0);
  return { step: index + 1, total, percent: Math.round((index / (total - 1)) * 100) };
}
