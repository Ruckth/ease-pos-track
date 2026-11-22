import { CheckCircle2, ClipboardCheck, Clock3, ImagePlus, RefreshCw } from "lucide-react";
import type { TicketStatus } from "@/lib/types";

/**
 * Presentation for the five fixed workflow states, shared by the staff board,
 * the ticket dialog, and the customer portal.
 */
export const statuses: Array<{
  value: TicketStatus;
  labelKey: "new" | "acknowledged" | "inProgress" | "waiting" | "done";
  tone: string;
  icon: typeof Clock3;
}> = [
  { value: "new", labelKey: "new", tone: "bg-sky-50 text-sky-800 border-sky-200 dark:bg-sky-950 dark:text-sky-200 dark:border-sky-700", icon: ImagePlus },
  { value: "acknowledged", labelKey: "acknowledged", tone: "bg-indigo-50 text-indigo-800 border-indigo-200 dark:bg-indigo-950 dark:text-indigo-200 dark:border-indigo-700", icon: ClipboardCheck },
  { value: "in_progress", labelKey: "inProgress", tone: "bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:border-amber-700", icon: RefreshCw },
  { value: "waiting", labelKey: "waiting", tone: "bg-violet-50 text-violet-800 border-violet-200 dark:bg-violet-950 dark:text-violet-200 dark:border-violet-700", icon: Clock3 },
  { value: "done", labelKey: "done", tone: "bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:border-emerald-700", icon: CheckCircle2 },
];

export function statusMeta(status: TicketStatus) {
  return statuses.find((item) => item.value === status) ?? statuses[0];
}
