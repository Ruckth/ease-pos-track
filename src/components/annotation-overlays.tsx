import type { AnnotationUpdateInput } from "@/lib/types";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { localizeError, useI18n } from "@/lib/i18n";
import { formatClock, type Annotation } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Loader2, Move, Pencil, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function PinMarker({
  annotation,
  highlighted,
  passive = false,
  onClick,
}: {
  annotation: Annotation;
  highlighted: boolean;
  passive?: boolean;
  onClick: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      disabled={passive}
      aria-hidden={passive || undefined}
      data-pin-id={annotation.id}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      aria-label={`${t("comment", { label: annotation.label })}: ${annotation.text}`}
      className={cn(
        "absolute z-10 flex size-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full annotation-glass-marker border border-white/70 text-xs font-bold text-primary-foreground shadow-md transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/80",
        "[@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-1",
        highlighted && "scale-125 ring-4 ring-amber-400/80",
        passive && "pointer-events-none opacity-70",
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

export function PinDetails({
  annotation, readOnly, editText, setEditText, onCancelEdit, onClose, onUpdate, onMove, onDelete, onBusyChange,
}: {
  annotation: Annotation;
  readOnly: boolean;
  editText: string | null;
  setEditText: (text: string | null) => void;
  onCancelEdit: () => void;
  onClose: () => void;
  onUpdate: (input: AnnotationUpdateInput) => Promise<void>;
  onMove: (annotationId: string) => void;
  onDelete: (annotationId: string) => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}) {
  const { t } = useI18n();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const editButton = useRef<HTMLButtonElement>(null);
  const editing = editText !== null;
  const wasEditing = useRef(editing);
  useEffect(() => {
    if (wasEditing.current && !editing) editButton.current?.focus({ preventScroll: true });
    wasEditing.current = editing;
  }, [editing]);

  async function run(action: () => Promise<void>) {
    setPending(true);
    onBusyChange(true);
    setError("");
    try { await action(); }
    catch (reason) { setError(localizeError(reason, t)); }
    finally { setPending(false); onBusyChange(false); }
  }

  return (
    <div className="min-w-0 border-t pt-1">
      <div className="flex items-center justify-between gap-1">
        <h3 className="min-w-0 text-sm font-medium">
          {t("noteLabel", { number: annotation.label })}
          {annotation.time !== undefined && ` · ${t("pinAtTime", { time: formatClock(annotation.time) })}`}
        </h3>
        <div className="flex shrink-0">
          {!readOnly && editText === null && <>
            <Button type="button" size="icon-touch" variant="ghost" ref={editButton} aria-label={t("editComment", { label: annotation.label })} disabled={pending}
              onClick={() => { setError(""); setEditText(annotation.text); }}><Pencil aria-hidden="true" /></Button>
            <Button type="button" size="icon-touch" variant="ghost" aria-label={t("repositionPin")} disabled={pending}
              onClick={() => onMove(annotation.id)}><Move aria-hidden="true" /></Button>
            <Button type="button" size="icon-touch" variant="ghost" aria-label={t("deleteComment", { label: annotation.label })} disabled={pending}
              onClick={() => setConfirmDelete(true)}><Trash2 aria-hidden="true" /></Button>
          </>}
          <Button type="button" size="icon-touch" variant="ghost" aria-label={t("closeNote")} disabled={pending} onClick={onClose}><X aria-hidden="true" /></Button>
        </div>
      </div>
      {editText !== null && !readOnly ? (
        <div className="space-y-2">
          <Textarea autoFocus aria-label={t("editComment", { label: annotation.label })} rows={2} className="min-h-16" maxLength={2_000}
            value={editText} disabled={pending} onChange={(event) => setEditText(event.target.value)} />
          <div className="flex justify-end gap-2">
            <Button type="button" size="touch" variant="ghost" disabled={pending} onClick={onCancelEdit}>{t("cancel")}</Button>
            <Button type="button" size="touch" disabled={!editText.trim() || pending} onClick={() => void run(async () => {
              await onUpdate({ annotationId: annotation.id, text: editText.trim() });
              setEditText(null);
            })}>
              {pending && <Loader2 aria-hidden="true" className="animate-spin" />}{t("save")}
            </Button>
          </div>
        </div>
      ) : <p className="whitespace-pre-wrap break-words pb-2 text-sm leading-5">{annotation.text}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}
        title={t("deleteComment", { label: annotation.label })}
        description={t("deleteCommentConfirm", { label: annotation.label })}
        confirmLabel={t("deleteComment", { label: annotation.label })}
        onConfirm={() => void run(async () => { await onDelete(annotation.id); onClose(); })} />
    </div>
  );
}
