import { Button } from "@/components/ui/button";
import { staffTicketActions } from "@/lib/staff-ticket-queue";
import { useI18n } from "@/lib/i18n";
import type { TicketStatus } from "@/lib/types";
import { formatTicketNumber } from "../../shared/ticket-numbers";
import type { TicketSummary } from "../../shared/ticket-contracts";

export function TicketRowAction({ item, busy, onMove, onRestore }: {
  item: TicketSummary;
  busy?: boolean;
  onMove?: (id: TicketSummary["_id"], status: TicketStatus) => void;
  onRestore?: (id: TicketSummary["_id"]) => void;
}) {
  const { t } = useI18n();
  const archived = item.lifecycle === "archived";
  if (archived ? !onRestore : !onMove) return null;
  const action = staffTicketActions[item.status];
  const label = t(archived ? "restore" : action.label);
  const reference = formatTicketNumber(item.ticketNumber, item.projectKey);
  return <Button type="button" variant="outline" size="sm"
    className="ml-auto min-h-11 bg-transparent px-2.5 text-xs md:h-8 md:min-h-8" disabled={busy} aria-label={`${label} · ${reference}`}
    onClick={() => archived ? onRestore?.(item._id) : onMove?.(item._id, action.status)}>
    {label}
  </Button>;
}
