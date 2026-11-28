import { ShieldAlert } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { purgeEligibility } from "@/lib/kanban-board";
import { useStaffCopy } from "@/lib/staff-copy";

/** Archive eligibility, never a deletion deadline: restore stays available until a purge job claims the Ticket. */
export function TicketPurgeEligibility({ archivedAt, blocked, now = Date.now() }: { archivedAt?: number; blocked?: boolean; now?: number }) {
  const { formatDate } = useI18n();
  const s = useStaffCopy();
  if (blocked) return <p className="flex items-start gap-1 text-xs font-medium text-amber-800 dark:text-amber-300">
    <ShieldAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />{s.purgeBlocked}
  </p>;
  const eligibility = purgeEligibility(archivedAt, now);
  return <p className="text-xs text-muted-foreground">
    {eligibility.state === "unknown" ? s.purgeUnknown : eligibility.state === "eligible" ? s.purgeNow : s.purgeFrom(formatDate(eligibility.from))}
  </p>;
}
