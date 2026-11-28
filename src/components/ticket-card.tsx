import type { ReactNode } from "react";
import { TicketCreatedDate } from "./ticket-created-date";
import { Images, StickyNote } from "lucide-react";
import type { Id } from "@convex/_generated/dataModel";
import { TicketCustomerReply } from "./ticket-customer-reply";
import { TicketUrgency } from "./ticket-urgency";
import { TicketTagList } from "@/components/ticket-tags";
import { statusMeta } from "@/components/ticket-status";
import { formatTicketNumber } from "../../shared/ticket-numbers";
import { TicketRowAction } from "./ticket-row-action";
import type { TicketStatus } from "@/lib/types";
import type { TicketSummary } from "../../shared/ticket-contracts";
import { useI18n } from "@/lib/i18n";
import { useStaffCopy } from "@/lib/staff-copy";
import { formatRelativeTime } from "@/lib/relative-time";
import { TicketPurgeEligibility } from "./ticket-purge-eligibility";
import { cn } from "@/lib/utils";

export type OpenTicket = (id: Id<"tickets">, section?: "media") => void;

/** One detail-opening control; moving stays a separate sibling group. Board lanes already show the status. */
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
  const { t, language, formatDate } = useI18n();
  const s = useStaffCopy();
  const reference = formatTicketNumber(item.ticketNumber, item.projectKey);
  const archived = item.lifecycle === "archived";
  const files = <>
    {item.mediaCount > 0 && <span className="inline-flex items-center gap-1 px-1 text-xs tabular-nums text-muted-foreground">
      <Images aria-hidden className="size-3.5" /><span aria-hidden>{item.mediaCount}</span><span className="sr-only">{s.files(item.mediaCount)}</span>
    </span>}
    {item.annotationCount > 0 && <span className="inline-flex items-center gap-1 px-1 text-xs tabular-nums text-muted-foreground">
      <StickyNote aria-hidden className="size-3.5" />{s.notes(item.annotationCount)}
    </span>}
    <TicketRowAction item={item} busy={busy} onMove={onMove} onRestore={onRestore} />
  </>;

  return (
    <article className={cn("ticket-surface min-w-0 p-3", selected && "ticket-surface-selected",
      // Queue and table rows on phones are flat and divided by a hairline; Board cards keep their frame.
      !inLane && "sm:flex sm:flex-wrap sm:items-center sm:gap-x-3 max-sm:rounded-none max-sm:border-x-0 max-sm:border-t-0 max-sm:border-b-border/70 max-sm:bg-none max-sm:px-1 max-sm:py-2 max-sm:shadow-none",
      !inLane && (selected ? "max-sm:bg-primary/10" : "max-sm:bg-transparent"))}>
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
          {item.excerpt && <p className="mt-0.5 line-clamp-2 break-words text-sm leading-snug text-muted-foreground [overflow-wrap:anywhere]">{item.excerpt}</p>}
          {!inLane && item.tags?.length > 0 && <div className="mt-0.5"><TicketTagList tags={item.tags} plain /></div>}
        </div>
        {!inLane && handle}
      </div>
      {archived && <div className="mt-1"><TicketPurgeEligibility archivedAt={item.archivedAt} blocked={"purgeBlocked" in item && item.purgeBlocked === true} /></div>}
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        {(showUnscored || item.urgencyScore !== undefined) && <TicketUrgency score={item.urgencyScore} plain />}
        {inLane && <TicketCreatedDate timestamp={item.createdAt} />}
        <time className="text-xs tabular-nums text-muted-foreground" dateTime={new Date(item.updatedAt).toISOString()}
          title={`${t("updatedOn", { date: formatDate(item.updatedAt) })} · ${t("createdAt", { date: formatDate(item.createdAt) })}`}>
          {s.updated(formatRelativeTime(item.updatedAt, Date.now(), language))}
        </time>
        <TicketCustomerReply item={item} />
        {/* Queue rows keep files, notes and the next move on the same line as the time. */}
        {!inLane && files}
      </div>
      {inLane && <div className="mt-3 flex flex-wrap items-center gap-1 border-t border-border/50 pt-2">
        {item.tags?.length > 0 && <span className="font-mono text-[0.7rem] text-muted-foreground">{reference}</span>}
        {files}
      </div>}
    </article>
  );
}
