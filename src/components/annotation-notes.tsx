import { Fragment, useEffect, useId, useRef, useState } from "react";
import { Clock3, Loader2, MapPin, MessageCircle, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { formatClock, type Annotation, type MediaItem } from "@/lib/types";
import { localizeError, useI18n } from "@/lib/i18n";
import { MEDIA_ANNOTATION_MAX_LENGTH, mediaUxCopy } from "@/lib/media-ux-copy";

function labelChipClass(active = false, touchTarget = false) {
  return cn(
    "inline-flex shrink-0 items-center justify-center rounded-full bg-primary font-bold text-primary-foreground transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    touchTarget ? "size-9 text-xs" : "size-5 text-[11px]",
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
  const { t } = useI18n();
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
            aria-label={t("showComment", { label: annotation.label })}
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
  media,
  readOnly = false,
  allowDeleteRecovery = true,
  onFocus,
  onQuote,
  onUpdate,
  onDelete,
  onRestore,
}: {
  annotations: Annotation[];
  deletedAnnotations: Annotation[];
  media?: MediaItem[];
  readOnly?: boolean;
  allowDeleteRecovery?: boolean;
  onFocus: (annotation: Annotation) => void;
  onQuote?: (annotation: Annotation) => void;
  onUpdate: (annotationId: string, text: string) => Promise<void>;
  onDelete: (annotationId: string) => Promise<void>;
  onRestore: (annotationId: string) => Promise<void>;
}) {
  const { t, language, formatDate } = useI18n();
  const copy = mediaUxCopy(language);
  const editFieldPrefix = useId();
  const editInputRef = useRef<HTMLTextAreaElement>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteNote, setConfirmDeleteNote] = useState<Annotation | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [pendingSwitch, setPendingSwitch] = useState<{ action: () => void } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!editingId) return;
    editInputRef.current?.focus({ preventScroll: true });
  }, [editingId]);

  if (annotations.length === 0 && deletedAnnotations.length === 0) return null;

  const sorted = [...annotations].sort((a, b) => a.label - b.label);
  const deleted = [...deletedAnnotations].sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
  const editingAnnotation = editingId ? annotations.find((item) => item.id === editingId) : undefined;
  const hasUnsavedEdit = Boolean(editingAnnotation && editText !== editingAnnotation.text);
  const nearCharLimit = editText.length >= MEDIA_ANNOTATION_MAX_LENGTH - 200;

  function guardDirtyEdit(action: () => void) {
    if (savingEdit) return;
    if (hasUnsavedEdit) {
      setPendingSwitch({ action });
    } else {
      action();
    }
  }

  function formatTargetCaption(annotation: Annotation) {
    const fileName = media?.[annotation.mediaIndex]?.name;
    if (annotation.kind === "time") {
      return copy.videoFileTargetCaption(
        annotation.mediaIndex + 1,
        fileName,
        formatClock(annotation.time ?? 0),
      );
    }
    return copy.photoFileTargetCaption(annotation.mediaIndex + 1, fileName);
  }

  async function confirmDelete(annotation: Annotation) {
    setDeletingId(annotation.id);
    setError("");
    try {
      await onDelete(annotation.id);
      if (editingId === annotation.id) {
        setEditingId(null);
        setEditText("");
      }
    } catch (deleteError) {
      setError(localizeError(deleteError, t));
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
        {t("commentsOnMedia")}
      </p>
      {error ? (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <ul className="space-y-1.5">
        {sorted.map((annotation) => {
          const isEditing = editingId === annotation.id;
          const editFieldId = `${editFieldPrefix}-${annotation.id}`;
          return (
            <li
              key={annotation.id}
              className="flex items-start gap-2 rounded-md border bg-muted/30 px-2.5 py-2"
            >
              <button
                type="button"
                onClick={() => onFocus(annotation)}
                aria-label={`${t("showComment", { label: annotation.label })} · ${annotation.text}`}
                className={labelChipClass(false, true)}
              >
                {annotation.label}
              </button>
              <div className="min-w-0 flex-1">
                {isEditing ? (
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                      <label htmlFor={editFieldId} className="font-medium text-foreground">
                        {t("editComment", { label: annotation.label })}
                      </label>
                      <span
                        role={nearCharLimit ? "status" : undefined}
                        className={cn(
                          "tabular-nums",
                          nearCharLimit && "font-medium text-amber-600 dark:text-amber-400",
                          editText.length >= MEDIA_ANNOTATION_MAX_LENGTH && "text-destructive",
                        )}
                      >
                        {copy.characterCount(editText.length, MEDIA_ANNOTATION_MAX_LENGTH)}
                      </span>
                    </div>
                    <Textarea
                      id={editFieldId}
                      ref={editInputRef}
                      autoFocus
                      rows={3}
                      value={editText}
                      maxLength={MEDIA_ANNOTATION_MAX_LENGTH}
                      disabled={savingEdit}
                      onChange={(event) => setEditText(event.target.value)}
                    />
                    <div className="flex justify-end gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={savingEdit}
                        onClick={() =>
                          guardDirtyEdit(() => {
                            setEditingId(null);
                            setEditText("");
                          })
                        }
                      >
                        {t("cancel")}
                      </Button>
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
                            setEditText("");
                          } catch (updateError) {
                            setError(localizeError(updateError, t));
                          } finally {
                            setSavingEdit(false);
                          }
                        }}
                      >
                        {savingEdit ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
                        {t("save")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap break-words text-sm leading-5">{annotation.text}</p>
                )}
                <p className="mt-0.5 flex flex-wrap items-center gap-1 text-sm leading-5 text-muted-foreground">
                  {annotation.kind === "time" ? (
                    <Clock3 className="size-3 shrink-0" aria-hidden="true" />
                  ) : (
                    <MapPin className="size-3 shrink-0" aria-hidden="true" />
                  )}
                  <span className="[overflow-wrap:anywhere]">{formatTargetCaption(annotation)}</span>
                </p>
                {onQuote && !isEditing && (
                  <div className="mt-1.5">
                    <Button type="button" size="sm" variant="outline" onClick={() => onQuote(annotation)}>
                      <MessageCircle aria-hidden="true" />
                      {annotation.kind === "time"
                        ? t("threadQuoteMoment", { time: formatClock(annotation.time ?? 0) })
                        : t("threadQuoteNoteNamed", { label: annotation.label })}
                    </Button>
                  </div>
                )}
              </div>
              {!readOnly && (
                <>
                  <button
                    type="button"
                    aria-label={t("editComment", { label: annotation.label })}
                    onClick={() => {
                      if (editingId === annotation.id) {
                        editInputRef.current?.focus({ preventScroll: true });
                        return;
                      }
                      guardDirtyEdit(() => {
                        setEditingId(annotation.id);
                        setEditText(annotation.text);
                        setError("");
                      });
                    }}
                    className="inline-flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Pencil className="size-4" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    aria-label={t("deleteComment", { label: annotation.label })}
                    disabled={deletingId === annotation.id}
                    onClick={() => setConfirmDeleteNote(annotation)}
                    className="inline-flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  >
                    {deletingId === annotation.id ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <Trash2 className="size-4" aria-hidden="true" />
                    )}
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {!readOnly && deleted.length > 0 ? (
        <div className="space-y-1.5 pt-2">
          <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            {t("recentlyDeleted")}
          </p>
          <ul className="space-y-1.5">
            {deleted.map((annotation) => (
              <li
                key={annotation.id}
                className="flex items-start gap-2 rounded-md border border-dashed bg-muted/20 px-2.5 py-2 opacity-85"
              >
                <span className={labelChipClass()}>{annotation.label}</span>
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="whitespace-pre-wrap break-words text-sm leading-5 text-muted-foreground">
                    {annotation.text}
                  </p>
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs leading-4 text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      {annotation.kind === "time" ? (
                        <Clock3 className="size-3 shrink-0" aria-hidden="true" />
                      ) : (
                        <MapPin className="size-3 shrink-0" aria-hidden="true" />
                      )}
                      <span>{formatTargetCaption(annotation)}</span>
                    </span>
                    {annotation.deletedAt !== undefined ? (
                      <time dateTime={new Date(annotation.deletedAt).toISOString()}>
                        {copy.deletedAtLabel(formatDate(annotation.deletedAt))}
                      </time>
                    ) : null}
                  </p>
                </div>
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
                      setError(localizeError(restoreError, t));
                    } finally {
                      setRestoringId(null);
                    }
                  }}
                >
                  {restoringId === annotation.id ? (
                    <Loader2 aria-hidden="true" className="animate-spin" />
                  ) : (
                    <RotateCcw aria-hidden="true" />
                  )}
                  {t("restore")}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <AlertDialog
        open={pendingSwitch !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingSwitch(null);
            requestAnimationFrame(() => editInputRef.current?.focus({ preventScroll: true }));
          }
        }}
        title={t("discardNoteTitle")}
        description={t("discardNoteDescription")}
        confirmLabel={t("discardChanges")}
        onConfirm={() => {
          const action = pendingSwitch?.action;
          setPendingSwitch(null);
          action?.();
        }}
      />

      <AlertDialog
        open={confirmDeleteNote !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDeleteNote(null);
        }}
        title={confirmDeleteNote ? t("deleteComment", { label: confirmDeleteNote.label }) : ""}
        description={
          confirmDeleteNote
            ? allowDeleteRecovery
              ? t("deleteCommentConfirm", { label: confirmDeleteNote.label })
              : copy.draftDeleteConfirm(confirmDeleteNote.label)
            : ""
        }
        confirmLabel={confirmDeleteNote ? t("deleteComment", { label: confirmDeleteNote.label }) : ""}
        onConfirm={() => {
          if (confirmDeleteNote) void confirmDelete(confirmDeleteNote);
        }}
      />
    </div>
  );
}
