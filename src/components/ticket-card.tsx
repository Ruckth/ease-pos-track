import type { ReactNode } from "react";
import { Images } from "lucide-react";
import type { Id } from "@convex/_generated/dataModel";
import { TicketUrgency } from "./ticket-urgency";
import { TicketTagList } from "@/components/ticket-tags";
import { Button } from "@/components/ui/button";
import { statusMeta } from "@/components/ticket-status";
import { formatTicketNumber } from "../../shared/ticket-numbers";
import { TicketRowAction } from "./ticket-row-action";
import type { TicketStatus } from "@/lib/types";
import type { TicketSummary } from "../../shared/ticket-contracts";
import { useI18n } from "@/lib/i18n";

export type OpenTicket = (id: Id<"tickets">, section?: "media") => void;

/** Sibling buttons keep opening, moving and inspecting attachments distinct
 * for pointer and keyboard users. Board lanes already show the status. */
export function TicketCard({ item, onSelect, onMove, onRestore, handle, inLane = false, showUnscored = false, selected = false, busy = false }: {
  item: TicketSummary;
  onSelect: OpenTicket;
  onMove?: (id: Id<"tickets">, status: TicketStatus) => void;
  onRestore?: (id: Id<"tickets">) => void;
  handle?: ReactNode;
  inLane?: boolean;
  showUnscored?: boolean;
  selected?: boolean;
  busy?: boolean;
}) {
  const { t } = useI18n();
  const reference = formatTicketNumber(item.ticketNumber, item.projectKey);
  const archived = item.lifecycle === "archived";

  return (
    <article className={`ticket-surface min-w-0 p-3 ${inLane ? "" : "sm:flex sm:flex-wrap sm:items-center sm:gap-x-3"} ${selected ? "border-primary bg-primary/5" : ""}`}>
      <div className={`flex min-w-0 items-start gap-2 ${inLane ? "" : "sm:flex-1 sm:basis-40"}`}>
        <div className="min-w-0 flex-1">
          <button type="button" data-ticket-id={item._id} className="min-h-11 w-full min-w-0 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`${t("viewTicket", { ticket: reference })} · ${item.title}`} aria-current={selected ? "true" : undefined}
            onClick={() => onSelect(item._id)}>
            <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              <span className="font-mono">{reference}</span>
              {!inLane && <span>{archived ? t("archive") : t(statusMeta(item.status).labelKey)}</span>}
            </span>
            <span className="mt-1 line-clamp-2 break-words [overflow-wrap:anywhere] text-sm font-semibold leading-5">{item.title}</span>
          </button>
          {item.tags?.length > 0 && <div className="mt-0.5"><TicketTagList tags={item.tags} plain /></div>}
        </div>
        {handle}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        {(showUnscored || item.urgencyScore !== undefined) && <TicketUrgency score={item.urgencyScore} plain />}
        {item.mediaCount > 0 && <Button type="button" variant="ghost" size="sm" className="min-h-11 min-w-11 px-2"
          aria-label={t("viewTicketMedia", { ticket: reference, count: item.mediaCount })} onClick={() => onSelect(item._id, "media")}>
          <Images aria-hidden />{item.mediaCount}
        </Button>}
        <TicketRowAction item={item} busy={busy} onMove={onMove} onRestore={onRestore} />
      </div>
    </article>
  );
}
