import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { EmblaCarouselType } from "embla-carousel";
import { Loader2, MapPin, Move, Pencil, PlayCircle, Trash2, X } from "lucide-react";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
  type CarouselApi,
} from "@/components/ui/carousel";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { formatClock, isVideoMedia, type Annotation, type MediaItem } from "@/lib/types";
import { localizeError, useI18n } from "@/lib/i18n";

export type AnnotationDraftInput = {
  mediaIndex: number;
  kind: "point" | "time";
  x?: number;
  y?: number;
  time?: number;
  text: string;
};

export type AnnotationUpdateInput = {
  annotationId: string;
  text?: string;
  x?: number;
  y?: number;
  time?: number;
};

export type MediaViewerHandle = {
  focusAnnotation: (annotation: Annotation) => void;
};

type DraftTarget = Omit<AnnotationDraftInput, "text">;

type FocusRequest = { id: string; nonce: number } | null;

export const MediaViewer = forwardRef<
  MediaViewerHandle,
  {
    media: MediaItem[];
    annotations: Annotation[];
    initialIndex?: number;
    onCreateAnnotation: (input: AnnotationDraftInput) => Promise<void>;
    onUpdateAnnotation: (input: AnnotationUpdateInput) => Promise<void>;
    onDeleteAnnotation: (annotationId: string) => Promise<void>;
  }
>(function MediaViewer({ media, annotations, initialIndex = 0, onCreateAnnotation, onUpdateAnnotation, onDeleteAnnotation }, ref) {
  const { t } = useI18n();
  const [mainApi, setMainApi] = useState<CarouselApi>();
  const [thumbApi, setThumbApi] = useState<CarouselApi>();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [annotateMode, setAnnotateMode] = useState(false);
  const [draft, setDraft] = useState<DraftTarget | null>(null);
  const [draftText, setDraftText] = useState("");
  const [saving, setSaving] = useState(false);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [focus, setFocus] = useState<FocusRequest>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const annotateModeRef = useRef(annotateMode);
  const focusNonceRef = useRef(0);
  const focusTimerRef = useRef<number | null>(null);

  annotateModeRef.current = annotateMode;

  const onSelect = useCallback(() => {
    if (!mainApi) return;
    const index = mainApi.selectedScrollSnap();
    setSelectedIndex(index);
    thumbApi?.scrollTo(index);
  }, [mainApi, thumbApi]);

  useEffect(() => {
    if (!mainApi) return;
    onSelect();
    mainApi.on("select", onSelect);
    mainApi.on("reInit", onSelect);
    return () => {
      mainApi.off("select", onSelect);
      mainApi.off("reInit", onSelect);
    };
  }, [mainApi, onSelect]);

  useEffect(() => {
    if (!mainApi || media.length === 0) return;
    const targetIndex = Math.min(Math.max(0, initialIndex), media.length - 1);
    mainApi.scrollTo(targetIndex);
    thumbApi?.scrollTo(targetIndex);
    setSelectedIndex(targetIndex);
  }, [initialIndex, mainApi, media.length, thumbApi]);

  useEffect(() => {
    return () => {
      if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      focusAnnotation: (annotation) => {
        mainApi?.scrollTo(annotation.mediaIndex);
        setOpenId(annotation.id);
        focusNonceRef.current += 1;
        setFocus({ id: annotation.id, nonce: focusNonceRef.current });
        if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
        focusTimerRef.current = window.setTimeout(() => setFocus(null), 3000);
      },
    }),
    [mainApi],
  );

  const watchDrag = useCallback(
    (_api: EmblaCarouselType, event: MouseEvent | TouchEvent) => {
      if (media.length <= 1) return false;
      if (annotateModeRef.current) return false;
      const target = event.target as Element | null;
      if (target?.closest("video")) return false;
      return true;
    },
    [media.length],
  );

  const carouselOpts = useMemo(() => ({ watchDrag }), [watchDrag]);

  function beginDraft(target: DraftTarget) {
    setOpenId(null);
    setDraft(target);
    setDraftText("");
  }

  function startMoving(annotationId: string) {
    const annotation = annotations.find((item) => item.id === annotationId);
    if (annotation) mainApi?.scrollTo(annotation.mediaIndex);
    setMovingId(annotationId);
    setAnnotateMode(false);
    setDraft(null);
    setOpenId(null);
    setActionError("");
  }

  async function handleSurfaceClick(target: DraftTarget) {
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
    try {
      await onUpdateAnnotation({
        annotationId: movingId,
        x: target.x,
        y: target.y,
        ...(target.time === undefined ? {} : { time: target.time }),
      });
      setMovingId(null);
    } catch (error) {
      setActionError(localizeError(error, t));
    }
  }

  async function saveDraft() {
    if (!draft || !draftText.trim() || saving) return;
    setSaving(true);
    setActionError("");
    try {
      await onCreateAnnotation({ ...draft, text: draftText.trim() });
      setDraft(null);
      setDraftText("");
      setAnnotateMode(false);
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
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {selectedIndex + 1} / {media.length}
        </p>
        {movingId ? (
          <Button type="button" size="sm" variant="outline" onClick={() => setMovingId(null)}>
            <X />
            {t("cancelMove")}
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant={annotateMode ? "default" : "outline"}
            onClick={() => {
              setAnnotateMode((mode) => !mode);
              setDraft(null);
              setOpenId(null);
              setActionError("");
            }}
          >
            <MapPin />
            {annotateMode ? t("placePin") : t("addPin")}
          </Button>
        )}
      </div>

      {movingId ? <p className="text-sm text-primary">{t("moveComment")}</p> : null}
      {actionError ? <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{actionError}</p> : null}

      <Carousel setApi={setMainApi} opts={carouselOpts} className="overflow-hidden rounded-lg border bg-black">
        <CarouselContent className="-ml-0">
          {media.map((item, index) => (
            <CarouselItem key={item.key} className="pl-0">
              {isVideoMedia(item) ? (
                <VideoSlide
                  item={item}
                  index={index}
                  annotations={annotations.filter((a) => a.mediaIndex === index)}
                  annotateMode={annotateMode || Boolean(movingId)}
                  draft={draft?.mediaIndex === index ? draft : null}
                  focus={focus}
                  openId={openId}
                  onOpenChange={setOpenId}
                  onSurfaceClick={handleSurfaceClick}
                  onUpdate={onUpdateAnnotation}
                  onMove={startMoving}
                  onDelete={onDeleteAnnotation}
                />
              ) : (
                <ImageSlide
                  item={item}
                  index={index}
                  annotations={annotations.filter((a) => a.mediaIndex === index)}
                  annotateMode={annotateMode || Boolean(movingId)}
                  draft={draft?.mediaIndex === index ? draft : null}
                  focus={focus}
                  openId={openId}
                  onOpenChange={setOpenId}
                  onSurfaceClick={handleSurfaceClick}
                  onUpdate={onUpdateAnnotation}
                  onMove={startMoving}
                  onDelete={onDeleteAnnotation}
                />
              )}
            </CarouselItem>
          ))}
        </CarouselContent>
        {media.length > 1 ? (
          <>
            <CarouselPrevious className="left-2 border-none bg-black/50 text-white hover:bg-black/70" />
            <CarouselNext className="right-2 border-none bg-black/50 text-white hover:bg-black/70" />
          </>
        ) : null}
      </Carousel>

      {media.length > 1 ? (
        <Carousel setApi={setThumbApi} opts={{ containScroll: "keepSnaps", dragFree: true }}>
          <CarouselContent className="-ml-2">
            {media.map((item, index) => (
              <CarouselItem key={item.key} className="basis-1/5 pl-2 sm:basis-1/6">
                <button
                  type="button"
                  onClick={() => mainApi?.scrollTo(index)}
                  aria-label={t("mediaNumber", { number: index + 1 })}
                  className={cn(
                    "relative block aspect-square w-full overflow-hidden rounded-md border-2 bg-black transition-all",
                    index === selectedIndex
                      ? "border-primary opacity-100"
                      : "border-transparent opacity-50 hover:opacity-80",
                  )}
                >
                  {isVideoMedia(item) ? (
                    <>
                      <video className="h-full w-full object-cover" src={item.url} muted playsInline preload="metadata" />
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

      {draft ? (
        <div className="space-y-2 rounded-lg border bg-muted/40 p-3">
          <p className="text-xs font-medium text-muted-foreground">
            {t("addPin")} {draft.mediaIndex + 1}
            {draft.time !== undefined ? ` at ${formatClock(draft.time)}` : ""}
          </p>
          <Textarea
            autoFocus
            rows={2}
            value={draftText}
            onChange={(event) => setDraftText(event.target.value)}
            placeholder={t("describeIssue")}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(null)}>
              {t("cancel")}
            </Button>
            <Button type="button" size="sm" disabled={!draftText.trim() || saving} onClick={saveDraft}>
              {saving ? <Loader2 className="animate-spin" /> : null}
              {t("savePin")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
});

type SlideProps = {
  item: MediaItem;
  index: number;
  annotations: Annotation[];
  annotateMode: boolean;
  draft: DraftTarget | null;
  focus: FocusRequest;
  openId: string | null;
  onOpenChange: (id: string | null) => void;
  onSurfaceClick: (target: DraftTarget) => void;
  onUpdate: (input: AnnotationUpdateInput) => Promise<void>;
  onMove: (annotationId: string) => void;
  onDelete: (annotationId: string) => Promise<void>;
};

function relativePoint(event: React.MouseEvent, element: Element) {
  const rect = element.getBoundingClientRect();
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return {
    x: clamp((event.clientX - rect.left) / rect.width),
    y: clamp((event.clientY - rect.top) / rect.height),
  };
}

function ImageSlide({
  item,
  index,
  annotations,
  annotateMode,
  draft,
  focus,
  openId,
  onOpenChange,
  onSurfaceClick,
  onUpdate,
  onMove,
  onDelete,
}: SlideProps) {
  const { t } = useI18n();
  return (
    <div className="flex h-[42vh] items-center justify-center sm:h-[48vh]">
      <div className="relative inline-flex max-h-full max-w-full">
        <img
          src={item.url}
          alt={item.name}
          draggable={false}
          className={cn("max-h-[42vh] max-w-full object-contain sm:max-h-[48vh]", annotateMode && "cursor-crosshair")}
          onClick={(event) => {
            if (!annotateMode) {
              onOpenChange(null);
              return;
            }
            const { x, y } = relativePoint(event, event.currentTarget);
            onSurfaceClick({ mediaIndex: index, kind: "point", x, y });
          }}
        />
        {annotations.map((annotation) =>
          annotation.x === undefined || annotation.y === undefined ? null : (
            <PinMarker
              key={annotation.id}
              annotation={annotation}
              highlighted={focus?.id === annotation.id}
              onClick={() => onOpenChange(openId === annotation.id ? null : annotation.id)}
            />
          ),
        )}
        {draft && draft.x !== undefined && draft.y !== undefined ? <DraftPin x={draft.x} y={draft.y} /> : null}
        <PinPopover
          annotation={annotations.find((annotation) => annotation.id === openId) ?? null}
          onClose={() => onOpenChange(null)}
          onUpdate={onUpdate}
          onMove={onMove}
          onDelete={onDelete}
        />
      </div>
    </div>
  );
}

function VideoSlide({
  item,
  index,
  annotations,
  annotateMode,
  draft,
  focus,
  openId,
  onOpenChange,
  onSurfaceClick,
  onUpdate,
  onMove,
  onDelete,
}: SlideProps) {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);

  const timeMarks = useMemo(
    () =>
      annotations
        .filter((annotation) => annotation.time !== undefined)
        .sort((a, b) => (a.time ?? 0) - (b.time ?? 0)),
    [annotations],
  );

  useEffect(() => {
    if (!focus) return;
    const target = annotations.find((annotation) => annotation.id === focus.id);
    if (!target || target.time === undefined) return;
    const video = videoRef.current;
    if (!video) return;
    const seekTo = target.time;
    const applySeek = () => {
      video.currentTime = duration > 0 ? Math.min(seekTo, duration) : seekTo;
      video.pause();
      setCurrentTime(seekTo);
    };
    if (video.readyState >= 1) {
      applySeek();
      return;
    }
    video.addEventListener("loadedmetadata", applySeek, { once: true });
    return () => video.removeEventListener("loadedmetadata", applySeek);
  }, [focus, annotations, duration]);

  function jumpTo(annotation: Annotation) {
    const video = videoRef.current;
    if (!video || annotation.time === undefined) return;
    video.currentTime = annotation.time;
    video.pause();
    setCurrentTime(annotation.time);
    onOpenChange(annotation.id);
  }

  const isPinVisible = (annotation: Annotation) =>
    annotation.time === undefined ||
    Math.abs(currentTime - annotation.time) < 0.8 ||
    focus?.id === annotation.id ||
    openId === annotation.id;

  return (
    <div className="flex h-[42vh] flex-col items-center justify-center gap-2 py-2 sm:h-[48vh]">
      <div className="relative inline-flex max-h-full min-h-0 max-w-full">
        <video
          ref={videoRef}
          src={item.url}
          controls={!annotateMode}
          playsInline
          preload="metadata"
          className="max-h-[34vh] max-w-full sm:max-h-[40vh]"
          onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
          onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
          onClick={() => {
            if (!annotateMode) onOpenChange(null);
          }}
        />
        {annotateMode ? (
          <button
            type="button"
            aria-label={t("markPoint")}
            className="absolute inset-0 z-10 cursor-crosshair"
            onClick={(event) => {
              const video = videoRef.current;
              if (!video) return;
              video.pause();
              const { x, y } = relativePoint(event, event.currentTarget);
              onSurfaceClick({ mediaIndex: index, kind: "time", x, y, time: video.currentTime });
            }}
          />
        ) : null}
        {annotations.map((annotation) =>
          annotation.x === undefined || annotation.y === undefined || !isPinVisible(annotation) ? null : (
            <PinMarker
              key={annotation.id}
              annotation={annotation}
              highlighted={focus?.id === annotation.id}
              onClick={() => onOpenChange(openId === annotation.id ? null : annotation.id)}
            />
          ),
        )}
        {draft && draft.x !== undefined && draft.y !== undefined ? <DraftPin x={draft.x} y={draft.y} /> : null}
        <PinPopover
          annotation={annotations.find((annotation) => annotation.id === openId) ?? null}
          onClose={() => onOpenChange(null)}
          onUpdate={onUpdate}
          onMove={onMove}
          onDelete={onDelete}
        />
      </div>
      {timeMarks.length > 0 ? (
        <MarkerBar marks={timeMarks} duration={duration} currentTime={currentTime} onJump={jumpTo} />
      ) : null}
    </div>
  );
}

function MarkerBar({
  marks,
  duration,
  currentTime,
  onJump,
}: {
  marks: Annotation[];
  duration: number;
  currentTime: number;
  onJump: (annotation: Annotation) => void;
}) {
  const { t } = useI18n();
  const total = duration > 0 ? duration : Math.max(...marks.map((mark) => mark.time ?? 0), 1);

  return (
    <div className="w-full max-w-md px-6">
      <div className="relative h-7">
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/25" />
        <div
          className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/60"
          style={{ width: `${Math.min(100, (currentTime / total) * 100)}%` }}
        />
        {marks.map((mark) => (
          <button
            key={mark.id}
            type="button"
            title={`${formatClock(mark.time ?? 0)} — ${mark.text}`}
            onClick={() => onJump(mark)}
            className="absolute top-1/2 flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white bg-primary text-[10px] font-bold text-primary-foreground shadow hover:scale-110"
            style={{ left: `${Math.min(100, ((mark.time ?? 0) / total) * 100)}%` }}
          >
            {mark.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function PinMarker({
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
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      aria-label={`${t("comment", { label: annotation.label })}: ${annotation.text}`}
      className={cn(
        "absolute z-10 flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white bg-primary text-[11px] font-bold text-primary-foreground shadow-md transition-transform hover:scale-110",
        highlighted && "scale-125 ring-4 ring-amber-400/80",
      )}
      style={{ left: `${(annotation.x ?? 0) * 100}%`, top: `${(annotation.y ?? 0) * 100}%` }}
    >
      {annotation.label}
    </button>
  );
}

function DraftPin({ x, y }: { x: number; y: number }) {
  return (
    <span
      className="pointer-events-none absolute z-10 flex size-6 -translate-x-1/2 -translate-y-1/2 animate-pulse items-center justify-center rounded-full border-2 border-dashed border-white bg-primary/70 text-[11px] font-bold text-primary-foreground shadow-md"
      style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
    >
      +
    </span>
  );
}

function PinPopover({
  annotation,
  onClose,
  onUpdate,
  onMove,
  onDelete,
}: {
  annotation: Annotation | null;
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

  useEffect(() => {
    setEditing(false);
    setError("");
  }, [annotation?.id]);

  if (!annotation || annotation.x === undefined || annotation.y === undefined) return null;

  const below = annotation.y <= 0.6;
  const left = Math.min(0.82, Math.max(0.18, annotation.x));

  return (
    <div
      className="absolute z-20 w-52 rounded-md border bg-background p-2.5 text-xs shadow-lg"
      style={{
        left: `${left * 100}%`,
        top: `${annotation.y * 100}%`,
        transform: below ? "translate(-50%, 18px)" : "translate(-50%, calc(-100% - 18px))",
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
          {annotation.label}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label={t("editComment", { label: annotation.label })}
            onClick={() => {
              setEditText(annotation.text);
              setEditing(true);
              setError("");
            }}
            className="text-muted-foreground hover:text-primary"
          >
            <Pencil className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label={t("moveComment")}
            onClick={() => {
              onMove(annotation.id);
              onClose();
            }}
            className="text-muted-foreground hover:text-primary"
          >
            <Move className="size-3.5" />
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
            className="text-muted-foreground hover:text-destructive disabled:opacity-50"
          >
            {deleting ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
          </button>
        </div>
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
