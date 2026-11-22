import type { ReactNode } from "react";
import { TicketCreatedDate } from "./ticket-created-date";
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
      {inLane && <div className="mb-1 flex min-w-0 items-start justify-between gap-1.5">
        {item.tags?.length ? <TicketTagList tags={item.tags} plain /> : <span className="font-mono text-xs text-muted-foreground">{reference}</span>}
        {handle}
      </div>}
      <div className={`flex min-w-0 items-start gap-2 ${inLane ? "" : "sm:flex-1 sm:basis-40"}`}>
        <div className="min-w-0 flex-1">
          <button type="button" data-ticket-id={item._id} className="min-h-11 w-full min-w-0 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`${t("viewTicket", { ticket: reference })} · ${item.title}`} aria-current={selected ? "true" : undefined}
            onClick={() => onSelect(item._id)}>
            {!inLane && <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              <span className="font-mono">{reference}</span>
              <span>{archived ? t("archive") : t(statusMeta(item.status).labelKey)}</span>
            </span>}
            <span className="line-clamp-2 break-words [overflow-wrap:anywhere] text-[0.95rem] font-semibold leading-snug">{item.title}</span>
          </button>
          {!inLane && item.tags?.length > 0 && <div className="mt-0.5"><TicketTagList tags={item.tags} plain /></div>}
        </div>
        {!inLane && handle}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        {(showUnscored || item.urgencyScore !== undefined) && <TicketUrgency score={item.urgencyScore} plain />}
        {inLane && <TicketCreatedDate timestamp={item.createdAt} />}
      </div>
      <div className={inLane ? "mt-3 flex flex-wrap items-center gap-1 border-t border-border/50 pt-2" : "mt-1 flex flex-wrap items-center gap-1"}>
        {inLane && item.tags?.length > 0 && <span className="font-mono text-[0.7rem] text-muted-foreground">{reference}</span>}
        {item.mediaCount > 0 && <Button type="button" variant="ghost" size="sm" className="min-h-11 min-w-11 px-2"
          aria-label={t("viewTicketMedia", { ticket: reference, count: item.mediaCount })} onClick={() => onSelect(item._id, "media")}>
          <Images aria-hidden />{item.mediaCount}
        </Button>}
        <TicketRowAction item={item} busy={busy} onMove={onMove} onRestore={onRestore} />
      </div>
    </article>
  );
}
