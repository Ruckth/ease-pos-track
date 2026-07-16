import { History } from "lucide-react";
import type { AnnotationEvent } from "@/lib/types";
import { useI18n } from "@/lib/i18n";

function shortText(text: string | undefined) {
  if (!text) return "";
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

function actionKey(action: AnnotationEvent["action"]) {
  return ({ created: "actionCreated", updated: "actionUpdated", deleted: "actionDeleted", restored: "actionRestored", update_undone: "actionUpdateUndone" } as const)[action];
}

export function AnnotationActivityList({ events }: { events: AnnotationEvent[] }) {
  const { t, formatDate } = useI18n();
  if (events.length === 0) return null;

  return (
    <details className="rounded-md border bg-muted/20 px-3 py-2">
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 text-sm font-medium uppercase tracking-wide text-muted-foreground">
        <History className="size-4" />
        {t("commentActivity", { count: events.length })}
      </summary>
      <ol className="mt-3 space-y-2 border-t pt-3">
        {events.map((event) => {
          const annotation = event.after ?? event.before;
          const moved = event.action === "updated" && event.before && event.after
            && (event.before.x !== event.after.x || event.before.y !== event.after.y || event.before.time !== event.after.time);
          const textChanged = event.action === "updated" && event.before?.text !== event.after?.text;
          return (
            <li key={event._id} className="text-sm leading-5 text-muted-foreground">
              <span className="font-medium text-foreground">{t("comment", { label: annotation?.label ?? "?" })}</span>
              {` ${t(actionKey(event.action))}`}
              {moved ? ` · ${t("positionChanged")}` : ""}
              {textChanged ? ` · “${shortText(event.before?.text)}” → “${shortText(event.after?.text)}”` : ""}
              <span className="ml-1">{formatDate(event.createdAt)}</span>
            </li>
          );
        })}
      </ol>
    </details>
  );
}
