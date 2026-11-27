import { AlertDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
  type CarouselApi,
} from "@/components/ui/carousel";
import { Textarea } from "@/components/ui/textarea";
import { localizeError, useI18n } from "@/lib/i18n";
import { formatClock, isVideoMedia, type Annotation, type MediaItem, type AnnotationDraftInput, type AnnotationUpdateInput } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { EmblaCarouselType } from "embla-carousel";
import { Loader2, MapPin, PlayCircle } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { PinDetails } from "./annotation-overlays";
import { ImageSlide, VideoSlide } from "./media-slides";

export type MediaViewerHandle = {
  focusAnnotation: (annotation: Annotation) => void;
  requestClose: (onClose: () => void) => void;
};

export type DraftTarget = Omit<AnnotationDraftInput, "text">;

export type FocusRequest = { id: string; nonce: number } | null;

export const MediaViewer = forwardRef<
  MediaViewerHandle,
  {
    media: MediaItem[];
    annotations: Annotation[];
    initialIndex?: number;
    disabled?: boolean;
    readOnly?: boolean;
    workspace?: boolean;
    onMediaChange?: (index: number) => void;
    renderImageAction?: (index: number) => ReactNode;
    onCreateAnnotation: (input: AnnotationDraftInput) => Promise<void>;
    onUpdateAnnotation: (input: AnnotationUpdateInput) => Promise<void>;
    onDeleteAnnotation: (annotationId: string) => Promise<void>;
  }
>(function MediaViewer({ media, annotations, initialIndex = 0, disabled = false, readOnly = false, workspace = false, onMediaChange, renderImageAction, onCreateAnnotation, onUpdateAnnotation, onDeleteAnnotation }, ref) {
  const { t } = useI18n();
  const [mainApi, setMainApi] = useState<CarouselApi>();
  const [thumbApi, setThumbApi] = useState<CarouselApi>();
  const [selectedIndex, setSelectedIndex] = useState(initialIndex);
  const initialTarget = useRef(initialIndex);
  const addButton = useRef<HTMLButtonElement>(null);
  const fieldset = useRef<HTMLFieldSetElement>(null);
  const [annotateMode, setAnnotateMode] = useState(false);
  const [draft, setDraft] = useState<DraftTarget | null>(null);
  const [draftText, setDraftText] = useState("");
  const [saving, setSaving] = useState(false);
  const [repositioning, setRepositioning] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [editText, setEditText] = useState<string | null>(null);
  const [panelBusy, setPanelBusy] = useState(false);
  const [discard, setDiscard] = useState<{ action: () => void } | null>(null);
  const noteInput = useRef<HTMLTextAreaElement>(null);
  const noteListButton = useRef<HTMLButtonElement>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [focus, setFocus] = useState<FocusRequest>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const mediaLocked = annotateMode || Boolean(movingId) || editText !== null || panelBusy;
  const mediaLockedRef = useRef(mediaLocked);
  const focusNonceRef = useRef(0);
  const focusTimerRef = useRef<number | null>(null);

  mediaLockedRef.current = mediaLocked;
  const currentNotes = annotations.filter(note => note.mediaIndex === selectedIndex);
  const selectedNote = currentNotes.find(note => note.id === openId);
  const placing = !disabled && !readOnly && !saving && (Boolean(movingId) || (annotateMode && (!draft || repositioning)));
  const noteRemovedWhileEditing = editText !== null && !selectedNote;
  const dirty = Boolean(draftText.trim()) || (editText !== null && editText !== selectedNote?.text);

  const requestNoteChange = useCallback((action: () => void) => {
    if (saving || panelBusy) return;
    if (dirty) setDiscard({ action });
    else action();
  }, [dirty, saving, panelBusy]);

  const onSelect = useCallback(() => {
    if (!mainApi) return;
    const index = mainApi.selectedScrollSnap();
    setSelectedIndex(index);
    initialTarget.current = index;
    thumbApi?.scrollTo(index);
  }, [mainApi, thumbApi]);

  useEffect(() => {
    if (!mainApi) return;
    mainApi.on("select", onSelect);
    mainApi.on("reInit", onSelect);
    return () => {
      mainApi.off("select", onSelect);
      mainApi.off("reInit", onSelect);
    };
  }, [mainApi, onSelect]);

  useEffect(() => {
    if (!mainApi || media.length === 0) return;
    const targetIndex = Math.min(Math.max(0, initialTarget.current), media.length - 1);
    mainApi.scrollTo(targetIndex, true);
    thumbApi?.scrollTo(targetIndex);
    setSelectedIndex(targetIndex);
  }, [initialIndex, mainApi, media.length, thumbApi]);

  useEffect(() => {
    onMediaChange?.(selectedIndex);
  }, [onMediaChange, selectedIndex]);

  useEffect(() => {
    return () => {
      if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
    };
  }, []);

  const highlightNote = useCallback((annotation: Annotation) => {
    setOpenId(annotation.id);
    focusNonceRef.current += 1;
    setFocus({ id: annotation.id, nonce: focusNonceRef.current });
    if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
    focusTimerRef.current = window.setTimeout(() => setFocus(null), 3000);
  }, []);

  useImperativeHandle(ref, () => ({
    requestClose: requestNoteChange,
    focusAnnotation: annotation => requestNoteChange(() => {
      initialTarget.current = annotation.mediaIndex;
      mainApi?.scrollTo(annotation.mediaIndex, true);
      setAnnotateMode(false);
      setMovingId(null);
      setDraft(null);
      setDraftText("");
      setRepositioning(false);
      setEditText(null);
      setActionError("");
      highlightNote(annotation);
    }),
  }), [highlightNote, mainApi, requestNoteChange]);

  useEffect(() => {
    if (!focus) return;
    fieldset.current?.querySelector<HTMLElement>(`[data-pin-id="${CSS.escape(focus.id)}"]`)?.focus({ preventScroll: true });
  }, [focus, selectedIndex]);

  const watchDrag = useCallback(
    (_api: EmblaCarouselType, event: MouseEvent | TouchEvent) => {
      if (media.length <= 1) return false;
      if (mediaLockedRef.current) return false;
      const target = event.target as Element | null;
      if (target?.closest("video")) return false;
      return true;
    },
    [media.length],
  );

  const carouselOpts = useMemo(() => ({ watchDrag }), [watchDrag]);

  function finishPlacement() {
    setDraft(null);
    setDraftText("");
    setMovingId(null);
    setRepositioning(false);
    setAnnotateMode(false);
    setActionError("");
    requestAnimationFrame(() => addButton.current?.focus({ preventScroll: true }));
  }

  function closeNote() {
    setOpenId(null);
    setEditText(null);
    requestAnimationFrame(() => {
      const marker = openId && fieldset.current?.querySelector<HTMLElement>(`[data-pin-id="${CSS.escape(openId)}"]`);
      (noteListButton.current || marker || addButton.current)?.focus({ preventScroll: true });
    });
  }

  function endRepositioning() {
    setRepositioning(false);
    requestAnimationFrame(() => noteInput.current?.focus({ preventScroll: true }));
  }

  function selectNote(id: string | null, highlight = false) {
    if (mediaLocked && editText === null) return;
    requestNoteChange(() => {
      setEditText(null);
      if (!id) { closeNote(); return; }
      const note = currentNotes.find(item => item.id === id);
      if (highlight && note) highlightNote(note);
      else setOpenId(id);
    });
  }

  function beginDraft(target: DraftTarget) {
    setOpenId(null);
    setDraft(target);
    if (repositioning) endRepositioning();
  }

  function startMoving(annotationId: string) {
    if (disabled || readOnly) return;
    const annotation = annotations.find((item) => item.id === annotationId);
    if (!annotation) return;
    mainApi?.scrollTo(annotation.mediaIndex);
    setMovingId(annotationId);
    setAnnotateMode(false);
    setDraft(null);
    setOpenId(null);
    setActionError("");
  }

  async function handleSurfaceClick(target: DraftTarget) {
    if (!placing) return;
    if (!movingId) {
      beginDraft(target);
      return;
    }

    const movingAnnotation = annotations.find((annotation) => annotation.id === movingId);
    if (!movingAnnotation) {
      setMovingId(null);
      setActionError(t("mediaUnavailable"));
      return;
    }
    if (target.mediaIndex !== movingAnnotation.mediaIndex) {
      mainApi?.scrollTo(movingAnnotation.mediaIndex);
      setActionError(t("unableMoveComment"));
      return;
    }

    setActionError("");
    setSaving(true);
    try {
      await onUpdateAnnotation({
        annotationId: movingId,
        x: target.x,
        y: target.y,
        ...(target.time === undefined ? {} : { time: target.time }),
      });
      setMovingId(null);
      highlightNote({ ...movingAnnotation, x: target.x, y: target.y, time: target.time ?? movingAnnotation.time });
    } catch (error) {
      setActionError(localizeError(error, t));
    } finally {
      setSaving(false);
    }
  }

  async function saveDraft() {
    if (disabled || readOnly || !draft || repositioning || !draftText.trim() || saving) return;
    setSaving(true);
    setActionError("");
    try {
      await onCreateAnnotation({ ...draft, text: draftText.trim() });
      setDraft(null);
      setDraftText("");
      // Leaving the input mounted or refocusing it would reopen the software keyboard.
      if (!workspace || !window.matchMedia("(max-width: 639px)").matches) {
        setAnnotateMode(false);
        requestAnimationFrame(() => addButton.current?.focus({ preventScroll: true }));
      }
    } catch (error) {
      setActionError(localizeError(error, t));
    } finally {
      setSaving(false);
    }
  }

  if (media.length === 0) {
    return (
      <div className="grid aspect-video place-items-center rounded-lg border border-dashed text-sm text-muted-foreground">
        {t("noMedia")}
      </div>
    );
  }

  return (
    <fieldset ref={fieldset} disabled={disabled} className={cn("min-w-0 space-y-2", workspace && "max-sm:flex max-sm:min-h-0 max-sm:flex-1 max-sm:flex-col max-sm:gap-2 max-sm:space-y-0")} onKeyDown={event => {
      if (event.key !== "Escape" || discard || !(mediaLocked || openId)) return;
      // Confirmation dialogs render in portals. Their Escape belongs to that dialog.
      if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      if (repositioning) endRepositioning();
      else requestNoteChange(mediaLocked && editText === null ? finishPlacement : closeNote);
    }}>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
        <p className="mr-auto text-sm leading-5 text-muted-foreground">
          {placing ? <span role="status">{movingId ? t("moveComment") : t("choosePinSpot")}</span>
            : <span className={workspace ? "max-sm:sr-only" : undefined}>{selectedIndex + 1} / {media.length}</span>}
        </p>
        {!mediaLocked && !readOnly && renderImageAction?.(selectedIndex)}
        {repositioning && <Button type="button" size="touch" variant="ghost" className="shrink-0"
          onClick={endRepositioning}>{t("cancelMove")}</Button>}
        {!readOnly && (movingId || annotateMode) && !draft &&
          <Button type="button" size="touch" variant="ghost" className="shrink-0"
            onClick={() => requestNoteChange(finishPlacement)} disabled={saving}>
            {t(movingId ? "cancelMove" : "placementDone")}
          </Button>}
        {!readOnly && !mediaLocked && (
          <Button type="button" size="touch" ref={addButton} variant="outline"
            onClick={() => {
              setAnnotateMode(true);
              setOpenId(null);
              setListOpen(false);
              setActionError("");
            }}>
            <MapPin aria-hidden="true" />{t("addPin")}
          </Button>
        )}
      </div>

      {actionError ? <p role="alert" className="shrink-0 text-sm text-destructive">{actionError}</p> : null}

      <Carousel setApi={setMainApi} opts={carouselOpts} keyboardNavigation={!mediaLocked}
        className={cn("overflow-hidden rounded-lg border bg-black", workspace && "max-sm:min-h-14 max-sm:flex-1 max-sm:[&>div:first-child]:h-full")}>
        <CarouselContent className={cn("-ml-0", workspace && "max-sm:h-full")}>
          {media.map((item, index) => {
            const Slide = isVideoMedia(item) ? VideoSlide : ImageSlide;
            return <CarouselItem key={item.key} className={cn("pl-0", workspace && "max-sm:flex max-sm:h-full max-sm:min-h-0 max-sm:flex-col")}>
              {index === selectedIndex && <Slide item={item} index={index}
                annotations={annotations.filter(note => note.mediaIndex === index)}
                annotateMode={placing}
                movingPin={repositioning && draft ? { id: "draft", x: draft.x, y: draft.y, time: draft.time } : annotations.find(note => note.id === movingId)}
                draft={draft?.mediaIndex === index && !repositioning ? draft : null}
                workspace={workspace} pinsPassive={annotateMode || Boolean(movingId)}
                focus={focus} openId={openId} onOpenChange={selectNote}
                onSurfaceClick={handleSurfaceClick} />}
            </CarouselItem>;
          })}
        </CarouselContent>
        {media.length > 1 && !mediaLocked ? (
          <>
            <CarouselPrevious className="left-2 border-none bg-black/50 text-white hover:bg-black/70" />
            <CarouselNext className="right-2 border-none bg-black/50 text-white hover:bg-black/70" />
          </>
        ) : null}
      </Carousel>

      {media.length > 1 ? (
        <Carousel className={cn("shrink-0", mediaLocked && "hidden")} setApi={setThumbApi} opts={{ containScroll: "keepSnaps", dragFree: true }}>
          <CarouselContent className="-ml-2">
            {media.map((item, index) => (
              <CarouselItem key={item.key} className="basis-1/5 pl-2 sm:basis-1/6">
                <button
                  type="button"
                  onClick={() => mainApi?.scrollTo(index)}
                  disabled={mediaLocked}
                  aria-label={t("mediaNumber", { number: index + 1 })}
                  className={cn(
                    "relative block aspect-square w-full overflow-hidden rounded-md border-2 bg-black transition-all", workspace && "max-sm:aspect-auto max-sm:h-11",
                    index === selectedIndex
                      ? "border-primary opacity-100"
                      : "border-transparent opacity-50 hover:opacity-80",
                  )}
                >
                  {isVideoMedia(item) ? (
                    <>
                      <span className="sr-only">{item.name}</span>
                      <PlayCircle className="absolute left-1/2 top-1/2 size-5 -translate-x-1/2 -translate-y-1/2 text-white" />
                    </>
                  ) : (
                    <img className="h-full w-full object-cover" src={item.url} alt="" loading="lazy" />
                  )}
                </button>
              </CarouselItem>
            ))}
          </CarouselContent>
        </Carousel>
      ) : null}

      {noteRemovedWhileEditing && (
        <div className="shrink-0 space-y-2 border-t pt-2">
          <p role="status" className="text-sm">{t("removedNoteDraft")}</p>
          <Textarea rows={2} readOnly value={editText} aria-label={t("unsavedNoteText")} className="min-h-16" />
          <Button type="button" size="touch" variant="outline" onClick={() => requestNoteChange(closeNote)}>{t("closeNote")}</Button>
        </div>
      )}
      {!noteRemovedWhileEditing && !annotateMode && !movingId && currentNotes.length > 0 && (
        <div className={cn("shrink-0", workspace && "max-sm:max-h-[52%] max-sm:overflow-y-auto")}>
          {workspace && <Button type="button" size="touch" ref={noteListButton} variant="ghost" aria-expanded={listOpen}
            onClick={() => setListOpen(!listOpen)}>{t("noteListCount", { count: currentNotes.length })}</Button>}
          {workspace && listOpen && (
            <ul className="flex max-h-24 flex-wrap gap-1 overflow-y-auto pb-1">
              {currentNotes.map(note => (
                <li key={note.id}>
                  <Button type="button" size="touch" variant={openId === note.id ? "default" : "outline"}
                    aria-pressed={openId === note.id} onClick={() => selectNote(note.id, true)}>
                    {t("noteLabel", { number: note.label })}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {selectedNote && <PinDetails key={selectedNote.id} annotation={selectedNote} readOnly={readOnly}
            editText={editText} setEditText={setEditText} onCancelEdit={() => requestNoteChange(() => setEditText(null))}
            onClose={() => requestNoteChange(closeNote)} onUpdate={onUpdateAnnotation} onMove={startMoving}
            onDelete={onDeleteAnnotation} onDeleted={closeNote} onBusyChange={setPanelBusy} />}
        </div>
      )}

      {draft && !repositioning && (
        <div className="shrink-0 space-y-2 border-t pt-2">
          {draft.time !== undefined && <p className="text-sm text-muted-foreground">{t("pinAtTime", { time: formatClock(draft.time) })}</p>}
          <Textarea
            ref={noteInput}
            autoFocus
            aria-label={t("describeIssue")}
            disabled={saving}
            className="min-h-16"
            maxLength={2000}
            rows={2}
            value={draftText}
            onChange={(event) => setDraftText(event.target.value)}
            placeholder={t("describeIssue")}
          />
          <div className="flex flex-wrap justify-between gap-1">
            <Button type="button" size="touch" variant="ghost" disabled={saving}
              onClick={() => { noteInput.current?.blur(); setRepositioning(true); }}>{t("repositionPin")}</Button>
            <div className="ml-auto flex gap-1">
              <Button type="button" variant="ghost" size="touch" disabled={saving}
                onClick={() => requestNoteChange(finishPlacement)}>{t("cancel")}</Button>
              <Button type="button" size="touch" disabled={!draftText.trim() || saving} onClick={saveDraft}>
                {saving && <Loader2 aria-hidden="true" className="animate-spin" />}{t("savePin")}
              </Button>
            </div>
          </div>
        </div>
      )}

      <AlertDialog open={discard !== null} onOpenChange={open => { if (!open) setDiscard(null); }}
        title={t("discardNoteTitle")} description={t("discardNoteDescription")} confirmLabel={t("discardChanges")}
        onConfirm={() => discard?.action()} />
    </fieldset>
  );
});
