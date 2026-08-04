import { CheckCircle2, Clock3, ImagePlus, RefreshCw } from "lucide-react";
import type { FeedbackStatus } from "@/lib/types";

/**
 * Presentation for the four fixed workflow states, shared by the staff board,
 * the ticket dialog, and the customer portal.
 */
export const statuses: Array<{
  value: FeedbackStatus;
  labelKey: "new" | "inProgress" | "waiting" | "done";
  tone: string;
  icon: typeof Clock3;
}> = [
  { value: "new", labelKey: "new", tone: "bg-sky-50 text-sky-800 border-sky-200", icon: ImagePlus },
  { value: "in_progress", labelKey: "inProgress", tone: "bg-amber-50 text-amber-800 border-amber-200", icon: RefreshCw },
  { value: "waiting", labelKey: "waiting", tone: "bg-violet-50 text-violet-800 border-violet-200", icon: Clock3 },
  { value: "done", labelKey: "done", tone: "bg-emerald-50 text-emerald-800 border-emerald-200", icon: CheckCircle2 },
];

export function statusMeta(status: FeedbackStatus) {
  return statuses.find((item) => item.value === status) ?? statuses[0];
}
