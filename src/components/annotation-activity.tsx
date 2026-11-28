import { useId, useState } from "react";
import { formatClock, type AnnotationEvent } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { mediaUxCopy, summarizeAnnotationUpdate } from "@/lib/media-ux-copy";

function shortText(text: string | undefined) {
  if (!text) return "";
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

function actionKey(action: AnnotationEvent["action"]) {
  return (
    {
      created: "actionCreated",
      updated: "actionUpdated",
      deleted: "actionDeleted",
      restored: "actionRestored",
      update_undone: "actionUpdateUndone",
    } as const
  )[action];
}

export function AnnotationActivityEntry({ event }: { event: AnnotationEvent }) {
  const { t, language } = useI18n();
  const copy = mediaUxCopy(language);
  const [expanded, setExpanded] = useState(false);
  const comparisonId = useId();
  const annotation = event.after ?? event.before;
  const summary = summarizeAnnotationUpdate(event.action, event.before, event.after);

  return (
    <>
      <span className="font-medium text-foreground">
        {t("comment", { label: annotation?.label ?? "?" })} {t(actionKey(event.action))}
      </span>
      {summary.timeChanged &&
      summary.previousTime !== undefined &&
      summary.nextTime !== undefined
        ? ` · ${copy.timeChanged(formatClock(summary.previousTime), formatClock(summary.nextTime))}`
        : ""}
      {summary.positionChanged ? ` · ${t("positionChanged")}` : ""}
      {summary.textChanged && !expanded
        ? ` · “${shortText(event.before?.text)}” → “${shortText(event.after?.text)}”`
        : ""}
      {summary.textTruncated ? (
        <span className="ml-1.5 inline-block">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={comparisonId}
            onClick={() => setExpanded((open) => !open)}
            className="inline-flex min-h-11 items-center rounded px-1.5 text-xs font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {expanded ? copy.hideFullText : copy.showFullText}
          </button>
        </span>
      ) : null}
      {summary.textTruncated ? (
        <dl
          id={comparisonId}
          hidden={!expanded}
          className="mt-2 space-y-1.5 rounded-md border bg-muted/40 p-2.5 text-xs leading-5"
        >
          <div>
            <dt className="font-medium text-muted-foreground">{copy.beforeLabel}</dt>
            <dd className="whitespace-pre-wrap break-words text-foreground">
              {event.before?.text ?? ""}
            </dd>
          </div>
          <div>
            <dt className="font-medium text-muted-foreground">{copy.afterLabel}</dt>
            <dd className="whitespace-pre-wrap break-words text-foreground">
              {event.after?.text ?? ""}
            </dd>
          </div>
        </dl>
      ) : null}
    </>
  );
}
