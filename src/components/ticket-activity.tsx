import { useState } from "react";
import { statusMeta } from "@/components/ticket-status";
import type { TicketEvent, TicketTag } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { ticketHistoryCopy } from "@/lib/ticket-history-copy";

const actionKeys = { tags_changed: "actionTagsChanged", created: "actionCreated", media_attached: "actionMediaAttached", edited: "actionEdited", edit_undone: "actionEditUndone", urgency_changed: "actionUrgencyChanged", urgency_undone: "actionUrgencyUndone", status_changed: "actionStatusChanged", status_undone: "actionStatusUndone", restored: "actionRestored", annotation_changed: "actionAnnotationChanged", purge_claimed: "actionPurgeClaimed" } as const;

function SnapshotText({ value }: { value: string }) {
  const { language } = useI18n();
  const copy = ticketHistoryCopy(language);
  const [expanded, setExpanded] = useState(false);
  const characters = Array.from(value);
  const excerptLength = 280;
  const long = characters.length > excerptLength;
  return <>
    <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">
      {long && !expanded ? `${characters.slice(0, excerptLength).join("")}…` : value || copy.emptyValue}
    </div>
    {long && <button type="button" aria-expanded={expanded} className="min-h-11 underline underline-offset-2" onClick={() => setExpanded(!expanded)}>
      {expanded ? copy.showLess : copy.showFull}
    </button>}
  </>;
}

export function TicketActivityEntry({ event, tags, tagsLoading }: { event: TicketEvent; tags?: TicketTag[]; tagsLoading: boolean }) {
  const { t, language } = useI18n();
  const copy = ticketHistoryCopy(language);
  const tagNames = (ids: string[] = []) => ids.map(id => tags?.find(tag => tag._id === id)?.name ?? "?").join(", ") || t("noTicketTags");
  const { before, after } = event;
  const textChanges = before && after && (event.action === "edited" || event.action === "edit_undone")
    ? (["title", "description"] as const).filter(field => before[field] !== after[field]) : [];
  return <>
    <span className="font-medium text-foreground">{event.action === "archived" ? copy.archived : t(actionKeys[event.action])}</span>
    {before && after && before.status !== after.status &&
      <span>{` · ${copy.status}: ${t(statusMeta(before.status).labelKey)} → ${t(statusMeta(after.status).labelKey)}`}</span>}
    {before && after && before.urgencyScore !== after.urgencyScore &&
      <span>{` · ${copy.urgency}: ${before.urgencyScore ?? copy.unscored} → ${after.urgencyScore ?? copy.unscored}`}</span>}
    {event.action === "tags_changed" && (tagsLoading || tags) &&
      <span>{` · ${copy.tags}: ${tagsLoading ? t("syncing") : `${tagNames(before?.tagIds)} → ${tagNames(after?.tagIds)}`}`}</span>}
    {before && after && textChanges.length > 0 && <details className="mt-1">
      <summary className="min-h-8 cursor-pointer">{copy.textChanges}</summary>
      {textChanges.map(field => <div key={field} className="space-y-1 border-l pl-3">
        <h4 className="font-medium">{copy[field]}</h4>
        <dl className="space-y-2 text-sm">
          <div><dt className="font-medium">{copy.before}</dt><dd><SnapshotText value={before[field]} /></dd></div>
          <div><dt className="font-medium">{copy.after}</dt><dd><SnapshotText value={after[field]} /></dd></div>
        </dl>
      </div>)}
    </details>}
  </>;
}
