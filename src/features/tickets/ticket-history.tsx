import type { Id } from "@convex/_generated/dataModel";
import { AnnotationActivityEntry } from "@/components/annotation-activity";
import { TicketActivityEntry } from "@/components/ticket-activity";
import { useI18n } from "@/lib/i18n";
import { useTicketActivity, useTicketTags } from "./adapter";

/** Both streams are bounded and use the selected Ticket's read policy. */
export function TicketHistory({ token, id, staff }: { token: string; id: Id<"tickets">; staff: boolean }) {
  const { t, formatDate } = useI18n();
  const { ticketActivity, activity } = useTicketActivity(token, id);
  const includeTags = staff && Boolean(ticketActivity?.some(event => event.action === "tags_changed"));
  const tags = useTicketTags(token, includeTags);
  if (!ticketActivity || !activity) return <p role="status">{t("syncing")}</p>;

  const events = [
    ...ticketActivity.map(event => ({ kind: "ticket" as const, event })),
    ...activity.map(event => ({ kind: "annotation" as const, event })),
  ].sort((a, b) => b.event.createdAt - a.event.createdAt || a.event._id.localeCompare(b.event._id));

  if (!events.length) return <p>{t("detailNoHistory")}</p>;
  return <ol className="divide-y">
    {events.map(entry => <li key={entry.event._id} className="break-words py-2 text-sm">
      {entry.kind === "ticket"
        ? <TicketActivityEntry event={entry.event} tags={tags} tagsLoading={includeTags && tags === undefined} />
        : <AnnotationActivityEntry event={entry.event} />}
      <time dateTime={new Date(entry.event.createdAt).toISOString()} className="block text-xs leading-5 text-muted-foreground">{formatDate(entry.event.createdAt)}</time>
    </li>)}
  </ol>;
}
