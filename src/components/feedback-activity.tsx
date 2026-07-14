import { History } from "lucide-react";
import type { FeedbackEvent } from "@/lib/types";

const actionLabels: Record<FeedbackEvent["action"], string> = {
  created: "created",
  edited: "edited",
  edit_undone: "undid an edit",
  status_changed: "changed status",
  status_undone: "undid a status change",
  archived: "archived",
  restored: "restored",
};

export function FeedbackActivityList({ events }: { events: FeedbackEvent[] }) {
  if (events.length === 0) return null;
  return (
    <details className="rounded-md border bg-muted/20 px-3 py-2">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <History className="size-3.5" /> Feedback activity ({events.length})
      </summary>
      <ol className="mt-3 space-y-2 border-t pt-3">
        {events.map((event) => (
          <li key={event._id} className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{actionLabels[event.action]}</span>
            {event.before?.status !== event.after?.status && event.before && event.after
              ? ` · ${event.before.status.replace("_", " ")} → ${event.after.status.replace("_", " ")}`
              : ""}
            <span className="ml-1">{new Date(event.createdAt).toLocaleString()}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}
