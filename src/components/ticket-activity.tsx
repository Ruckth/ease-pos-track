import { statusMeta } from "@/components/ticket-status";
import type { TicketEvent, TicketTag } from "@/lib/types";
import { useI18n } from "@/lib/i18n";

const actionKeys = { tags_changed: "actionTagsChanged", created: "actionCreated", media_attached: "actionMediaAttached", edited: "actionEdited", edit_undone: "actionEditUndone", urgency_changed: "actionUrgencyChanged", urgency_undone: "actionUrgencyUndone", status_changed: "actionStatusChanged", status_undone: "actionStatusUndone", archived: "archive", restored: "actionRestored", annotation_changed: "actionAnnotationChanged", purge_claimed: "actionPurgeClaimed" } as const;

export function TicketActivityEntry({ event, tags, tagsLoading }: { event: TicketEvent; tags?: TicketTag[]; tagsLoading: boolean }) {
  const { t } = useI18n();
  const tagNames = (ids: string[] = []) => ids.map(id => tags?.find(tag => tag._id === id)?.name ?? "?").join(", ") || t("noTicketTags");
  return <>
    <span className="font-medium text-foreground">{t(actionKeys[event.action])}</span>
    {event.before && event.after && event.before.status !== event.after.status
      ? ` · ${t(statusMeta(event.before.status).labelKey)} → ${t(statusMeta(event.after.status).labelKey)}` : ""}
    {event.before && event.after && event.before.urgencyScore !== event.after.urgencyScore
      ? ` · ${event.before.urgencyScore ?? "—"} → ${event.after.urgencyScore ?? "—"}` : ""}
    {event.action === "tags_changed" && (tagsLoading || tags) && (
      <span>{tagsLoading ? ` · ${t("syncing")}` : ` · ${tagNames(event.before?.tagIds)} → ${tagNames(event.after?.tagIds)}`}</span>
    )}
  </>;
}
