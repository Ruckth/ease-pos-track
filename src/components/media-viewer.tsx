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
import { Loader2, MapPin, PlayCircle, Trash2 } from "lucide-react";
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

export type AnnotationDraftInput = {
  mediaIndex: number;
  kind: "point" | "time";
  x?: number;
  y?: number;
  time?: number;
  text: string;
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
    onCreateAnnotation: (input: AnnotationDraftInput) => Promise<void>;
    onDeleteAnnotation: (annotationId: string) => Promise<void>;
  }
>(function MediaViewer({ media, annotations, onCreateAnnotation, onDeleteAnnotation }, ref) {
  const [mainApi, setMainApi] = useState<CarouselApi>();
  const [thumbApi, setThumbApi] = useState<CarouselApi>();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [annotateMode, setAnnotateMode] = useState(false);
  const [draft, setDraft] = useState<DraftTarget | null>(null);
  const [draftText, setDraftText] = useState("");
  const [saving, setSaving] = useState(false);
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

  async function saveDraft() {
    if (!draft || !draftText.trim() || saving) return;
    setSaving(true);
    try {
      await onCreateAnnotation({ ...draft, text: draftText.trim() });
      setDraft(null);
      setDraftText("");
      setAnnotateMode(false);
    } finally {
      setSaving(false);
    }
  }

  if (media.length === 0) {
    return (
      <div className="grid aspect-video place-items-center rounded-lg border border-dashed text-sm text-muted-foreground">
        No media attached
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {selectedIndex + 1} / {media.length}
        </p>
        <Button
          type="button"
          size="sm"
          variant={annotateMode ? "default" : "outline"}
          onClick={() => {
            setAnnotateMode((mode) => !mode);
            setDraft(null);
            setOpenId(null);
          }}
        >
          <MapPin />
          {annotateMode ? "Click the media to place a pin" : "Add pin"}
        </Button>
      </div>

      <Carousel setApi={setMainApi} opts={carouselOpts} className="overflow-hidden rounded-lg border bg-black">
        <CarouselContent className="-ml-0">
          {media.map((item, index) => (
            <CarouselItem key={item.key} className="pl-0">
              {isVideoMedia(item) ? (
                <VideoSlide
                  item={item}
                  index={index}
                  annotations={annotations.filter((a) => a.mediaIndex === index)}
                  annotateMode={annotateMode}
                  draft={draft?.mediaIndex === index ? draft : null}
                  focus={focus}
                  openId={openId}
                  onOpenChange={setOpenId}
                  onSurfaceClick={beginDraft}
                  onDelete={onDeleteAnnotation}
                />
              ) : (
                <ImageSlide
                  item={item}
                  index={index}
                  annotations={annotations.filter((a) => a.mediaIndex === index)}
                  annotateMode={annotateMode}
                  draft={draft?.mediaIndex === index ? draft : null}
                  focus={focus}
                  openId={openId}
                  onOpenChange={setOpenId}
                  onSurfaceClick={beginDraft}
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
                  aria-label={`Show media ${index + 1}`}
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
            New pin on item {draft.mediaIndex + 1}
            {draft.time !== undefined ? ` at ${formatClock(draft.time)}` : ""}
          </p>
          <Textarea
            autoFocus
            rows={2}
            value={draftText}
            onChange={(event) => setDraftText(event.target.value)}
            placeholder="Describe the issue at this spot"
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button type="button" size="sm" disabled={!draftText.trim() || saving} onClick={saveDraft}>
              {saving ? <Loader2 className="animate-spin" /> : null}
              Save pin
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
  onDelete,
}: SlideProps) {
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
  onDelete,
}: SlideProps) {
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
            aria-label="Mark a point on this frame"
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
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      aria-label={`Comment ${annotation.label}: ${annotation.text}`}
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
  onDelete,
}: {
  annotation: Annotation | null;
  onClose: () => void;
  onDelete: (annotationId: string) => Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);

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
        <button
          type="button"
          aria-label={`Delete comment ${annotation.label}`}
          disabled={deleting}
          onClick={async (event) => {
            event.stopPropagation();
            setDeleting(true);
            try {
              await onDelete(annotation.id);
              onClose();
            } finally {
              setDeleting(false);
            }
          }}
          className="text-muted-foreground hover:text-destructive disabled:opacity-50"
        >
          {deleting ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
        </button>
      </div>
      <p className="mt-1.5 whitespace-pre-wrap leading-5">{annotation.text}</p>
      {annotation.time !== undefined ? (
        <p className="mt-1 text-muted-foreground">at {formatClock(annotation.time)}</p>
      ) : null}
    </div>
  );
}
