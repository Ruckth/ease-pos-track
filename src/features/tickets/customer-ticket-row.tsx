import { TicketStatusDot } from "@/components/ticket-status-dot";
import { statusMeta } from "@/components/ticket-status";
import { useI18n, type Language } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { Id } from "@convex/_generated/dataModel";
import { useId } from "react";
import { Check, ChevronRight, Images, MapPin, MessageCircleQuestion } from "lucide-react";
import type { TicketSummary } from "../../../shared/ticket-contracts";
import { formatTicketNumber } from "../../../shared/ticket-numbers";

const DAY = 86_400_000;
const formatters: Partial<Record<string, Intl.DateTimeFormat>> = {};
function format(language: Language, kind: "time" | "day" | "year", timestamp: number) {
  const options: Intl.DateTimeFormatOptions = kind === "time" ? { hour: "2-digit", minute: "2-digit" }
    : kind === "day" ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" };
  return (formatters[`${language}-${kind}`] ??= new Intl.DateTimeFormat(language === "th" ? "th-TH" : "en-US", options)).format(timestamp);
}

/** Today shows the time, yesterday a word, this year the day, older the full date. */
function activityLabel(language: Language, timestamp: number, yesterday: string) {
  const now = Date.now();
  const day = (value: number) => { const date = new Date(value); date.setHours(0, 0, 0, 0); return date.getTime(); };
  const days = Math.round((day(now) - day(timestamp)) / DAY);
  if (days <= 0) return format(language, "time", timestamp);
  if (days === 1) return yesterday;
  return format(language, new Date(timestamp).getFullYear() === new Date(now).getFullYear() ? "day" : "year", timestamp);
}

/**
 * One customer Ticket in the private feed: title, one line of the latest
 * message, then who owes the next step and when it last moved. Below 640 px the
 * written status becomes one shaped mark beside the title; the translated
 * status stays in the accessible name and the open detail.
 */
export function CustomerTicketRow({ item, selected, onSelect }: {
  item: TicketSummary;
  selected: boolean;
  onSelect: (id: Id<"tickets">) => void;
}) {
  const { t, language, formatDate } = useI18n();
  const excerptId = useId();
  const replyStateId = `${excerptId}-reply-state`;
  const activityId = `${excerptId}-activity`;
  const meta = statusMeta(item.status);
  const StatusIcon = meta.icon;
  const label = formatTicketNumber(item.ticketNumber, item.projectKey);
  const status = item.status === "waiting" ? t("customerQueueWaiting") : t(meta.labelKey);
  const waiting = item.status === "waiting";
  const reply = item.latestReply;
  const excerpt = reply ? t("feedLatestReply", {
    name: t(reply.role === "staff" ? "threadTeam" : "threadYou"),
    reply: reply.excerpt || t(reply.hasLink ? "feedLinkReply" : "feedAttachmentReply"),
  }) : item.excerpt;
  const updatedAt = Math.max(item.updatedAt, reply?.at ?? 0);
  const updatedLater = updatedAt - item.createdAt >= 60_000;
  const activity = t(updatedLater ? "updatedOn" : "createdAt", { date: formatDate(updatedAt) });
  const needsReply = waiting && reply?.awaitingCustomer === true;
  const youReplied = waiting && !needsReply && reply?.role === "customer";
  const description = [excerpt ? excerptId : "", needsReply || youReplied ? replyStateId : "", activityId].filter(Boolean).join(" ");

  return <button
    type="button"
    data-ticket-id={item._id}
    className={cn(
      "ticket-surface group flex w-full flex-col gap-1 px-3.5 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-4",
      needsReply && !selected && "border-l-[3px] border-l-violet-600 dark:border-l-violet-400",
      selected && "ticket-surface-selected",
    )}
    aria-label={[t("viewTicket", { ticket: label }), item.title, status].join(", ")}
    aria-describedby={description}
    aria-current={selected ? "true" : undefined}
    onClick={() => onSelect(item._id)}
  >
    <span className="flex w-full min-w-0 items-start gap-2.5">
      <TicketStatusDot status={item.status} className="mt-[0.4rem] sm:hidden" />
      <span className="min-w-0 flex-1 break-words text-base font-semibold leading-snug tracking-[-0.01em] text-foreground [overflow-wrap:anywhere]">{item.title}</span>
      <span data-status-label className={cn("ticket-chip mt-px hidden shrink-0 text-xs font-medium sm:inline-flex", meta.text)}>
        <StatusIcon className="size-3.5 shrink-0" aria-hidden />
        {status}
      </span>
    </span>
    {excerpt && <span id={excerptId} data-ticket-excerpt className="line-clamp-1 pl-[1.375rem] text-sm leading-snug text-muted-foreground [overflow-wrap:anywhere] sm:pl-0">{excerpt}</span>}
    <span className="mt-0.5 flex w-full flex-wrap items-center gap-x-3 gap-y-1 pl-[1.375rem] text-xs text-muted-foreground sm:pl-0">
      {needsReply ? <span id={replyStateId} className="inline-flex items-center gap-1 rounded-full bg-violet-700 px-2 py-0.5 font-semibold text-white dark:bg-violet-300 dark:text-violet-950">
        <MessageCircleQuestion className="size-3.5 shrink-0" aria-hidden />{t("feedNeedsReply")}
      </span> : youReplied ? <span id={replyStateId} className="inline-flex items-center gap-1 font-medium text-foreground">
        <Check className="size-3.5 shrink-0 text-emerald-700 dark:text-emerald-300" aria-hidden />{t("customerQueueYouReplied")}
      </span> : null}
      <span className="font-mono">{label}</span>
      {item.openedByStaff ? <span className="max-w-[12rem] truncate">{t("threadTeam")}</span> : null}
      {item.mediaCount ? (
        <span className="inline-flex items-center gap-1">
          <Images className="size-3.5 shrink-0" aria-hidden="true" />
          {t("reviewMedia", { count: item.mediaCount })}
        </span>
      ) : null}
      {item.annotationCount ? (
        <span className="inline-flex items-center gap-1">
          <MapPin className="size-3.5 shrink-0" aria-hidden="true" />
          {t("reviewPins", { count: item.annotationCount })}
        </span>
      ) : null}
      <span className="ml-auto inline-flex items-center gap-1">
        <time data-ticket-activity className="whitespace-nowrap tabular-nums" dateTime={new Date(updatedAt).toISOString()} title={activity}>
          <span id={activityId} className="sr-only">{activity}</span>
          <span aria-hidden="true">{activityLabel(language, updatedAt, t("customerQueueYesterday"))}</span>
        </time>
        <ChevronRight className="hidden size-3.5 shrink-0 text-primary transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none sm:block" aria-hidden="true" />
      </span>
    </span>
  </button>;
}
