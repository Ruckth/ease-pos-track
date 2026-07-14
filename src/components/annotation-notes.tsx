import { Fragment, useState } from "react";
import { Clock3, Loader2, MapPin, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatClock, type Annotation } from "@/lib/types";

function labelChipClass(active = false) {
  return cn(
    "inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground transition-transform hover:scale-110",
    active && "ring-2 ring-amber-400/80",
  );
}

export function DescriptionWithTags({
  text,
  annotations,
  onFocus,
}: {
  text: string;
  annotations: Annotation[];
  onFocus: (annotation: Annotation) => void;
}) {
  const parts = text.split(/\[(\d+)\]/g);

  return (
    <p className="whitespace-pre-wrap text-sm leading-6 text-foreground">
      {parts.map((part, index) => {
        if (index % 2 === 0) {
          return <Fragment key={index}>{part}</Fragment>;
        }
        const annotation = annotations.find((item) => item.label === Number(part));
        if (!annotation) {
          return <Fragment key={index}>[{part}]</Fragment>;
        }
        return (
          <button
            key={index}
            type="button"
            onClick={() => onFocus(annotation)}
            aria-label={`Show comment ${annotation.label} on media`}
            className={cn(labelChipClass(), "mx-0.5 -translate-y-px align-text-bottom")}
          >
            {annotation.label}
          </button>
        );
      })}
    </p>
  );
}

export function AnnotationList({
  annotations,
  onFocus,
  onDelete,
}: {
  annotations: Annotation[];
  onFocus: (annotation: Annotation) => void;
  onDelete: (annotationId: string) => Promise<void>;
}) {
  const [deletingId, setDeletingId] = useState<string | null>(null);

  if (annotations.length === 0) return null;

  const sorted = [...annotations].sort((a, b) => a.label - b.label);

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Comments on media
      </p>
      <ul className="space-y-1.5">
        {sorted.map((annotation) => (
          <li key={annotation.id} className="flex items-start gap-2 rounded-md border bg-muted/30 px-2.5 py-2">
            <button
              type="button"
              onClick={() => onFocus(annotation)}
              aria-label={`Show comment ${annotation.label} on media`}
              className={labelChipClass()}
            >
              {annotation.label}
            </button>
            <div className="min-w-0 flex-1">
              <p className="whitespace-pre-wrap text-sm leading-5">{annotation.text}</p>
              <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                {annotation.kind === "time" ? (
                  <>
                    <Clock3 className="size-3" />
                    video at {formatClock(annotation.time ?? 0)}
                  </>
                ) : (
                  <>
                    <MapPin className="size-3" />
                    image {annotation.mediaIndex + 1}
                  </>
                )}
              </p>
            </div>
            <button
              type="button"
              aria-label={`Delete comment ${annotation.label}`}
              disabled={deletingId === annotation.id}
              onClick={async () => {
                setDeletingId(annotation.id);
                try {
                  await onDelete(annotation.id);
                } finally {
                  setDeletingId(null);
                }
              }}
              className="mt-0.5 text-muted-foreground hover:text-destructive disabled:opacity-50"
            >
              {deletingId === annotation.id ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Trash2 className="size-3.5" />
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
