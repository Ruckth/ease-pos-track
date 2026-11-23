import type { TicketStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { statusMeta } from "./ticket-status";

/**
 * One status mark in a fixed 12 px footprint. Each state has its own shape, so
 * it reads without colour, in grayscale and in forced colours (all strokes and
 * fills use currentColor). The caller owns the translated status text: the mark
 * is decorative wherever the row or label already names the state.
 */
export function TicketStatusDot({ status, className }: { status: TicketStatus; className?: string }) {
  return <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false" data-status-dot={status}
    className={cn("size-3 shrink-0", statusMeta(status).text, className)}>
    {status === "done"
      ? <><circle cx="6" cy="6" r="5.25" fill="currentColor" /><path d="M3.6 6.2 5.2 7.8 8.4 4.4" fill="none" stroke="Canvas" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></>
      : <circle cx="6" cy="6" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.5" />}
    {status === "acknowledged" && <circle cx="6" cy="6" r="1.75" fill="currentColor" />}
    {status === "in_progress" && <path d="M6 1.25a4.75 4.75 0 0 0 0 9.5z" fill="currentColor" />}
    {status === "waiting" && <path d="M3.5 6h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />}
  </svg>;
}
