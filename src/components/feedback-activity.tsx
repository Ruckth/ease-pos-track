import { History } from "lucide-react";
import type { FeedbackEvent } from "@/lib/types";
import { useI18n } from "@/lib/i18n";

const actionKeys = { created: "actionCreated", edited: "actionEdited", edit_undone: "actionEditUndone", status_changed: "actionStatusChanged", status_undone: "actionStatusUndone", archived: "archive", restored: "actionRestored" } as const;

export function FeedbackActivityList({ events }: { events: FeedbackEvent[] }) {
  const { t, formatDate } = useI18n();
  if (events.length === 0) return null;
  return (
    <details className="rounded-md border bg-muted/20 px-3 py-2">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <History className="size-3.5" /> {t("feedbackActivity", { count: events.length })}
      </summary>
      <ol className="mt-3 space-y-2 border-t pt-3">
        {events.map((event) => (
          <li key={event._id} className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{t(actionKeys[event.action])}</span>
            {event.before?.status !== event.after?.status && event.before && event.after
              ? ` · ${t(({ new: "new", in_progress: "inProgress", waiting: "waiting", done: "done" } as const)[event.before.status])} → ${t(({ new: "new", in_progress: "inProgress", waiting: "waiting", done: "done" } as const)[event.after.status])}`
              : ""}
            <span className="ml-1">{formatDate(event.createdAt)}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}
