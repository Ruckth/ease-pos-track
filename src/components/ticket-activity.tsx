import { History } from "lucide-react";
import { statusMeta } from "@/components/ticket-status";
import type { TicketEvent, TicketTag } from "@/lib/types";
import { useI18n } from "@/lib/i18n";

const actionKeys = { tags_changed: "actionTagsChanged", created: "actionCreated", media_attached: "actionMediaAttached", edited: "actionEdited", edit_undone: "actionEditUndone", urgency_changed: "actionUrgencyChanged", urgency_undone: "actionUrgencyUndone", status_changed: "actionStatusChanged", status_undone: "actionStatusUndone", archived: "archive", restored: "actionRestored", annotation_changed: "actionAnnotationChanged", purge_claimed: "actionPurgeClaimed" } as const;

export function TicketActivityList({ events, tags, tagsLoading = false }: { events: TicketEvent[]; tags?: TicketTag[]; tagsLoading?: boolean }) {
  const { t, formatDate } = useI18n();
  const tagNames = (ids: string[] = []) => ids.map(id => tags?.find(tag => tag._id === id)?.name ?? "?").join(", ") || t("noTicketTags");
  if (events.length === 0) return null;
  return (
    <details className="rounded-md border bg-muted/20 px-3 py-2">
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 text-sm font-medium uppercase tracking-wide text-muted-foreground">
        <History className="size-4" /> {t("ticketActivity", { count: events.length })}
      </summary>
      <ol className="mt-3 space-y-2 border-t pt-3">
        {events.map((event) => (
          <li key={event._id} className="text-sm leading-5 text-muted-foreground">
            <span className="font-medium text-foreground">{t(actionKeys[event.action])}</span>
            {event.before?.status !== event.after?.status && event.before && event.after
              ? ` · ${t(statusMeta(event.before.status).labelKey)} → ${t(statusMeta(event.after.status).labelKey)}`
              : ""}
            {event.before?.urgencyScore !== event.after?.urgencyScore && event.before && event.after
              ? ` · ${event.before.urgencyScore ?? "—"} → ${event.after.urgencyScore ?? "—"}`
              : ""}
            {event.action === "tags_changed" && (tagsLoading || tags) ? <span className="break-words">{tagsLoading ? ` · ${t("syncing")}` : ` · ${tagNames(event.before?.tagIds)} → ${tagNames(event.after?.tagIds)}`}</span> : null}
            <span className="ml-1">{formatDate(event.createdAt)}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}
