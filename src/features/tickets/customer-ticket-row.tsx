import { TicketCreatedDate } from "@/components/ticket-created-date";
import { TicketStatusDot } from "@/components/ticket-status-dot";
import { statusMeta } from "@/components/ticket-status";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { Id } from "@convex/_generated/dataModel";
import { useId } from "react";
import { ChevronRight, Images, MapPin, UserRound } from "lucide-react";
import type { TicketSummary } from "../../../shared/ticket-contracts";
import { formatTicketNumber } from "../../../shared/ticket-numbers";

function authorInitial(name?: string) {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  const first = Array.from(trimmed)[0];
  return first ? first.toLocaleUpperCase() : null;
}

/**
 * One customer Ticket in the private feed. Below 640 px the row shows a single
 * shaped status mark beside the title and a compact excerpt;
 * the translated status stays in the accessible name and the open detail.
 */
export function CustomerTicketRow({ item, selected, onSelect, authorName }: {
  item: TicketSummary;
  selected: boolean;
  onSelect: (id: Id<"tickets">) => void;
  authorName?: string;
}) {
  const { t, formatDate } = useI18n();
  const excerptId = useId();
  const meta = statusMeta(item.status);
  const StatusIcon = meta.icon;
  const label = formatTicketNumber(item.ticketNumber, item.projectKey);
  const status = item.status === "waiting" ? t("customerQueueWaiting") : t(meta.labelKey);
  const waiting = item.status === "waiting";
  const done = item.status === "done";
  const author = item.openedByStaff ? t("threadTeam") : authorName?.trim() || undefined;
  const initial = authorInitial(author);
  const reply = item.latestReply;
  const excerpt = reply ? t("feedLatestReply", {
    name: t(reply.role === "staff" ? "threadTeam" : "threadYou"),
    reply: reply.excerpt || t(reply.hasLink ? "feedLinkReply" : "feedAttachmentReply"),
  }) : item.excerpt;
  const updatedAt = Math.max(item.updatedAt, reply?.at ?? 0);
  const updatedLater = updatedAt - item.createdAt >= 60_000;
  const awaitingCustomer = waiting && reply?.awaitingCustomer;

  return <button
    type="button"
    data-ticket-id={item._id}
    className={cn(
      "ticket-surface group flex min-h-16 w-full flex-col gap-1.5 px-3.5 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:grid sm:min-h-20 sm:grid-cols-[2.25rem_minmax(0,1fr)] sm:items-start sm:gap-x-3 sm:gap-y-0 sm:px-4 sm:py-3.5",
      waiting && !selected && "border-l-[3px] border-l-violet-600 dark:border-l-violet-400",
      selected && "ticket-surface-selected",
    )}
    aria-label={[t("viewTicket", { ticket: label }), item.title, status].join(", ")}
    aria-describedby={excerpt ? excerptId : undefined}
    aria-current={selected ? "true" : undefined}
    onClick={() => onSelect(item._id)}
  >
    <span
      aria-hidden="true"
      className={cn(
        "mt-0.5 hidden size-9 shrink-0 place-items-center rounded-full text-xs font-semibold ring-1 sm:grid",
        waiting
          ? "bg-violet-500/15 text-violet-800 ring-violet-500/30 dark:bg-violet-400/20 dark:text-violet-200 dark:ring-violet-400/35"
          : done
            ? "bg-emerald-500/12 text-emerald-800 ring-emerald-500/25 dark:bg-emerald-400/15 dark:text-emerald-200 dark:ring-emerald-400/30"
            : "bg-primary/10 text-primary ring-primary/20 dark:bg-primary/15 dark:ring-primary/30",
      )}
    >
      {initial ?? <UserRound className="size-4" />}
    </span>
    <span className="flex min-w-0 flex-1 flex-col gap-1.5">
      <span className="hidden flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground sm:flex">
        {author ? <span className="max-w-[14rem] truncate font-semibold text-foreground">{author}</span> : null}
        <span className="font-mono">{label}</span>
        <span
          data-status-label
          className={cn(
            "ticket-chip ml-auto font-medium",
            meta.text,
            waiting && "ring-1 ring-violet-500/30 dark:ring-violet-400/35",
          )}
        >
          <StatusIcon className="size-3.5 shrink-0" aria-hidden />
          {status}
        </span>
      </span>
      <span className="flex min-w-0 items-start gap-2.5">
        <TicketStatusDot status={item.status} className="mt-[0.4rem] sm:hidden" />
        <span className="min-w-0 break-words text-base font-semibold leading-snug tracking-[-0.01em] text-foreground [overflow-wrap:anywhere]">{item.title}</span>
      </span>
      {awaitingCustomer && <span className="pl-[1.375rem] text-xs font-semibold text-primary sm:pl-0">{t("feedNeedsReply")}</span>}
      {excerpt && <span id={excerptId} data-ticket-excerpt className="line-clamp-1 pl-[1.375rem] text-sm leading-snug text-muted-foreground [overflow-wrap:anywhere] sm:line-clamp-2 sm:pl-0">{excerpt}</span>}
      <span className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 pl-[1.375rem] text-xs text-muted-foreground sm:mt-1 sm:pl-0">
        <span className="font-mono sm:hidden">{label}</span>
        {author ? <span className="max-w-[9rem] truncate sm:hidden">{author}</span> : null}
        <TicketCreatedDate timestamp={item.createdAt} />
        {updatedLater ? (
          <time
            className="hidden items-center tabular-nums text-muted-foreground sm:inline-flex"
            dateTime={new Date(updatedAt).toISOString()}
          >
            {t("updatedOn", { date: formatDate(updatedAt) })}
          </time>
        ) : null}
        {item.mediaCount ? (
          <span className="inline-flex items-center gap-1 font-medium text-foreground">
            <Images className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
            {t("reviewMedia", { count: item.mediaCount })}
          </span>
        ) : null}
        {item.annotationCount ? (
          <span className="inline-flex items-center gap-1 font-medium text-foreground">
            <MapPin className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
            {t("reviewPins", { count: item.annotationCount })}
          </span>
        ) : null}
        <span className="ml-auto hidden items-center gap-0.5 font-medium text-primary transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none sm:inline-flex" aria-hidden="true">
          {t("openTicket")}
          <ChevronRight className="size-3.5 shrink-0" />
        </span>
      </span>
    </span>
  </button>;
}
