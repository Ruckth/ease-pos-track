import type { AnnotationUpdateInput } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { formatClock, type Annotation, type MediaItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

import { DraftPin, PinMarker, PinPopover } from "./annotation-overlays";
import type { DraftTarget, FocusRequest } from "./media-viewer";

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

export function ImageSlide({
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
          key={openId}
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

export function VideoSlide({
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
          key={openId}
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
      <div className="relative h-9">
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
            className="absolute top-1/2 flex size-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white bg-primary text-xs font-bold text-primary-foreground shadow transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            style={{ left: `${Math.min(100, ((mark.time ?? 0) / total) * 100)}%` }}
          >
            {mark.label}
          </button>
        ))}
      </div>
    </div>
  );
}
