import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { Id } from "@convex/_generated/dataModel";
import { AnnotationActivityEntry } from "@/components/annotation-activity";
import { TicketActivityEntry } from "@/components/ticket-activity";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { ticketHistoryCopy } from "@/lib/ticket-history-copy";
import { useTicketActivity, useTicketTags } from "./adapter";

export function TicketHistory({ id, staff }: { id: Id<"tickets">; staff: boolean }) {
  const { t } = useI18n();
  const [loaded, setLoaded] = useState(false);
  return <details className="group/history" onToggle={event => {
    if (event.currentTarget.open) setLoaded(true);
  }}>
    <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded text-sm font-medium marker:content-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
      {t("detailHistory")}
      <ChevronDown aria-hidden="true" className="ml-auto size-4 text-muted-foreground transition-transform group-open/history:rotate-180" />
    </summary>
    {loaded && <div className="pb-3"><HistoryEntries id={id} staff={staff} /></div>}
  </details>;
}

function HistoryEntries({ id, staff }: { id: Id<"tickets">; staff: boolean }) {
  const { t, language } = useI18n();
  const copy = ticketHistoryCopy(language);
  const { ticketActivity, annotationActivity, mediaEnabled } = useTicketActivity(id);
  const includeTags = staff && ticketActivity.results.some(event => event.action === "tags_changed");
  const tags = useTicketTags(includeTags);
  const { day, time, full } = useMemo(() => {
    const locale = language === "th" ? "th-TH-u-ca-buddhist" : "en-US";
    return {
      day: new Intl.DateTimeFormat(locale, { dateStyle: "long" }),
      time: new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", second: "2-digit" }),
      full: new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "long" }),
    };
  }, [language]);
  if (ticketActivity.status === "LoadingFirstPage" || (mediaEnabled && annotationActivity.status === "LoadingFirstPage")) {
    return <p role="status">{t("syncing")}</p>;
  }

  const ticketEventsById = new Map(ticketActivity.results.map(event => [event._id, event]));
  const paired = new Set(annotationActivity.results.flatMap(event => {
    const generic = event.ticketEventId && ticketEventsById.get(event.ticketEventId);
    return generic && generic.action === "annotation_changed" && generic.ticketId === event.ticketId
      && generic.createdAt === event.createdAt ? [generic._id] : [];
  }));
  const events = [
    ...ticketActivity.results.filter(event => !paired.has(event._id)).map(event => ({ kind: "ticket" as const, event })),
    ...annotationActivity.results.map(event => ({ kind: "annotation" as const, event })),
  ].sort((a, b) => b.event.createdAt - a.event.createdAt || b.event._creationTime - a.event._creationTime || a.event._id.localeCompare(b.event._id));

  return <div className="space-y-3">
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span>{copy.recentTicket}</span>
      {mediaEnabled && <span>{copy.recentNotes}</span>}
    </div>
    {events.length ? <ol className="divide-y">
      {events.map((entry, index) => {
        const timestamp = entry.event.createdAt;
        const date = day.format(timestamp);
        return <li key={entry.event._id} className="break-words py-2 text-sm">
          {(index === 0 || day.format(events[index - 1].event.createdAt) !== date) &&
            <h3 className="mb-2 font-semibold">{date}</h3>}
          {staff && <span className="mr-2 text-xs text-muted-foreground">{copy[entry.event.actorRole ?? "unknown"]}</span>}
          {entry.kind === "ticket"
            ? <TicketActivityEntry event={entry.event} tags={tags} tagsLoading={includeTags && tags === undefined} />
            : <AnnotationActivityEntry event={entry.event} />}
          <time dateTime={new Date(timestamp).toISOString()} title={full.format(timestamp)}
            className="block text-xs leading-5 text-muted-foreground">
            <span className="sr-only">{full.format(timestamp)}</span>
            <span aria-hidden="true">{time.format(timestamp)}</span>
          </time>
        </li>;
      })}
    </ol> : <p>{t("detailNoHistory")}</p>}
    <div className="flex flex-wrap gap-2">
      {(ticketActivity.status === "CanLoadMore" || ticketActivity.status === "LoadingMore") &&
        <Button variant="outline" disabled={ticketActivity.isLoading} onClick={() => ticketActivity.loadMore(30)}>
          {ticketActivity.isLoading ? t("syncing") : copy.olderTicket}
        </Button>}
      {mediaEnabled && (annotationActivity.status === "CanLoadMore" || annotationActivity.status === "LoadingMore") &&
        <Button variant="outline" disabled={annotationActivity.isLoading} onClick={() => annotationActivity.loadMore(30)}>
          {annotationActivity.isLoading ? t("syncing") : copy.olderNotes}
        </Button>}
    </div>
  </div>;
}
