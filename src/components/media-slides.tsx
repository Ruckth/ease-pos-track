import { useI18n } from "@/lib/i18n";
import { formatClock, type Annotation, type MediaItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

import { DraftPin, PinMarker } from "./annotation-overlays";
import type { DraftTarget, FocusRequest } from "./media-viewer";

type PinPosition = Pick<Annotation, "id" | "x" | "y" | "time">;

type SlideProps = {
  item: MediaItem;
  index: number;
  annotations: Annotation[];
  annotateMode: boolean;
  movingPin?: PinPosition;
  workspace: boolean;
  pinsPassive: boolean;
  draft: DraftTarget | null;
  focus: FocusRequest;
  openId: string | null;
  onOpenChange: (id: string | null) => void;
  onSurfaceClick: (target: DraftTarget) => void;
};

function relativePoint(event: React.MouseEvent, element: Element) {
  const rect = element.getBoundingClientRect();
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return {
    x: clamp((event.clientX - rect.left) / rect.width),
    y: clamp((event.clientY - rect.top) / rect.height),
  };
}

type Point = { x: number; y: number };

/** Keyboard and pointer placements both commit normalized media coordinates. */
function usePinPosition<T extends HTMLElement>(placing: boolean, movingPin?: PinPosition) {
  const { t } = useI18n();
  const surface = useRef<T>(null);
  const [keyboardUsed, setKeyboardUsed] = useState(false);
  const [point, setPoint] = useState<Point>({ x: 0.5, y: 0.5 });
  useEffect(() => {
    if (!placing) return;
    setKeyboardUsed(false);
    setPoint({ x: movingPin?.x ?? 0.5, y: movingPin?.y ?? 0.5 });
    surface.current?.focus({ preventScroll: true });
  }, [placing, movingPin?.id, movingPin?.x, movingPin?.y]);
  function onKeyDown(event: React.KeyboardEvent, commit: (point: Point) => void) {
    const offsets: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
    };
    const offset = offsets[event.key];
    if (offset) {
      event.preventDefault();
      setKeyboardUsed(true);
      const step = event.shiftKey ? 10 : 1;
      const adjust = (value: number, direction: number) => Math.max(0, Math.min(100, Math.round(value * 100) + direction * step)) / 100;
      setPoint(previous => ({ x: adjust(previous.x, offset[0]), y: adjust(previous.y, offset[1]) }));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      commit(point);
    }
  }
  const position = t("pinPosition", { x: Math.round(point.x * 100), y: Math.round(point.y * 100) });
  return { surface, point, position, onKeyDown, keyboardUsed };
}

function PlacementHint({ position }: { position: string }) {
  const { t } = useI18n();
  return <p className="w-full shrink-0 bg-muted px-3 py-2 text-sm text-foreground [@media(pointer:coarse)]:sr-only">
    {t("pinKeyboardHint")} <span role="status">{position}</span>
  </p>;
}

export function ImageSlide({
  item,
  index,
  annotations,
  annotateMode,
  movingPin,
  workspace,
  pinsPassive,
  draft,
  focus,
  openId,
  onOpenChange,
  onSurfaceClick,
}: SlideProps) {
  const { t } = useI18n();
  const placement = usePinPosition<HTMLImageElement>(annotateMode, movingPin);
  return <>
    {annotateMode && <PlacementHint position={placement.position} />}
    <div className={cn("flex h-[42vh] items-center justify-center sm:h-[48vh]", workspace && "max-sm:min-h-0 max-sm:flex-1 max-sm:[container-type:size]")}>
      <div className="relative inline-flex max-h-full max-w-full">
        <img
          src={item.url}
          alt={item.name}
          draggable={false}
          ref={placement.surface}
          data-pin-surface={annotateMode ? true : undefined}
          role={annotateMode ? "button" : undefined}
          aria-label={annotateMode ? t("markPoint") : undefined}
          tabIndex={annotateMode ? 0 : undefined}
          onKeyDown={event => { if (annotateMode) placement.onKeyDown(event, point => onSurfaceClick({ mediaIndex: index, kind: "point", ...point })); }}
          className={cn("max-h-[42vh] max-w-full object-contain sm:max-h-[48vh]", workspace && "max-sm:max-h-[100cqh]", annotateMode && "cursor-crosshair")}
          onClick={(event) => {
            if (!annotateMode) {
              onOpenChange(null);
              return;
            }
            const { x, y } = relativePoint(event, event.currentTarget);
            onSurfaceClick({ mediaIndex: index, kind: "point", x, y });
          }}
        />
        {annotateMode && (placement.keyboardUsed || movingPin || draft) && <DraftPin {...placement.point} />}
        {annotations.map((annotation) =>
          annotation.x === undefined || annotation.y === undefined ? null : (
            <PinMarker
              key={annotation.id}
              annotation={annotation}
              highlighted={focus?.id === annotation.id || openId === annotation.id}
              passive={pinsPassive}
              onClick={() => onOpenChange(openId === annotation.id ? null : annotation.id)}
            />
          ),
        )}
        {draft && draft.x !== undefined && draft.y !== undefined ? <DraftPin x={draft.x} y={draft.y} /> : null}
      </div>
    </div>
  </>;
}

export function VideoSlide({
  item,
  index,
  annotations,
  annotateMode,
  movingPin,
  workspace,
  pinsPassive,
  draft,
  focus,
  openId,
  onOpenChange,
  onSurfaceClick,
}: SlideProps) {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement>(null);
  const placement = usePinPosition<HTMLButtonElement>(annotateMode, movingPin);
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

  useEffect(() => {
    if (!annotateMode || !videoRef.current) return;
    const video = videoRef.current;
    video.pause();
    syncDuration(video);
    if (movingPin?.time !== undefined && duration > 0) {
      video.currentTime = Math.min(movingPin.time, duration);
      setCurrentTime(video.currentTime);
    }
  }, [annotateMode, movingPin?.time, duration]);

  function syncDuration(video: HTMLVideoElement) {
    setDuration(Number.isFinite(video.duration) ? video.duration : 0);
  }

  function place(point: Point) {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    onSurfaceClick({ mediaIndex: index, kind: "time", ...point, time: video.currentTime });
  }

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

  return <>
    {annotateMode && <>
      <PlacementHint position={placement.position} />
      {duration > 0 && <label className="flex shrink-0 items-center gap-2 bg-muted px-3 pb-2 text-sm text-foreground">
        {t("pinAtTime", { time: formatClock(currentTime) })}
        <input type="range" className="min-h-11 min-w-0 flex-1" min={0} max={duration} step={0.1} value={currentTime}
          onChange={event => { if (videoRef.current) videoRef.current.currentTime = Number(event.target.value); }} />
      </label>}
    </>}
    <div className={cn("flex h-[42vh] flex-col items-center justify-center gap-2 py-2 sm:h-[48vh]", workspace && "max-sm:min-h-0 max-sm:flex-1 max-sm:[container-type:size]")}>
      <div className="relative inline-flex max-h-full min-h-0 max-w-full">
        <video
          ref={videoRef}
          src={item.url}
          aria-label={item.name}
          controls={!annotateMode}
          playsInline
          preload="metadata"
          className={cn("max-h-[34vh] max-w-full sm:max-h-[40vh]", workspace && "max-sm:max-h-[calc(100cqh-3.5rem)]")}
          onLoadedMetadata={event => syncDuration(event.currentTarget)}
          onDurationChange={event => syncDuration(event.currentTarget)}
          onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
          onClick={() => {
            if (!annotateMode) onOpenChange(null);
          }}
        />
        {annotateMode ? (
          <button
            type="button"
            data-pin-surface
            ref={placement.surface}
            onKeyDown={event => placement.onKeyDown(event, place)}
            aria-label={t("markPoint")}
            className="absolute inset-0 z-10 cursor-crosshair"
            onClick={(event) => {
              place(event.detail === 0 ? placement.point : relativePoint(event, event.currentTarget));
            }}
          />
        ) : null}
        {annotateMode && (placement.keyboardUsed || movingPin || draft) && <DraftPin {...placement.point} />}
        {annotations.map((annotation) =>
          annotation.x === undefined || annotation.y === undefined || !isPinVisible(annotation) ? null : (
            <PinMarker
              key={annotation.id}
              annotation={annotation}
              highlighted={focus?.id === annotation.id || openId === annotation.id}
              passive={pinsPassive}
              onClick={() => onOpenChange(openId === annotation.id ? null : annotation.id)}
            />
          ),
        )}
        {draft && draft.x !== undefined && draft.y !== undefined ? <DraftPin x={draft.x} y={draft.y} /> : null}
      </div>
      {timeMarks.length > 0 ? (
        <MarkerBar marks={timeMarks} duration={duration} currentTime={currentTime} passive={pinsPassive} onJump={jumpTo} />
      ) : null}
    </div>
  </>;
}

function MarkerBar({
  marks,
  duration,
  currentTime,
  passive,
  onJump,
}: {
  marks: Annotation[];
  duration: number;
  currentTime: number;
  passive: boolean;
  onJump: (annotation: Annotation) => void;
}) {
  const { t } = useI18n();
  const total = duration > 0 ? duration : Math.max(...marks.map((mark) => mark.time ?? 0), 1);

  return (
    <div className="w-full max-w-md px-6">
      <div className="relative h-11">
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/25" />
        <div
          className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/60"
          style={{ width: `${Math.min(100, (currentTime / total) * 100)}%` }}
        />
        {marks.map((mark) => (
          <button
            data-pin-id={mark.id}
            disabled={passive}
            aria-hidden={passive || undefined}
            aria-label={`${t("pinAtTime", { time: formatClock(mark.time ?? 0) })} · ${t("comment", { label: mark.label })}: ${mark.text}`}
            key={mark.id}
            type="button"
            title={`${formatClock(mark.time ?? 0)} — ${mark.text}`}
            onClick={() => onJump(mark)}
            className="absolute top-1/2 flex size-9 [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-1 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white bg-primary text-xs font-bold text-primary-foreground shadow transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            style={{ left: `${Math.min(100, ((mark.time ?? 0) / total) * 100)}%` }}
          >
            {mark.label}
          </button>
        ))}
      </div>
    </div>
  );
}
