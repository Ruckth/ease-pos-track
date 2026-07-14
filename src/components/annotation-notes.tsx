import { Fragment, useState } from "react";
import { Clock3, Loader2, MapPin, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
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
  deletedAnnotations,
  onFocus,
  onUpdate,
  onDelete,
  onRestore,
}: {
  annotations: Annotation[];
  deletedAnnotations: Annotation[];
  onFocus: (annotation: Annotation) => void;
  onUpdate: (annotationId: string, text: string) => Promise<void>;
  onDelete: (annotationId: string) => Promise<void>;
  onRestore: (annotationId: string) => Promise<void>;
}) {
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [error, setError] = useState("");

  if (annotations.length === 0 && deletedAnnotations.length === 0) return null;

  const sorted = [...annotations].sort((a, b) => a.label - b.label);
  const deleted = [...deletedAnnotations].sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Comments on media
      </p>
      {error ? <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
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
              {editingId === annotation.id ? (
                <div className="space-y-2">
                  <Textarea rows={3} value={editText} maxLength={2_000} onChange={(event) => setEditText(event.target.value)} />
                  <div className="flex justify-end gap-1">
                    <Button type="button" variant="ghost" size="sm" onClick={() => setEditingId(null)}>Cancel</Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={!editText.trim() || savingEdit}
                      onClick={async () => {
                        setSavingEdit(true);
                        setError("");
                        try {
                          await onUpdate(annotation.id, editText);
                          setEditingId(null);
                        } catch (updateError) {
                          setError(updateError instanceof Error ? updateError.message : "Unable to update the comment.");
                        } finally {
                          setSavingEdit(false);
                        }
                      }}
                    >
                      {savingEdit ? <Loader2 className="animate-spin" /> : null}
                      Save
                    </Button>
                  </div>
                </div>
              ) : <p className="whitespace-pre-wrap text-sm leading-5">{annotation.text}</p>}
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
              aria-label={`Edit comment ${annotation.label}`}
              onClick={() => {
                setEditingId(annotation.id);
                setEditText(annotation.text);
                setError("");
              }}
              className="mt-0.5 text-muted-foreground hover:text-primary"
            >
              <Pencil className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label={`Delete comment ${annotation.label}`}
              disabled={deletingId === annotation.id}
              onClick={async () => {
                if (!window.confirm(`Delete comment ${annotation.label}? You can undo this afterwards.`)) return;
                setDeletingId(annotation.id);
                setError("");
                try {
                  await onDelete(annotation.id);
                } catch (deleteError) {
                  setError(deleteError instanceof Error ? deleteError.message : "Unable to delete the comment.");
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
      {deleted.length > 0 ? (
        <div className="space-y-1.5 pt-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Recently deleted</p>
          <ul className="space-y-1.5">
            {deleted.map((annotation) => (
              <li key={annotation.id} className="flex items-start gap-2 rounded-md border border-dashed bg-muted/20 px-2.5 py-2 opacity-80">
                <span className={labelChipClass()}>{annotation.label}</span>
                <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm leading-5 text-muted-foreground">{annotation.text}</p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={restoringId === annotation.id}
                  onClick={async () => {
                    setRestoringId(annotation.id);
                    setError("");
                    try {
                      await onRestore(annotation.id);
                    } catch (restoreError) {
                      setError(restoreError instanceof Error ? restoreError.message : "Unable to restore the comment.");
                    } finally {
                      setRestoringId(null);
                    }
                  }}
                >
                  {restoringId === annotation.id ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
