import { History } from "lucide-react";
import type { AnnotationEvent } from "@/lib/types";

const actionLabels: Record<AnnotationEvent["action"], string> = {
  created: "created",
  updated: "updated",
  deleted: "deleted",
  restored: "restored",
  update_undone: "undid an update",
};

function shortText(text: string | undefined) {
  if (!text) return "";
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

export function AnnotationActivityList({ events }: { events: AnnotationEvent[] }) {
  if (events.length === 0) return null;

  return (
    <details className="rounded-md border bg-muted/20 px-3 py-2">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <History className="size-3.5" />
        Comment activity ({events.length})
      </summary>
      <ol className="mt-3 space-y-2 border-t pt-3">
        {events.map((event) => {
          const annotation = event.after ?? event.before;
          const moved = event.action === "updated" && event.before && event.after
            && (event.before.x !== event.after.x || event.before.y !== event.after.y || event.before.time !== event.after.time);
          const textChanged = event.action === "updated" && event.before?.text !== event.after?.text;
          return (
            <li key={event._id} className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Comment {annotation?.label ?? "?"}</span>
              {` ${actionLabels[event.action]}`}
              {moved ? " · position changed" : ""}
              {textChanged ? ` · “${shortText(event.before?.text)}” → “${shortText(event.after?.text)}”` : ""}
              <span className="ml-1">{new Date(event.createdAt).toLocaleString()}</span>
            </li>
          );
        })}
      </ol>
    </details>
  );
}
