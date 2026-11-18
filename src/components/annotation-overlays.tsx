import type { AnnotationUpdateInput } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { localizeError, useI18n } from "@/lib/i18n";
import { formatClock, type Annotation } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Loader2, Move, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";



export function PinMarker({
  annotation,
  highlighted,
  onClick,
}: {
  annotation: Annotation;
  highlighted: boolean;
  onClick: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      data-pin-id={annotation.id}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      aria-label={`${t("comment", { label: annotation.label })}: ${annotation.text}`}
      className={cn(
        "absolute z-10 flex size-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full annotation-glass-marker border border-white/70 text-xs font-bold text-primary-foreground shadow-md transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/80",
        highlighted && "scale-125 ring-4 ring-amber-400/80",
      )}
      style={{ left: `${(annotation.x ?? 0) * 100}%`, top: `${(annotation.y ?? 0) * 100}%` }}
    >
      {annotation.label}
    </button>
  );
}

export function DraftPin({ x, y }: { x: number; y: number }) {
  return (
    <span
      className="pointer-events-none absolute z-10 flex size-6 -translate-x-1/2 -translate-y-1/2 motion-safe:animate-pulse items-center justify-center rounded-full border-2 border-dashed border-white bg-primary/70 text-[11px] font-bold text-primary-foreground shadow-md"
      style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
    >
      +
    </span>
  );
}

export function PinPopover({
  annotation,
  readOnly = false,
  onClose,
  onUpdate,
  onMove,
  onDelete,
}: {
  annotation: Annotation | null;
  readOnly?: boolean;
  onClose: () => void;
  onUpdate: (input: AnnotationUpdateInput) => Promise<void>;
  onMove: (annotationId: string) => void;
  onDelete: (annotationId: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [error, setError] = useState("");

  if (!annotation || annotation.x === undefined || annotation.y === undefined) return null;

  const below = annotation.y <= 0.6;
  return (
    <div
      className="annotation-glass-popover absolute z-20 w-52 max-w-[calc(100%_-_16px)] rounded-lg border border-white/60 p-2.5 text-sm shadow-lg"
      style={{
        left: `clamp(112px, ${annotation.x * 100}%, calc(100% - 112px))`,
        top: `${annotation.y * 100}%`,
        transform: below ? "translate(-50%, 18px)" : "translate(-50%, calc(-100% - 18px))",
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
          {annotation.label}
        </span>
        {!readOnly && <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label={t("editComment", { label: annotation.label })}
            onClick={() => {
              setEditText(annotation.text);
              setEditing(true);
              setError("");
            }}
            className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Pencil className="size-4" />
          </button>
          <button
            type="button"
            aria-label={t("moveComment")}
            onClick={() => {
              onMove(annotation.id);
              onClose();
            }}
            className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Move className="size-4" />
          </button>
          <button
            type="button"
            aria-label={t("deleteComment", { label: annotation.label })}
            disabled={deleting}
            onClick={async (event) => {
              event.stopPropagation();
              if (!window.confirm(t("deleteCommentConfirm", { label: annotation.label }))) return;
              setDeleting(true);
              setError("");
              try {
                await onDelete(annotation.id);
                onClose();
              } catch (deleteError) {
                setError(localizeError(deleteError, t));
              } finally {
                setDeleting(false);
              }
            }}
            className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
          </button>
        </div>}
      </div>
      {editing ? (
        <div className="mt-2 space-y-2">
          <Textarea rows={3} value={editText} maxLength={2_000} onChange={(event) => setEditText(event.target.value)} />
          <div className="flex justify-end gap-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>{t("cancel")}</Button>
            <Button
              type="button"
              size="sm"
              disabled={!editText.trim() || savingEdit}
              onClick={async () => {
                setSavingEdit(true);
                setError("");
                try {
                  await onUpdate({ annotationId: annotation.id, text: editText });
                  setEditing(false);
                } catch (updateError) {
                  setError(localizeError(updateError, t));
                } finally {
                  setSavingEdit(false);
                }
              }}
            >
              {savingEdit ? <Loader2 className="animate-spin" /> : null}
              {t("save")}
            </Button>
          </div>
        </div>
      ) : <p className="mt-1.5 whitespace-pre-wrap leading-5">{annotation.text}</p>}
      {error ? <p role="alert" className="mt-2 text-destructive">{error}</p> : null}
      {annotation.time !== undefined ? (
        <p className="mt-1 text-muted-foreground">{t("videoAt", { time: formatClock(annotation.time) })}</p>
      ) : null}
    </div>
  );
}
