import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useI18n } from "@/lib/i18n";
import { groupTimeMarks, mediaUxCopy } from "@/lib/media-ux-copy";
import { formatClock, type Annotation, type MediaItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import { AlertCircle, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { DraftPin, PinMarker } from "./annotation-overlays";
import type { DraftTarget, FocusRequest, NoteOpenOrigin } from "./media-viewer";

type PinPosition = Pick<Annotation, "id" | "x" | "y" | "time">;

type SlideProps = {
  item: MediaItem;
  index: number;
  active?: boolean;
  savedTime?: number;
  onTimeChange?: (key: string, time: number) => void;
  onLoadErrorChange?: (key: string, failed: boolean) => void;
  annotations: Annotation[];
  annotateMode: boolean;
  movingPin?: PinPosition;
  tentativePin?: { x: number; y: number } | null;
  workspace: boolean;
  pinsPassive: boolean;
  draft: DraftTarget | null;
  focus: FocusRequest;
  openId: string | null;
  onOpenChange: (id: string | null, origin?: NoteOpenOrigin) => void;
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
  const [keyboardFocused, setKeyboardFocused] = useState(false);
  const [point, setPoint] = useState<Point>({ x: 0.5, y: 0.5 });

  useEffect(() => {
    if (!placing) {
      setKeyboardFocused(false);
      return;
    }
    setKeyboardUsed(false);
    setPoint({ x: movingPin?.x ?? 0.5, y: movingPin?.y ?? 0.5 });
    surface.current?.focus({ preventScroll: true });
  }, [placing, movingPin?.id, movingPin?.x, movingPin?.y]);

  function onFocus(event: React.FocusEvent<T>) {
    try {
      setKeyboardFocused(event.currentTarget.matches(":focus-visible"));
    } catch {
      setKeyboardFocused(false);
    }
  }

  function onBlur() {
    setKeyboardFocused(false);
  }

  function onKeyDown(event: React.KeyboardEvent, commit: (point: Point) => void) {
    const offsets: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const offset = offsets[event.key];
    if (offset) {
      event.preventDefault();
      setKeyboardUsed(true);
      const step = event.shiftKey ? 10 : 1;
      const adjust = (value: number, direction: number) =>
        Math.max(0, Math.min(100, Math.round(value * 100) + direction * step)) / 100;
      setPoint((previous) => ({
        x: adjust(previous.x, offset[0]),
        y: adjust(previous.y, offset[1]),
      }));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      commit(point);
    }
  }

  const position = t("pinPosition", { x: Math.round(point.x * 100), y: Math.round(point.y * 100) });
  return { surface, point, position, onKeyDown, onFocus, onBlur, keyboardUsed, keyboardFocused };
}

function PlacementHint({ position }: { position: string }) {
  const { t } = useI18n();
  return (
    <p className="w-full shrink-0 bg-muted px-3 py-2 text-sm text-foreground [@media(pointer:coarse)]:sr-only">
      {t("pinKeyboardHint")} <span role="status">{position}</span>
    </p>
  );
}

function MediaLoadFallback({ name, onRetry }: { name: string; onRetry: () => void }) {
  const { language } = useI18n();
  const copy = mediaUxCopy(language);
  return (
    <div
      role="alert"
      className="flex max-w-sm flex-col items-center justify-center gap-3 px-6 py-8 text-center text-white"
    >
      <AlertCircle className="size-7 text-amber-300" aria-hidden="true" />
      <div className="space-y-1">
        <p className="text-sm font-medium [overflow-wrap:anywhere]">{name}</p>
        <p className="text-xs text-white/80">{copy.mediaLoadFailed}</p>
      </div>
      <Button
        type="button"
        size="touch"
        variant="secondary"
        onClick={onRetry}
      >
        <RotateCcw aria-hidden="true" />
        {copy.retryFile}
      </Button>
    </div>
  );
}

export function ImageSlide({
  item,
  index,
  onLoadErrorChange,
  annotations,
  annotateMode,
  movingPin,
  tentativePin,
  workspace,
  pinsPassive,
  draft,
  focus,
  openId,
  onOpenChange,
  onSurfaceClick,
}: SlideProps) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    setFailed(false);
    setRetryKey(0);
    onLoadErrorChange?.(item.key, false);
  }, [item.key, item.url, onLoadErrorChange]);

  const effectiveAnnotate = annotateMode && !failed;
  const placement = usePinPosition<HTMLImageElement>(effectiveAnnotate, movingPin);

  function retry() {
    setFailed(false);
    setRetryKey((count) => count + 1);
    onLoadErrorChange?.(item.key, false);
  }

  return (
    <>
      {effectiveAnnotate && <PlacementHint position={placement.position} />}
      <div
        className={cn(
          "flex h-[42vh] items-center justify-center p-2 sm:h-[48vh]",
          workspace && "max-sm:min-h-0 max-sm:flex-1 max-sm:[container-type:size]",
        )}
      >
        {failed ? (
          <MediaLoadFallback name={item.name} onRetry={retry} />
        ) : (
          <div className="relative inline-flex max-h-full max-w-full">
            <img
              key={retryKey}
              src={item.url}
              alt={item.name}
              draggable={false}
              ref={placement.surface}
              data-pin-surface={effectiveAnnotate ? true : undefined}
              role={effectiveAnnotate ? "button" : undefined}
              aria-label={effectiveAnnotate ? t("markPoint") : undefined}
              tabIndex={effectiveAnnotate ? 0 : undefined}
              onFocus={effectiveAnnotate ? placement.onFocus : undefined}
              onBlur={effectiveAnnotate ? placement.onBlur : undefined}
              onLoad={() => {
                if (failed) setFailed(false);
                onLoadErrorChange?.(item.key, false);
              }}
              onError={() => {
                setFailed(true);
                onLoadErrorChange?.(item.key, true);
              }}
              onKeyDown={(event) => {
                if (effectiveAnnotate) {
                  placement.onKeyDown(event, (point) =>
                    onSurfaceClick({ mediaIndex: index, kind: "point", ...point }),
                  );
                }
              }}
              className={cn(
                "max-h-[calc(42vh-1rem)] max-w-full object-contain sm:max-h-[calc(48vh-1rem)]",
                workspace && "max-sm:max-h-[100cqh]",
                effectiveAnnotate && "cursor-crosshair",
              )}
              onClick={(event) => {
                if (!effectiveAnnotate) {
                  onOpenChange(null);
                  return;
                }
                const { x, y } = relativePoint(event, event.currentTarget);
                onSurfaceClick({ mediaIndex: index, kind: "point", x, y });
              }}
            />
            {effectiveAnnotate &&
              (placement.keyboardUsed || placement.keyboardFocused || movingPin || draft) &&
              !tentativePin && <DraftPin {...placement.point} />}
            {tentativePin ? <DraftPin x={tentativePin.x} y={tentativePin.y} /> : null}
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
            {draft && draft.x !== undefined && draft.y !== undefined ? (
              <DraftPin x={draft.x} y={draft.y} />
            ) : null}
          </div>
        )}
      </div>
    </>
  );
}

export function VideoSlide({
  item,
  index,
  active = true,
  savedTime,
  onTimeChange,
  onLoadErrorChange,
  annotations,
  annotateMode,
  movingPin,
  tentativePin,
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
  const [failed, setFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const effectiveAnnotate = annotateMode && !failed;
  const placement = usePinPosition<HTMLButtonElement>(effectiveAnnotate, movingPin);
  const [duration, setDuration] = useState(0);
  const videoArea = useRef<HTMLDivElement>(null);
  const [videoRatio, setVideoRatio] = useState(16 / 9);
  const [videoWidth, setVideoWidth] = useState(0);
  const [currentTime, setCurrentTime] = useState(savedTime ?? 0);
  const restoredSavedTimeRef = useRef(false);
  const onTimeChangeRef = useRef(onTimeChange);
  onTimeChangeRef.current = onTimeChange;
  const itemKeyRef = useRef(item.key);
  itemKeyRef.current = item.key;

  useEffect(() => {
    setFailed(false);
    setRetryKey(0);
    restoredSavedTimeRef.current = false;
    onLoadErrorChange?.(item.key, false);
  }, [item.key, item.url, onLoadErrorChange]);

  useEffect(() => {
    const video = videoRef.current;
    if (!active && video) {
      video.pause();
      onTimeChangeRef.current?.(itemKeyRef.current, video.currentTime);
    }
  }, [active]);

  useEffect(() => {
    const video = videoRef.current;
    return () => {
      if (video) {
        video.pause();
        onTimeChangeRef.current?.(itemKeyRef.current, video.currentTime);
      }
    };
  }, [item.key, retryKey]);

  useLayoutEffect(() => {
    const area = videoArea.current;
    if (!workspace || !area) return;
    // Keep the playback and pin surface aligned as the timeline takes space.
    const measure = () => setVideoWidth(Math.min(area.clientWidth, area.clientHeight * videoRatio));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    return () => observer.disconnect();
  }, [workspace, videoRatio]);

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
      const clamped = duration > 0 ? Math.min(seekTo, duration) : seekTo;
      video.currentTime = clamped;
      video.pause();
      setCurrentTime(clamped);
      onTimeChangeRef.current?.(itemKeyRef.current, clamped);
      restoredSavedTimeRef.current = true;
    };
    if (video.readyState >= 1) {
      applySeek();
      return;
    }
    video.addEventListener("loadedmetadata", applySeek, { once: true });
    return () => video.removeEventListener("loadedmetadata", applySeek);
  }, [focus, annotations, duration]);

  const syncDuration = useCallback(
    (video: HTMLVideoElement) => {
      const nextDuration = Number.isFinite(video.duration) ? video.duration : 0;
      setDuration(nextDuration);
      if (video.videoWidth && video.videoHeight) setVideoRatio(video.videoWidth / video.videoHeight);
      if (
        !restoredSavedTimeRef.current &&
        !focus &&
        savedTime !== undefined &&
        savedTime > 0 &&
        nextDuration > 0
      ) {
        restoredSavedTimeRef.current = true;
        const clamped = Math.min(savedTime, nextDuration);
        video.currentTime = clamped;
        video.pause();
        setCurrentTime(clamped);
      }
    },
    [focus, savedTime],
  );

  useEffect(() => {
    if (!effectiveAnnotate || !videoRef.current) return;
    const video = videoRef.current;
    video.pause();
    syncDuration(video);
    if (movingPin?.time !== undefined && duration > 0) {
      video.currentTime = Math.min(movingPin.time, duration);
      setCurrentTime(video.currentTime);
    }
  }, [effectiveAnnotate, movingPin?.time, duration, syncDuration]);

  function place(point: Point) {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    onSurfaceClick({ mediaIndex: index, kind: "time", ...point, time: video.currentTime });
  }

  function jumpTo(annotation: Annotation, origin?: NoteOpenOrigin) {
    if (annotation.time === undefined) return;
    const video = videoRef.current;
    if (video) {
      video.currentTime = annotation.time;
      video.pause();
    }
    setCurrentTime(annotation.time);
    onTimeChangeRef.current?.(item.key, annotation.time);
    onOpenChange(annotation.id, origin);
  }

  function retry() {
    setFailed(false);
    setRetryKey((count) => count + 1);
    onLoadErrorChange?.(item.key, false);
  }

  const isPinVisible = (annotation: Annotation) =>
    annotation.time === undefined ||
    Math.abs(currentTime - annotation.time) < 0.8 ||
    focus?.id === annotation.id ||
    openId === annotation.id;

  return (
    <>
      {effectiveAnnotate && (
        <>
          <PlacementHint position={placement.position} />
          {duration > 0 && (
            <label className="flex shrink-0 items-center gap-2 bg-muted px-3 pb-2 text-sm text-foreground">
              {t("pinAtTime", { time: formatClock(currentTime) })}
              <input
                type="range"
                className="min-h-11 min-w-0 flex-1"
                min={0}
                max={duration}
                step={0.1}
                value={currentTime}
                aria-valuetext={formatClock(currentTime)}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setCurrentTime(next);
                  if (videoRef.current) videoRef.current.currentTime = next;
                  onTimeChangeRef.current?.(item.key, next);
                }}
              />
            </label>
          )}
        </>
      )}
      <div
        className={cn(
          "flex min-h-[42vh] flex-col items-center justify-center gap-2 p-2 sm:min-h-[48vh]",
          workspace && "max-sm:min-h-0 max-sm:flex-1 max-sm:overflow-y-auto",
        )}
      >
        {failed ? (
          <MediaLoadFallback name={item.name} onRetry={retry} />
        ) : (
          <>
            <div
              ref={videoArea}
              className={cn(
                "contents",
                workspace && "max-sm:grid max-sm:min-h-0 max-sm:w-full max-sm:flex-1 max-sm:place-items-center",
              )}
            >
              <div
                className={cn(
                  "relative inline-flex max-h-full min-h-0 max-w-full",
                  workspace && "max-sm:w-[var(--video-width)] max-sm:aspect-[var(--video-ratio)]",
                )}
                style={
                  workspace
                    ? ({ "--video-ratio": videoRatio, "--video-width": `${videoWidth}px` } as CSSProperties)
                    : undefined
                }
              >
                <video
                  key={retryKey}
                  ref={videoRef}
                  src={item.url}
                  aria-label={item.name}
                  controls={!pinsPassive}
                  playsInline
                  preload="metadata"
                  className={cn(
                    "max-h-[34vh] max-w-full sm:max-h-[40vh]",
                    workspace && "max-sm:size-full max-sm:max-h-none max-sm:object-contain",
                  )}
                  onLoadedMetadata={(event) => {
                    if (failed) setFailed(false);
                    onLoadErrorChange?.(item.key, false);
                    syncDuration(event.currentTarget);
                  }}
                  onDurationChange={(event) => syncDuration(event.currentTarget)}
                  onTimeUpdate={(event) => {
                    const next = event.currentTarget.currentTime;
                    setCurrentTime(next);
                    onTimeChangeRef.current?.(item.key, next);
                  }}
                  onError={() => {
                    setFailed(true);
                    onLoadErrorChange?.(item.key, true);
                  }}
                  onClick={() => {
                    if (!effectiveAnnotate) onOpenChange(null);
                  }}
                />
                {effectiveAnnotate ? (
                  <button
                    type="button"
                    data-pin-surface
                    ref={placement.surface}
                    onFocus={placement.onFocus}
                    onBlur={placement.onBlur}
                    onKeyDown={(event) => placement.onKeyDown(event, place)}
                    aria-label={t("markPoint")}
                    className="absolute inset-0 z-10 cursor-crosshair"
                    onClick={(event) => {
                      place(event.detail === 0 ? placement.point : relativePoint(event, event.currentTarget));
                    }}
                  />
                ) : null}
                {effectiveAnnotate &&
                  (placement.keyboardUsed || placement.keyboardFocused || movingPin || draft) &&
                  !tentativePin && <DraftPin {...placement.point} />}
                {tentativePin ? <DraftPin x={tentativePin.x} y={tentativePin.y} /> : null}
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
                {draft && draft.x !== undefined && draft.y !== undefined ? (
                  <DraftPin x={draft.x} y={draft.y} />
                ) : null}
              </div>
            </div>
            {timeMarks.length > 0 ? (
              <MarkerBar
                marks={timeMarks}
                duration={duration}
                currentTime={currentTime}
                passive={pinsPassive}
                onJump={jumpTo}
              />
            ) : null}
          </>
        )}
      </div>
    </>
  );
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
  onJump: (annotation: Annotation, origin?: NoteOpenOrigin) => void;
}) {
  const { t, language } = useI18n();
  const copy = mediaUxCopy(language);
  const [openClusterId, setOpenClusterId] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const total = duration > 0 ? duration : Math.max(...marks.map((mark) => mark.time ?? 0), 1);
  const clusters = useMemo(() => groupTimeMarks(marks, total), [marks, total]);
  const openCluster = !passive ? clusters.find((cluster) => cluster.id === openClusterId && cluster.marks.length > 1) : null;

  useEffect(() => {
    if (passive) setOpenClusterId(null);
  }, [passive]);

  function closeCluster(clusterId: string) {
    setOpenClusterId(null);
    requestAnimationFrame(() => {
      barRef.current
        ?.querySelector<HTMLButtonElement>(`[data-pin-group="${CSS.escape(clusterId)}"]`)
        ?.focus({ preventScroll: true });
    });
  }

  return (
    <div
      ref={barRef}
      className="w-full max-w-md space-y-1.5 px-6"
      onKeyDown={(event) => {
        if (event.key === "Escape" && openCluster) {
          event.preventDefault();
          event.stopPropagation();
          closeCluster(openCluster.id);
        }
      }}
    >
      <div className="relative h-11">
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/25" />
        <div
          className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/60"
          style={{ width: `${Math.min(100, (currentTime / total) * 100)}%` }}
        />
        {clusters.map((cluster) => {
          if (cluster.marks.length === 1) {
            const mark = cluster.marks[0];
            return (
              <button
                data-pin-id={mark.id}
                disabled={passive}
                aria-hidden={passive || undefined}
                aria-label={`${t("pinAtTime", { time: formatClock(mark.time ?? 0) })} · ${t("comment", { label: mark.label })}: ${mark.text}`}
                key={mark.id}
                type="button"
                title={`${formatClock(mark.time ?? 0)} — ${mark.text}`}
                onClick={() => onJump(mark)}
                className="absolute top-1/2 flex size-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white bg-primary text-xs font-bold text-primary-foreground shadow transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-1"
                style={{ left: `${cluster.percent}%` }}
              >
                {mark.label}
              </button>
            );
          }

          const expanded = openCluster?.id === cluster.id;
          const timeText = formatClock(cluster.time);
          return (
            <button
              key={cluster.id}
              data-pin-group={cluster.id}
              data-pin-group-ids={cluster.marks.map((mark) => mark.id).join(" ")}
              disabled={passive}
              aria-hidden={passive || undefined}
              aria-expanded={expanded}
              aria-label={copy.groupedNotesButton(cluster.marks.length, timeText)}
              type="button"
              title={copy.groupedNotesButton(cluster.marks.length, timeText)}
              onClick={() => setOpenClusterId((current) => (current === cluster.id ? null : cluster.id))}
              className={cn(
                "absolute top-1/2 flex h-9 min-w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white bg-primary px-2 text-xs font-bold text-primary-foreground shadow transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-1",
                expanded && "ring-2 ring-amber-400",
              )}
              style={{ left: `${cluster.percent}%` }}
            >
              +{cluster.marks.length}
            </button>
          );
        })}
      </div>

      {openCluster ? (
        <div
          role="region"
          aria-label={copy.groupedNotesHeading(openCluster.marks.length, formatClock(openCluster.time))}
          className="rounded-lg border border-white/20 bg-zinc-900/95 p-2 text-white shadow-lg"
        >
          <div className="mb-1 flex items-center justify-between gap-2 px-1">
            <span className="text-xs font-medium text-white/80">
              {copy.groupedNotesHeading(openCluster.marks.length, formatClock(openCluster.time))}
            </span>
            <button
              type="button"
              aria-label={copy.closeGroup}
              onClick={() => closeCluster(openCluster.id)}
              className="inline-flex size-8 items-center justify-center rounded-md text-white/80 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>
          <ul className="max-h-36 space-y-1 overflow-y-auto">
            {openCluster.marks.map((mark) => (
              <li key={mark.id}>
                <button
                  type="button"
                  data-pin-id={mark.id}
                  onClick={() => {
                    const clusterId = openCluster.id;
                    setOpenClusterId(null);
                    onJump(mark, { source: "group", clusterId });
                  }}
                  className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-white hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                >
                  <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-primary font-bold text-primary-foreground">
                    {mark.label}
                  </span>
                  <span className="shrink-0 font-mono text-white/75">
                    {formatClock(mark.time ?? 0)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{mark.text}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

const ZOOM_STEPS = [0.5, 0.75, 1, 1.5, 2, 3] as const;

export function ImageInspectDialog({
  open,
  onOpenChange,
  item,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: MediaItem;
}) {
  const { language } = useI18n();
  const copy = mediaUxCopy(language);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"fit" | "zoom">("fit");
  const [scale, setScale] = useState(1);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    setMode("fit");
    setScale(1);
  }, [open, item.key]);

  function resetView() {
    setMode("fit");
    setScale(1);
    if (viewportRef.current) {
      viewportRef.current.scrollTo({ top: 0, left: 0 });
    }
  }

  function setActualSize() {
    setMode("zoom");
    setScale(1);
  }

  function stepZoom(direction: 1 | -1) {
    if (mode === "fit") {
      setMode("zoom");
      setScale(direction > 0 ? 1 : 0.75);
      return;
    }
    const index = ZOOM_STEPS.findIndex((value) => value >= scale - 0.001);
    const currentIndex = index < 0 ? ZOOM_STEPS.length - 1 : index;
    const nextIndex = Math.min(ZOOM_STEPS.length - 1, Math.max(0, currentIndex + direction));
    setScale(ZOOM_STEPS[nextIndex]);
  }

  const zoomedStyle: CSSProperties | undefined =
    mode === "zoom" && naturalSize
      ? {
          width: `${Math.round(naturalSize.width * scale)}px`,
          height: `${Math.round(naturalSize.height * scale)}px`,
        }
      : mode === "zoom"
        ? { width: `${Math.round(scale * 100)}%` }
        : undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={copy.inspectDialogTitle(item.name)}
      placement="fullscreen"
      mobileWorkspace
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <Button
            type="button"
            size="touch"
            variant="outline"
            aria-label={copy.zoomOut}
            disabled={mode === "zoom" && scale <= ZOOM_STEPS[0]}
            onClick={() => stepZoom(-1)}
          >
            <ZoomOut aria-hidden="true" />
          </Button>
          <Button
            type="button"
            size="touch"
            variant={mode === "zoom" && scale === 1 ? "default" : "outline"}
            aria-pressed={mode === "zoom" && scale === 1}
            onClick={setActualSize}
          >
            {copy.zoomActual}
          </Button>
          <Button
            type="button"
            size="touch"
            variant="outline"
            aria-label={copy.zoomIn}
            disabled={mode === "zoom" && scale >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}
            onClick={() => stepZoom(1)}
          >
            <ZoomIn aria-hidden="true" />
          </Button>
          <Button
            type="button"
            size="touch"
            variant="outline"
            disabled={mode === "fit"}
            onClick={resetView}
          >
            <RotateCcw aria-hidden="true" />
            {copy.zoomReset}
          </Button>
          <span role="status" className="ml-auto text-xs font-medium text-muted-foreground">
            {copy.zoomLevel(Math.round(scale * 100), mode)}
          </span>
        </div>

        <div
          ref={viewportRef}
          className={cn(
            "min-h-[60dvh] flex-1 overflow-auto rounded-lg border bg-black p-2",
            mode === "fit" && "flex items-center justify-center",
          )}
        >
          <img
            src={item.url}
            alt={item.name}
            draggable={false}
            onLoad={(event) => {
              const image = event.currentTarget;
              if (image.naturalWidth > 0 && image.naturalHeight > 0) {
                setNaturalSize({ width: image.naturalWidth, height: image.naturalHeight });
              }
            }}
            style={zoomedStyle}
            className={cn(
              mode === "fit" ? "max-h-full max-w-full object-contain" : "block max-w-none shrink-0",
            )}
          />
        </div>
      </div>
    </Dialog>
  );
}
