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
import { MEDIA_ANNOTATION_MAX_LENGTH, mediaUxCopy } from "@/lib/media-ux-copy";
import {
  formatClock,
  isVideoMedia,
  type Annotation,
  type MediaItem,
  type AnnotationDraftInput,
  type AnnotationUpdateInput,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import type { EmblaCarouselType } from "embla-carousel";
import { Loader2, MapPin, MessageCircle, MessageSquareText, PlayCircle, ZoomIn } from "lucide-react";
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
import { ImageInspectDialog, ImageSlide, VideoSlide } from "./media-slides";

export type MediaViewerHandle = {
  focusMedia: (index: number) => void;
  focusAnnotation: (annotation: Annotation) => void;
  requestClose: (onClose: () => void) => void;
};

export type DraftTarget = Omit<AnnotationDraftInput, "text">;

export type FocusRequest = { id: string; nonce: number } | null;

export type NoteOpenOrigin = { source: "group"; clusterId: string };

function findGroupTrigger(container: HTMLElement, noteId: string, clusterId?: string): HTMLElement | null {
  const byMember = Array.from(container.querySelectorAll<HTMLElement>("[data-pin-group]")).find((element) =>
    element.dataset.pinGroupIds?.split(" ").includes(noteId),
  );
  if (byMember) return byMember;
  if (clusterId) {
    return container.querySelector<HTMLElement>(`[data-pin-group="${CSS.escape(clusterId)}"]`);
  }
  return null;
}

export const MediaViewer = forwardRef<
  MediaViewerHandle,
  {
    media: MediaItem[];
    annotations: Annotation[];
    initialIndex?: number;
    disabled?: boolean;
    readOnly?: boolean;
    workspace?: boolean;
    allowDeleteRecovery?: boolean;
    onMediaChange?: (index: number) => void;
    renderImageAction?: (index: number) => ReactNode;
    onQuoteMedia?: (index: number) => void;
    onQuoteAnnotation?: (annotation: Annotation) => void;
    onCreateAnnotation: (input: AnnotationDraftInput) => Promise<void>;
    onUpdateAnnotation: (input: AnnotationUpdateInput) => Promise<void>;
    onDeleteAnnotation: (annotationId: string) => Promise<void>;
  }
>(function MediaViewer(
  {
    media,
    annotations,
    initialIndex = 0,
    disabled = false,
    readOnly = false,
    workspace = false,
    allowDeleteRecovery = !workspace,
    onMediaChange,
    renderImageAction,
    onQuoteMedia,
    onQuoteAnnotation,
    onCreateAnnotation,
    onUpdateAnnotation,
    onDeleteAnnotation,
  },
  ref,
) {
  const { t, language } = useI18n();
  const copy = mediaUxCopy(language);
  const [mainApi, setMainApi] = useState<CarouselApi>();
  const [thumbApi, setThumbApi] = useState<CarouselApi>();
  const [selectedIndex, setSelectedIndex] = useState(initialIndex);
  const initialTarget = useRef(initialIndex);
  const addButton = useRef<HTMLButtonElement>(null);
  const fieldset = useRef<HTMLFieldSetElement>(null);
  const [annotateMode, setAnnotateMode] = useState(false);
  const [draft, setDraft] = useState<DraftTarget | null>(null);
  const [draftText, setDraftText] = useState("");
  const [draftError, setDraftError] = useState("");
  const [saving, setSaving] = useState(false);
  const [repositioning, setRepositioning] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [editText, setEditText] = useState<string | null>(null);
  const [panelBusy, setPanelBusy] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [discard, setDiscard] = useState<{ action: () => void } | null>(null);
  const noteInput = useRef<HTMLTextAreaElement>(null);
  const noteListButton = useRef<HTMLButtonElement>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [tentativeMove, setTentativeMove] = useState<DraftTarget | null>(null);
  const [actionError, setActionError] = useState("");
  const [focus, setFocus] = useState<FocusRequest>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [inspectOpen, setInspectOpen] = useState(false);
  const [failedMedia, setFailedMedia] = useState<Record<string, boolean>>({});
  const [navAnnouncement, setNavAnnouncement] = useState("");
  const videoTimesRef = useRef<Record<string, number>>({});
  const moveInFlightRef = useRef(false);
  const draftSaveInFlightRef = useRef(false);
  const hasMountedRef = useRef(false);
  const prevSelectedIndexRef = useRef(initialIndex);
  const mediaLocked = annotateMode || Boolean(movingId) || editText !== null || panelBusy;
  const mediaLockedRef = useRef(mediaLocked);
  const movingMediaIndexRef = useRef<number | null>(null);
  const focusNonceRef = useRef(0);
  const focusTimerRef = useRef<number | null>(null);
  const noteReturnOriginRef = useRef<{ noteId: string; clusterId: string } | null>(null);

  const movingAnnotation = movingId ? annotations.find((item) => item.id === movingId) : undefined;
  mediaLockedRef.current = mediaLocked;
  movingMediaIndexRef.current = movingAnnotation ? movingAnnotation.mediaIndex : null;

  const activeItem = media[selectedIndex];
  const activeIsVideo = activeItem ? isVideoMedia(activeItem) : false;
  const activeMediaFailed = activeItem ? Boolean(failedMedia[activeItem.key]) : false;
  const currentNotes = annotations.filter((note) => note.mediaIndex === selectedIndex);
  const selectedNote = currentNotes.find((note) => note.id === openId);
  const confirmingDeletion = Boolean(selectedNote && selectedNote.id === confirmDeleteId);
  const placing =
    !disabled &&
    !readOnly &&
    !saving &&
    (Boolean(movingId) || (annotateMode && (!draft || repositioning)));
  const noteUnavailableWhileEditing = editText !== null && (!selectedNote || readOnly);
  const dirty = Boolean(draftText.trim()) || (editText !== null && editText !== selectedNote?.text);
  const nearCharLimit = draftText.length >= MEDIA_ANNOTATION_MAX_LENGTH - 200;

  const requestNoteChange = useCallback(
    (action: () => void) => {
      if (saving || panelBusy) return;
      if (dirty) setDiscard({ action });
      else action();
    },
    [dirty, saving, panelBusy],
  );

  const onSelect = useCallback(() => {
    if (!mainApi) return;
    const index = mainApi.selectedScrollSnap();
    const lockedMoveIndex = movingMediaIndexRef.current;
    if (lockedMoveIndex !== null && index !== lockedMoveIndex) {
      mainApi.scrollTo(lockedMoveIndex, true);
      return;
    }
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
    thumbApi?.scrollTo(targetIndex, true);
    setSelectedIndex(targetIndex);
  }, [initialIndex, mainApi, media.length, thumbApi]);

  useEffect(() => {
    onMediaChange?.(selectedIndex);
  }, [onMediaChange, selectedIndex]);

  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      prevSelectedIndexRef.current = selectedIndex;
      return;
    }
    if (prevSelectedIndexRef.current === selectedIndex) return;
    prevSelectedIndexRef.current = selectedIndex;
    const item = media[selectedIndex];
    if (!item) return;
    setInspectOpen(false);
    setNavAnnouncement(
      copy.activeMediaAnnouncement(
        isVideoMedia(item) ? "video" : "photo",
        selectedIndex + 1,
        media.length,
        item.name,
      ),
    );
  }, [copy, media, selectedIndex]);

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

  const clearNotes = useCallback(() => {
    noteReturnOriginRef.current = null;
    setAnnotateMode(false);
    setMovingId(null);
    setTentativeMove(null);
    setDraft(null);
    setDraftText("");
    setDraftError("");
    setRepositioning(false);
    setEditText(null);
    setConfirmDeleteId(null);
    setOpenId(null);
    setListOpen(false);
    setFocus(null);
    setActionError("");
    setInspectOpen(false);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      requestClose: (onClose) =>
        requestNoteChange(() => {
          clearNotes();
          onClose();
        }),
      focusMedia: (index) =>
        requestNoteChange(() => {
          clearNotes();
          initialTarget.current = index;
          mainApi?.scrollTo(index, true);
        }),
      focusAnnotation: (annotation) =>
        requestNoteChange(() => {
          clearNotes();
          initialTarget.current = annotation.mediaIndex;
          mainApi?.scrollTo(annotation.mediaIndex, true);
          setSelectedIndex(annotation.mediaIndex);
          highlightNote(annotation);
          requestAnimationFrame(() => {
            fieldset.current?.scrollIntoView?.({ block: "nearest" });
          });
        }),
    }),
    [clearNotes, highlightNote, mainApi, requestNoteChange],
  );

  useEffect(() => {
    if (!focus) return;
    const container = fieldset.current;
    if (!container) return;
    container.scrollIntoView?.({ block: "nearest" });
    const pin = container.querySelector<HTMLElement>(`[data-pin-id="${CSS.escape(focus.id)}"]`);
    const details = container.querySelector<HTMLElement>("[data-note-details]");
    if (pin) {
      pin.focus({ preventScroll: true });
    } else if (details) {
      details.focus({ preventScroll: true });
    }
    details?.scrollIntoView?.({ block: "nearest" });
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
  const thumbCarouselOpts = useMemo(
    () => ({ containScroll: "keepSnaps" as const, dragFree: true, inViewThreshold: 0.5 }),
    [],
  );

  const handleVideoTimeChange = useCallback((key: string, time: number) => {
    videoTimesRef.current[key] = time;
  }, []);

  const handleMediaLoadErrorChange = useCallback((key: string, failed: boolean) => {
    setFailedMedia((previous) =>
      previous[key] === failed ? previous : { ...previous, [key]: failed },
    );
  }, []);

  function finishPlacement() {
    setDraft(null);
    setDraftText("");
    setDraftError("");
    setMovingId(null);
    setTentativeMove(null);
    setRepositioning(false);
    setAnnotateMode(false);
    setActionError("");
    requestAnimationFrame(() => addButton.current?.focus({ preventScroll: true }));
  }

  function closeNote() {
    const closingId = openId;
    const groupOrigin =
      closingId && noteReturnOriginRef.current?.noteId === closingId
        ? noteReturnOriginRef.current
        : null;
    noteReturnOriginRef.current = null;
    setConfirmDeleteId(null);
    setOpenId(null);
    setEditText(null);
    requestAnimationFrame(() => {
      const container = fieldset.current;
      if (!container) return;
      let target: HTMLElement | null = null;
      if (closingId && groupOrigin) {
        target =
          findGroupTrigger(container, closingId, groupOrigin.clusterId) ??
          container.querySelector<HTMLElement>(`[data-pin-id="${CSS.escape(closingId)}"]`);
      } else if (closingId) {
        target =
          container.querySelector<HTMLElement>(`[data-pin-id="${CSS.escape(closingId)}"]`) ??
          findGroupTrigger(container, closingId);
      }
      (target || noteListButton.current || addButton.current)?.focus({ preventScroll: true });
    });
  }

  function endRepositioning() {
    setRepositioning(false);
    requestAnimationFrame(() => noteInput.current?.focus({ preventScroll: true }));
  }

  function selectNote(id: string | null, highlight = false, origin?: NoteOpenOrigin) {
    if (mediaLocked && editText === null) return;
    requestNoteChange(() => {
      setEditText(null);
      if (!id) {
        closeNote();
        return;
      }
      if (origin?.source === "group") {
        noteReturnOriginRef.current = { noteId: id, clusterId: origin.clusterId };
      } else {
        noteReturnOriginRef.current = null;
      }
      const note = currentNotes.find((item) => item.id === id);
      if (highlight && note) {
        highlightNote(note);
      } else {
        setOpenId(id);
        if (origin?.source === "group") {
          requestAnimationFrame(() => {
            fieldset.current?.querySelector<HTMLElement>("[data-note-details]")?.focus({ preventScroll: true });
          });
        }
      }
    });
  }

  function beginDraft(target: DraftTarget) {
    setOpenId(null);
    setDraft(target);
    setDraftError("");
    if (repositioning) endRepositioning();
  }

  function startMoving(annotationId: string) {
    if (disabled || readOnly) return;
    const annotation = annotations.find((item) => item.id === annotationId);
    if (!annotation) return;
    mainApi?.scrollTo(annotation.mediaIndex, true);
    setSelectedIndex(annotation.mediaIndex);
    setMovingId(annotationId);
    setTentativeMove(null);
    setAnnotateMode(false);
    setDraft(null);
    setDraftError("");
    setOpenId(null);
    setInspectOpen(false);
    setActionError("");
  }

  async function handleSurfaceClick(target: DraftTarget) {
    if (!placing) return;
    if (!movingId) {
      beginDraft(target);
      return;
    }
    if (moveInFlightRef.current) return;

    const currentMoving = annotations.find((annotation) => annotation.id === movingId);
    if (!currentMoving) {
      setMovingId(null);
      setTentativeMove(null);
      setActionError(t("mediaUnavailable"));
      return;
    }
    if (target.mediaIndex !== currentMoving.mediaIndex) {
      mainApi?.scrollTo(currentMoving.mediaIndex, true);
      setSelectedIndex(currentMoving.mediaIndex);
      setActionError(t("unableMoveComment"));
      return;
    }

    moveInFlightRef.current = true;
    setTentativeMove(target);
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
      setTentativeMove(null);
      highlightNote({
        ...currentMoving,
        x: target.x,
        y: target.y,
        time: target.time ?? currentMoving.time,
      });
    } catch (error) {
      setActionError(localizeError(error, t));
    } finally {
      moveInFlightRef.current = false;
      setSaving(false);
    }
  }

  async function saveDraft() {
    if (
      disabled ||
      readOnly ||
      !draft ||
      repositioning ||
      !draftText.trim() ||
      saving ||
      draftSaveInFlightRef.current
    ) {
      return;
    }
    draftSaveInFlightRef.current = true;
    setSaving(true);
    setDraftError("");
    setActionError("");
    try {
      await onCreateAnnotation({ ...draft, text: draftText.trim() });
      setDraft(null);
      setDraftText("");
      setDraftError("");
      // Leaving the input mounted or refocusing it would reopen the software keyboard.
      if (!workspace || !window.matchMedia("(max-width: 639px)").matches) {
        setAnnotateMode(false);
        requestAnimationFrame(() => addButton.current?.focus({ preventScroll: true }));
      }
    } catch (error) {
      setDraftError(localizeError(error, t));
    } finally {
      draftSaveInFlightRef.current = false;
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

  const modeStatusText = movingId
    ? copy.moveModeStatus
    : activeIsVideo
      ? copy.videoModeStatus
      : copy.imageModeStatus;

  const draftTargetCaption = draft
    ? draft.time !== undefined
      ? copy.videoTargetCaption(draft.mediaIndex + 1, formatClock(draft.time))
      : copy.photoTargetCaption(draft.mediaIndex + 1)
    : null;

  return (
    <fieldset
      ref={fieldset}
      disabled={disabled}
      className={cn(
        "min-w-0 space-y-2",
        workspace && "max-sm:flex max-sm:min-h-0 max-sm:flex-1 max-sm:flex-col max-sm:gap-2 max-sm:space-y-0",
      )}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || discard || confirmingDeletion || inspectOpen || !(mediaLocked || selectedNote)) {
          return;
        }
        // Confirmation dialogs render in portals. Their Escape belongs to that dialog.
        if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        if (repositioning) endRepositioning();
        else requestNoteChange(mediaLocked && editText === null ? finishPlacement : closeNote);
      }}
    >
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {navAnnouncement}
      </span>

      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
        <p className="mr-auto text-sm leading-5 text-muted-foreground">
          {movingId || annotateMode ? (
            <span role="status">{modeStatusText}</span>
          ) : (
            <span className={workspace ? "max-sm:sr-only" : undefined}>
              {selectedIndex + 1} / {media.length}
            </span>
          )}
        </p>
        {!mediaLocked && activeItem && !activeIsVideo && !activeMediaFailed && (
          <Button
            type="button"
            size="touch"
            variant="outline"
            onClick={() => setInspectOpen(true)}
          >
            <ZoomIn aria-hidden="true" />
            {copy.inspectImage}
          </Button>
        )}
        {!mediaLocked && !readOnly && renderImageAction?.(selectedIndex)}
        {repositioning && (
          <Button
            type="button"
            size="touch"
            variant="ghost"
            className="shrink-0"
            onClick={endRepositioning}
          >
            {t("cancelMove")}
          </Button>
        )}
        {!readOnly && (movingId || annotateMode) && !draft && (
          <Button
            type="button"
            size="touch"
            variant="ghost"
            className="shrink-0"
            onClick={() => requestNoteChange(finishPlacement)}
            disabled={saving}
          >
            {t(movingId ? "cancelMove" : "placementDone")}
          </Button>
        )}
        {!readOnly && !mediaLocked && onQuoteMedia && activeItem && (
          <Button
            type="button"
            size="touch"
            variant="outline"
            title={activeItem.name}
            onClick={() => onQuoteMedia(selectedIndex)}
          >
            <MessageCircle aria-hidden="true" />
            {t("threadQuoteFile")}
          </Button>
        )}
        {!readOnly && !mediaLocked && (
          <Button
            type="button"
            size="touch"
            ref={addButton}
            variant="outline"
            onClick={() => {
              setAnnotateMode(true);
              setOpenId(null);
              setListOpen(false);
              setActionError("");
              setDraftError("");
            }}
          >
            <MapPin aria-hidden="true" />
            {t("addPin")}
          </Button>
        )}
        {workspace && !annotateMode && !movingId && !noteUnavailableWhileEditing && currentNotes.length > 0 && (
          <Button
            type="button"
            size="icon-touch"
            ref={noteListButton}
            variant="outline"
            aria-expanded={listOpen}
            aria-label={t("noteListCount", { count: currentNotes.length })}
            title={t("noteListCount", { count: currentNotes.length })}
            onClick={() => setListOpen((open) => !open)}
          >
            <MessageSquareText aria-hidden="true" />
          </Button>
        )}
      </div>

      {actionError ? (
        <p role="alert" className="shrink-0 text-sm text-destructive">
          {actionError}
        </p>
      ) : null}

      <Carousel
        setApi={setMainApi}
        opts={carouselOpts}
        keyboardNavigation={!mediaLocked}
        inertOffscreenSlides
        className={cn(
          "overflow-hidden rounded-lg border bg-black",
          workspace && "max-sm:min-h-14 max-sm:flex-1 max-sm:[&>div:first-child]:h-full",
        )}
      >
        <CarouselContent className={cn("-ml-0", workspace && "max-sm:h-full")}>
          {media.map((item, index) => {
            const Slide = isVideoMedia(item) ? VideoSlide : ImageSlide;
            const isSelected = index === selectedIndex;
            const activeMovingPin =
              repositioning && draft
                ? { id: "draft", x: draft.x, y: draft.y, time: draft.time }
                : tentativeMove && tentativeMove.mediaIndex === index && movingId
                  ? { id: movingId, x: tentativeMove.x, y: tentativeMove.y, time: tentativeMove.time }
                  : movingAnnotation;
            return (
              <CarouselItem
                key={item.key}
                slideIndex={index}
                inert={!isSelected || undefined}
                aria-hidden={!isSelected || undefined}
                className={cn("pl-0", workspace && "max-sm:flex max-sm:h-full max-sm:min-h-0 max-sm:flex-col")}
              >
                {isSelected && (
                  <Slide
                    item={item}
                    index={index}
                    active={isSelected}
                    savedTime={videoTimesRef.current[item.key]}
                    onTimeChange={handleVideoTimeChange}
                    onLoadErrorChange={handleMediaLoadErrorChange}
                    annotations={annotations.filter((note) => note.mediaIndex === index)}
                    annotateMode={placing}
                    movingPin={activeMovingPin}
                    tentativePin={
                      tentativeMove &&
                      tentativeMove.mediaIndex === index &&
                      tentativeMove.x !== undefined &&
                      tentativeMove.y !== undefined
                        ? { x: tentativeMove.x, y: tentativeMove.y }
                        : null
                    }
                    draft={draft?.mediaIndex === index && !repositioning ? draft : null}
                    workspace={workspace}
                    pinsPassive={annotateMode || Boolean(movingId)}
                    focus={focus}
                    openId={openId}
                    onOpenChange={(id, origin) => selectNote(id, false, origin)}
                    onSurfaceClick={handleSurfaceClick}
                  />
                )}
              </CarouselItem>
            );
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
        <Carousel
          className={cn("shrink-0", mediaLocked && "hidden")}
          setApi={setThumbApi}
          inertOffscreenSlides
          opts={thumbCarouselOpts}
        >
          <CarouselContent className="-ml-2">
            {media.map((item, index) => (
              <CarouselItem key={item.key} slideIndex={index} className="basis-1/5 pl-2 sm:basis-1/6">
                <button
                  type="button"
                  onClick={() => mainApi?.scrollTo(index)}
                  disabled={mediaLocked}
                  aria-current={index === selectedIndex ? "true" : undefined}
                  aria-label={t("mediaNumber", { number: index + 1 })}
                  className={cn(
                    "relative block aspect-square w-full overflow-hidden rounded-md border-2 bg-black transition-all",
                    workspace && "max-sm:aspect-auto max-sm:h-11",
                    index === selectedIndex
                      ? "border-primary opacity-100"
                      : "border-transparent opacity-50 hover:opacity-80",
                  )}
                >
                  {isVideoMedia(item) ? (
                    <>
                      <span className="sr-only">{item.name}</span>
                      <PlayCircle
                        aria-hidden="true"
                        className="absolute left-1/2 top-1/2 size-5 -translate-x-1/2 -translate-y-1/2 text-white"
                      />
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

      {noteUnavailableWhileEditing && (
        <div
          className={cn(
            "shrink-0 space-y-2 border-t pt-2",
            workspace && "max-sm:max-h-[calc(100%-4rem)] max-sm:overflow-y-auto",
          )}
        >
          <p role="status" className="text-sm">
            {t(readOnly ? "readOnlyNoteDraft" : "removedNoteDraft")}
          </p>
          <Textarea
            rows={2}
            readOnly
            value={editText}
            aria-label={t("unsavedNoteText")}
            className="min-h-16"
          />
          <Button type="button" size="touch" variant="outline" onClick={() => requestNoteChange(closeNote)}>
            {t("closeNote")}
          </Button>
        </div>
      )}
      {!noteUnavailableWhileEditing && !annotateMode && !movingId && (selectedNote || (listOpen && currentNotes.length > 0)) && (
        <div className={cn("shrink-0", workspace && "max-sm:max-h-[52%] max-sm:overflow-y-auto")}>
          {workspace && listOpen && (
            <ul className="flex max-h-24 flex-wrap gap-1 overflow-y-auto pb-1">
              {currentNotes.map((note) => (
                <li key={note.id}>
                  <Button
                    type="button"
                    size="touch"
                    variant={openId === note.id ? "default" : "outline"}
                    aria-pressed={openId === note.id}
                    onClick={() => selectNote(note.id, true)}
                  >
                    {t("noteLabel", { number: note.label })}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {selectedNote && (
            <PinDetails
              key={selectedNote.id}
              annotation={selectedNote}
              readOnly={readOnly}
              allowDeleteRecovery={allowDeleteRecovery}
              editText={editText}
              setEditText={setEditText}
              onCancelEdit={() => requestNoteChange(() => setEditText(null))}
              onClose={() => requestNoteChange(closeNote)}
              onUpdate={onUpdateAnnotation}
              onMove={startMoving}
              onDelete={onDeleteAnnotation}
              onDeleted={closeNote}
              onBusyChange={setPanelBusy}
              confirmDelete={confirmingDeletion}
              onConfirmDeleteChange={(open) => setConfirmDeleteId(open ? selectedNote.id : null)}
              onQuote={onQuoteAnnotation}
            />
          )}
        </div>
      )}

      {draft && !repositioning && (
        <div
          className={cn(
            "shrink-0 space-y-2 border-t pt-2",
            workspace && "max-sm:max-h-[calc(100%-4rem)] max-sm:overflow-y-auto",
          )}
        >
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            {draftTargetCaption ? <p className="text-sm text-muted-foreground">{draftTargetCaption}</p> : null}
            <span
              role={nearCharLimit ? "status" : undefined}
              className={cn(
                "ml-auto tabular-nums",
                nearCharLimit && "font-medium text-amber-600 dark:text-amber-400",
                draftText.length >= MEDIA_ANNOTATION_MAX_LENGTH && "text-destructive",
              )}
            >
              {copy.characterCount(draftText.length, MEDIA_ANNOTATION_MAX_LENGTH)}
            </span>
          </div>
          <Textarea
            ref={noteInput}
            autoFocus
            aria-label={t("describeIssue")}
            disabled={saving}
            className="min-h-16"
            maxLength={MEDIA_ANNOTATION_MAX_LENGTH}
            rows={2}
            value={draftText}
            onChange={(event) => {
              setDraftText(event.target.value);
              if (draftError) setDraftError("");
            }}
            placeholder={t("describeIssue")}
          />
          {draftError ? (
            <p role="alert" className="text-sm text-destructive">
              {draftError}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-between gap-1">
            <Button
              type="button"
              size="touch"
              variant="ghost"
              disabled={saving}
              onClick={() => {
                noteInput.current?.blur();
                setRepositioning(true);
              }}
            >
              {t("repositionPin")}
            </Button>
            <div className="ml-auto flex gap-1">
              <Button
                type="button"
                variant="ghost"
                size="touch"
                disabled={saving}
                onClick={() => requestNoteChange(finishPlacement)}
              >
                {t("cancel")}
              </Button>
              <Button type="button" size="touch" disabled={!draftText.trim() || saving} onClick={saveDraft}>
                {saving && <Loader2 aria-hidden="true" className="animate-spin" />}
                {t("savePin")}
              </Button>
            </div>
          </div>
        </div>
      )}

      {activeItem && !activeIsVideo && !activeMediaFailed ? (
        <ImageInspectDialog open={inspectOpen} onOpenChange={setInspectOpen} item={activeItem} />
      ) : null}

      <AlertDialog
        open={discard !== null}
        onOpenChange={(open) => {
          if (!open) setDiscard(null);
        }}
        title={t("discardNoteTitle")}
        description={t("discardNoteDescription")}
        confirmLabel={t("discardChanges")}
        onConfirm={() => discard?.action()}
      />
    </fieldset>
  );
});
