import {
  MARKUP_CIRCLE_COLOR, MARKUP_CIRCLE_HALO_COLOR, MARKUP_CIRCLE_HALO_EXTRA, MARKUP_MASK_COLOR, type MarkupMark, type MarkupRect,
} from "@/lib/image-markup";
import type { MarkupLabels } from "@/lib/markup-labels";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ZoomControls } from "./image-markup-controls";

export type MarkupTool = "select" | "pan" | "circle" | "crop" | "mask" | "erase";
export type MarkupPoint = { x: number; y: number };
export type MarkupPin = MarkupPoint & { label: number };
type Side = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const SIDES: Exclude<Side, "move">[] = ["nw", "n", "ne", "w", "e", "sw", "s", "se"];
const DRAG_THRESHOLD = 6; // CSS px before a press becomes a drag

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Moves (side "move") or resizes one edge/corner of a rect, kept inside the image and at least `min` px. */
export function adjustRect<T extends MarkupRect>(m: T, side: Side, dx: number, dy: number, W: number, H: number, min: number): T {
  if (side === "move") return { ...m, x: clamp(m.x + dx, 0, W - m.width), y: clamp(m.y + dy, 0, H - m.height) };
  const x = side.includes("w") ? clamp(m.x + dx, 0, m.x + m.width - min) : m.x;
  const y = side.includes("n") ? clamp(m.y + dy, 0, m.y + m.height - min) : m.y;
  const right = side.includes("e") ? clamp(m.x + m.width + dx, x + min, W) : m.x + m.width;
  const bottom = side.includes("s") ? clamp(m.y + m.height + dy, y + min, H) : m.y + m.height;
  return { ...m, x, y, width: right - x, height: bottom - y };
}

const inside = (m: MarkupRect, p: MarkupPoint, pad = 0) =>
  p.x >= m.x - pad && p.y >= m.y - pad && p.x <= m.x + m.width + pad && p.y <= m.y + m.height + pad;

/** Topmost circle or mask under the point; the crop frame only near its edge. */
export function hitMark(marks: readonly MarkupMark[], p: MarkupPoint, edgePad: number, includeCrop: boolean) {
  for (const kind of ["mask", "circle"] as const) {
    for (let i = marks.length - 1; i >= 0; i--) {
      const m = marks[i];
      if (m.kind !== kind || !inside(m, p)) continue;
      if (kind === "mask") return m;
      const nx = (p.x - m.x - m.width / 2) / (m.width / 2), ny = (p.y - m.y - m.height / 2) / (m.height / 2);
      if (nx * nx + ny * ny <= 1.15) return m;
    }
  }
  const crop = marks.find((m) => m.kind === "crop");
  if (includeCrop && crop && inside(crop, p, edgePad) && !inside(crop, p, -edgePad)) return crop;
  return undefined;
}

function handlePoint(m: MarkupRect, side: Exclude<Side, "move">) {
  return {
    x: m.x + (side.includes("w") ? 0 : side.includes("e") ? m.width : m.width / 2),
    y: m.y + (side.includes("n") ? 0 : side.includes("s") ? m.height : m.height / 2),
  };
}

const rectFrom = (a: MarkupPoint, b: MarkupPoint): MarkupRect => ({
  x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y),
});

/** Zoom stops in CSS px per source px; 100% shows real pixels, 400% makes one pixel easy to hit. */
const ZOOM_STOPS = [0.1, 0.25, 0.5, 1, 2, 4];
const MAX_DETAIL = 4;
const MAX_LAYOUT_EDGE = 60_000; // CSS px guard for extremely long images
type ZoomView = "fit" | "width" | number;

/**
 * Fit / fit-width / stepped zoom for a scrollable viewport showing a W×H source.
 * Zoom changes keep the viewport centre on the same source point.
 */
export function useMarkupZoom(W: number, H: number) {
  const viewport = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ZoomView>("fit");
  const [box, setBox] = useState({ width: 0, maxHeight: 220 });
  const anchor = useRef<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const measure = () => setBox((b) => {
      const width = Math.max(120, el.clientWidth), maxHeight = Math.max(220, Math.round(window.innerHeight * 0.55));
      return b.width === width && b.maxHeight === maxHeight ? b : { width, maxHeight };
    });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, []);

  useEffect(() => { setView("fit"); }, [W, H]);

  const fitScale = Math.min(box.width / W, box.maxHeight / H, 2);
  const widthScale = Math.max(fitScale, Math.min(box.width / W, 2));
  const maxScale = Math.max(widthScale, Math.min(MAX_DETAIL, MAX_LAYOUT_EDGE / Math.max(W, H)));
  const scale = clamp(view === "fit" ? fitScale : view === "width" ? widthScale : view, fitScale, maxScale) || 1;
  const display = { width: Math.max(1, Math.round(W * scale)), height: Math.max(1, Math.round(H * scale)) };

  useLayoutEffect(() => {
    const el = viewport.current, a = anchor.current;
    anchor.current = null;
    if (!el || !a) return;
    el.scrollLeft = a.x * scale - el.clientWidth / 2;
    el.scrollTop = a.y * scale - el.clientHeight / 2;
  }, [scale]);

  function zoomTo(next: ZoomView) {
    const el = viewport.current;
    if (el) {
      const ox = Math.max(0, (el.clientWidth - display.width) / 2), oy = Math.max(0, (el.clientHeight - display.height) / 2);
      anchor.current = { x: (el.scrollLeft + el.clientWidth / 2 - ox) / scale, y: (el.scrollTop + el.clientHeight / 2 - oy) / scale };
    }
    setView(next);
  }
  const eps = 1e-6;
  return {
    viewport, view, scale, display, maxHeight: box.maxHeight,
    percent: Math.round(scale * 100),
    canZoomIn: scale < maxScale - eps,
    canZoomOut: scale > fitScale + eps,
    zoomIn: () => zoomTo(Math.min(maxScale, ZOOM_STOPS.find((z) => z > scale * 1.01) ?? maxScale)),
    zoomOut: () => {
      const next = [...ZOOM_STOPS].reverse().find((z) => z < scale * 0.99);
      zoomTo(next === undefined || next <= fitScale + eps ? "fit" : next);
    },
    fit: () => zoomTo("fit"),
    fitWidth: () => zoomTo("width"),
  };
}
export type MarkupZoom = ReturnType<typeof useMarkupZoom>;

/** Exact exported bytes, zoomable and natively scrollable (touch swipe, wheel, arrow keys). */
export function ImageMarkupPreview({ url, alt, width, height, labels, onLoad, onError }: {
  url: string; alt: string; width: number; height: number; labels: MarkupLabels;
  onLoad: (width: number, height: number) => void; onError: () => void;
}) {
  const zoom = useMarkupZoom(width || 1, height || 1);
  const known = width > 0 && height > 0;
  return (
    <div className="grid gap-2">
      {known && <ZoomControls zoom={zoom} labels={labels} />}
      <div
        ref={zoom.viewport}
        tabIndex={0}
        role="region"
        aria-label={labels.previewRegion}
        className="w-full overflow-auto overscroll-contain rounded-md border bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{ maxHeight: zoom.maxHeight + 2 }}
      >
        <img
          src={url}
          alt={alt}
          className={known ? "mx-auto block max-w-none" : "mx-auto block h-auto max-h-[55dvh] max-w-full object-contain"}
          style={known ? zoom.display : undefined}
          onLoad={(event) => onLoad(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)}
          onError={onError}
        />
      </div>
    </div>
  );
}

type Gesture =
  | { kind: "adjust"; pointerId: number; start: MarkupPoint; target: MarkupMark; side: Side }
  | { kind: "press"; pointerId: number; start: MarkupPoint; client: MarkupPoint; dragging: boolean }
  | { kind: "pan"; origin: MarkupPoint; scroll: MarkupPoint };

export function ImageMarkupCanvas({
  image, marks, selectedId, tool, pins, corner, minSize, labels,
  onSelect, onCommit, onPlace, onRect, onErase, onMoveSelected, onEscape,
}: {
  image: ImageBitmap;
  marks: readonly MarkupMark[];
  selectedId: number | null;
  tool: MarkupTool;
  pins: readonly MarkupPin[];
  corner: MarkupPoint | null;
  minSize: number;
  labels: MarkupLabels;
  onSelect: (id: number | null) => void;
  /** A finished move/resize drag: one undo step. */
  onCommit: (mark: MarkupMark) => void;
  onPlace: (point: MarkupPoint) => void;
  onRect: (rect: MarkupRect) => void;
  onErase: (mark: MarkupMark) => void;
  onMoveSelected: (dx: number, dy: number) => void;
  onEscape: () => void;
}) {
  const W = image.width, H = image.height;
  const zoom = useMarkupZoom(W, H);
  const { viewport, scale, display } = zoom;
  const canvas = useRef<HTMLCanvasElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const touches = useRef(new Map<number, MarkupPoint>());
  const [win, setWin] = useState({ left: 0, top: 0, width: 1, height: 1 });
  const [live, setLive] = useState<MarkupMark | null>(null);
  const [dragRect, setDragRect] = useState<MarkupRect | null>(null);
  const [cursor, setCursor] = useState<MarkupPoint | null>(null);
  const unit = 1 / scale; // source px per CSS px

  // The raster covers only the visible window of the zoomed image, so memory stays
  // viewport-sized however long the screenshot or deep the zoom.
  function syncWindow() {
    const el = viewport.current;
    if (!el) return;
    const width = Math.min(el.clientWidth, display.width), height = Math.min(el.clientHeight, display.height);
    const left = clamp(el.scrollLeft, 0, display.width - width), top = clamp(el.scrollTop, 0, display.height - height);
    setWin((w) => (w.left === left && w.top === top && w.width === width && w.height === height ? w : { left, top, width, height }));
  }
  const syncRef = useRef(syncWindow);
  syncRef.current = syncWindow;
  useLayoutEffect(() => { syncRef.current(); }, [display.width, display.height, zoom.maxHeight]);

  const dpr = Math.min(2, typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);
  const rasterW = Math.max(1, Math.round(win.width * dpr)), rasterH = Math.max(1, Math.round(win.height * dpr));
  useLayoutEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    // Crisp pixels when zoomed in for detail; smooth when scaled down.
    ctx.imageSmoothingEnabled = scale < 2;
    ctx.imageSmoothingQuality = "high";
    ctx.clearRect(0, 0, rasterW, rasterH);
    ctx.drawImage(image, win.left / scale, win.top / scale, win.width / scale, win.height / scale, 0, 0, rasterW, rasterH);
  }, [image, scale, win, rasterW, rasterH]);

  // Touch browsers can retarget a compatibility click after the controls reflow.
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const stop = (event: TouchEvent) => event.preventDefault();
    el.addEventListener("touchend", stop, { passive: false });
    return () => el.removeEventListener("touchend", stop);
  }, []);

  useEffect(() => { setCursor(null); }, [tool]);

  // Esc first cancels a pending corner, drag or keyboard cursor. Window capture runs before the
  // dialog's own Escape handling, so the outer Dialog stays open for that press.
  const pending = useRef({ corner, cursor, onEscape });
  pending.current = { corner, cursor, onEscape };
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const { corner: c, cursor: k, onEscape: escape } = pending.current;
      if (!c && !k && !gesture.current) return;
      event.preventDefault();
      event.stopPropagation();
      gesture.current = null;
      setLive(null);
      setDragRect(null);
      setCursor(null);
      escape();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  /** Scrolls the least distance that brings a source rect into view (its start if it can't fit). */
  const reveal = useRef((_r: MarkupRect) => {});
  reveal.current = (r: MarkupRect) => {
    const el = viewport.current;
    if (!el) return;
    const pad = 16;
    const axis = (start: number, size: number, pos: number, client: number, total: number) => {
      if (total <= client) return pos;
      const a = start * scale, b = (start + size) * scale;
      if (b - a + 2 * pad <= client) return a - pad < pos ? a - pad : b + pad > pos + client ? b + pad - client : pos;
      return b < pos || a > pos + client ? a - pad : pos;
    };
    const left = axis(r.x, r.width, el.scrollLeft, el.clientWidth, display.width);
    const top = axis(r.y, r.height, el.scrollTop, el.clientHeight, display.height);
    if (left !== el.scrollLeft || top !== el.scrollTop) el.scrollTo({ left, top });
  };
  const selectedMark = marks.find((m) => m.id === selectedId);
  const revealKey = selectedMark ? `${selectedMark.id}:${selectedMark.x},${selectedMark.y},${selectedMark.width},${selectedMark.height}` : "";
  const selectedMarkRef = useRef(selectedMark);
  selectedMarkRef.current = selectedMark;
  useEffect(() => {
    const m = selectedMarkRef.current;
    if (m && !gesture.current) reveal.current(m);
  }, [revealKey]);
  useEffect(() => {
    if (cursor) reveal.current({ x: cursor.x, y: cursor.y, width: 0, height: 0 });
  }, [cursor]);

  const pointAt = (event: { clientX: number; clientY: number }): MarkupPoint => {
    const r = svg.current!.getBoundingClientRect();
    return {
      x: clamp(Math.round(((event.clientX - r.left) * W) / r.width), 0, W),
      y: clamp(Math.round(((event.clientY - r.top) * H) / r.height), 0, H),
    };
  };

  const shown = live ? marks.map((m) => (m.id === live.id ? live : m)) : marks;
  const selected = shown.find((m) => m.id === selectedId) ?? null;
  const edgePad = 12 * unit;

  function startPan() {
    const el = viewport.current!;
    let x = 0, y = 0;
    for (const t of touches.current.values()) { x += t.x; y += t.y; }
    const n = Math.max(1, touches.current.size);
    gesture.current = { kind: "pan", origin: { x: x / n, y: y / n }, scroll: { x: el.scrollLeft, y: el.scrollTop } };
  }

  function down(event: PointerEvent<SVGSVGElement>) {
    if (event.button !== 0) return;
    touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.currentTarget.setPointerCapture(event.pointerId);
    // A second finger turns any gesture into a view pan; nothing from the first finger is applied.
    if (touches.current.size > 1) { setLive(null); setDragRect(null); startPan(); return; }
    if (!event.isPrimary || gesture.current) return;
    const p = pointAt(event);
    event.currentTarget.focus({ preventScroll: true });
    if (tool === "pan") startPan();
    else if (tool === "select") {
      const handle = (event.target as Element).closest("[data-handle]")?.getAttribute("data-handle") as Side | null;
      const target = handle && selected ? selected : hitMark(marks, p, edgePad, true);
      onSelect(target?.id ?? null);
      if (target) gesture.current = { kind: "adjust", pointerId: event.pointerId, start: p, target, side: handle ?? "move" };
    } else {
      gesture.current = { kind: "press", pointerId: event.pointerId, start: p, client: { x: event.clientX, y: event.clientY }, dragging: false };
    }
  }

  function move(event: PointerEvent<SVGSVGElement>) {
    if (touches.current.has(event.pointerId)) touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "pan") {
      const el = viewport.current!;
      let x = 0, y = 0;
      for (const t of touches.current.values()) { x += t.x; y += t.y; }
      const n = Math.max(1, touches.current.size);
      el.scrollLeft = g.scroll.x - (x / n - g.origin.x);
      el.scrollTop = g.scroll.y - (y / n - g.origin.y);
      return;
    }
    if (g.pointerId !== event.pointerId) return;
    const p = pointAt(event);
    if (g.kind === "adjust") {
      setLive(adjustRect(g.target, g.side, p.x - g.start.x, p.y - g.start.y, W, H, minSize));
    } else if (tool === "crop" || tool === "mask") {
      if (!g.dragging && Math.hypot(event.clientX - g.client.x, event.clientY - g.client.y) < DRAG_THRESHOLD) return;
      g.dragging = true;
      setDragRect(rectFrom(g.start, p));
    }
  }

  function up(event: PointerEvent<SVGSVGElement>) {
    touches.current.delete(event.pointerId);
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "pan") {
      // Re-anchor on the remaining finger(s) so lifting one doesn't jump the view.
      if (touches.current.size) startPan(); else gesture.current = null;
      return;
    }
    if (g.pointerId !== event.pointerId) return;
    gesture.current = null;
    const p = pointAt(event);
    setLive(null);
    setDragRect(null);
    if (g.kind === "adjust") {
      const next = adjustRect(g.target, g.side, p.x - g.start.x, p.y - g.start.y, W, H, minSize);
      if (next.x !== g.target.x || next.y !== g.target.y || next.width !== g.target.width || next.height !== g.target.height) onCommit(next);
    } else if (g.dragging) onRect(rectFrom(g.start, p));
    else if (tool === "erase") { const hit = hitMark(marks, p, edgePad, false); if (hit) onErase(hit); }
    else onPlace(p);
  }

  function cancel(event: PointerEvent<SVGSVGElement>) {
    touches.current.delete(event.pointerId);
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "pan" && touches.current.size) { startPan(); return; }
    if (g.kind !== "pan" && g.pointerId !== event.pointerId) return;
    gesture.current = null;
    setLive(null);
    setDragRect(null);
  }

  function key(event: KeyboardEvent<SVGSVGElement>) {
    if (!event.metaKey && !event.ctrlKey) {
      const zoomKey = { "+": zoom.zoomIn, "=": zoom.zoomIn, "-": zoom.zoomOut, "0": zoom.fit }[event.key];
      if (zoomKey) { event.preventDefault(); zoomKey(); return; }
    }
    const dirs: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const dir = dirs[event.key];
    const activate = event.key === "Enter" || event.key === " ";
    if (!dir && !activate) return;
    event.preventDefault();
    if (tool === "pan") {
      const el = viewport.current;
      if (dir && el) el.scrollBy({ left: dir[0] * el.clientWidth * (event.shiftKey ? 0.8 : 0.2), top: dir[1] * el.clientHeight * (event.shiftKey ? 0.8 : 0.2) });
      return;
    }
    // One screen pixel per press (one source pixel once zoomed to 100%+); Alt is always one source pixel.
    const step = event.altKey ? 1 : Math.max(1, Math.round(unit)) * (event.shiftKey ? 10 : 1);
    if (dir && tool === "select" && selected && !cursor) { onMoveSelected(dir[0] * step, dir[1] * step); return; }
    const at = cursor ?? { x: Math.round(W / 2), y: Math.round(H / 2) };
    if (dir) { setCursor({ x: clamp(at.x + dir[0] * step, 0, W), y: clamp(at.y + dir[1] * step, 0, H) }); return; }
    if (tool === "select") { onSelect(hitMark(marks, at, edgePad, true)?.id ?? null); setCursor(null); }
    else if (tool === "erase") { const hit = hitMark(marks, at, edgePad, false); if (hit) onErase(hit); }
    else onPlace(at);
    if (!cursor) setCursor(at);
  }

  const crop = shown.find((m) => m.kind === "crop");
  const s = (px: number) => px * unit; // CSS px → source px
  const handleSize = s(10), handleHit = s(32);

  return (
    <div className="grid gap-2">
      <ZoomControls zoom={zoom} labels={labels} />
      <div
        ref={viewport}
        className="w-full overflow-auto overscroll-contain rounded-md border bg-muted"
        style={{ maxHeight: zoom.maxHeight + 2 }}
        onScroll={syncWindow}
      >
        <div className="relative mx-auto" style={display}>
          <canvas
            ref={canvas} width={rasterW} height={rasterH} aria-hidden="true"
            className="absolute block" style={{ left: win.left, top: win.top, width: win.width, height: win.height }}
          />
          <svg
            ref={svg}
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className="absolute inset-0 size-full touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            style={{ cursor: tool === "pan" ? "grab" : tool === "select" ? "default" : "crosshair" }}
            tabIndex={0}
            role="application"
            aria-label={labels.canvasLabel}
            aria-describedby="image-markup-keyboard-hint"
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={cancel}
            onLostPointerCapture={cancel}
            onKeyDown={key}
            onBlur={() => setCursor(null)}
          >
            {shown.filter((m) => m.kind === "circle").map((m) => (
              <g key={m.id} pointerEvents="none">
                <ellipse cx={m.x + m.width / 2} cy={m.y + m.height / 2} rx={m.width / 2} ry={m.height / 2} fill="none" stroke={MARKUP_CIRCLE_HALO_COLOR} strokeWidth={m.stroke + MARKUP_CIRCLE_HALO_EXTRA} />
                <ellipse cx={m.x + m.width / 2} cy={m.y + m.height / 2} rx={m.width / 2} ry={m.height / 2} fill="none" stroke={MARKUP_CIRCLE_COLOR} strokeWidth={m.stroke} />
              </g>
            ))}
            {shown.filter((m) => m.kind === "mask").map((m) => (
              <rect key={m.id} x={m.x} y={m.y} width={m.width} height={m.height} fill={MARKUP_MASK_COLOR} pointerEvents="none" />
            ))}
            {crop && (
              <g pointerEvents="none">
                <path fillRule="evenodd" fill="rgba(18,34,41,.5)" d={`M0 0H${W}V${H}H0Z M${crop.x} ${crop.y}h${crop.width}v${crop.height}h${-crop.width}Z`} />
                <rect x={crop.x} y={crop.y} width={crop.width} height={crop.height} fill="none" stroke="#22835c" strokeWidth={s(2)} />
              </g>
            )}
            {pins.map((pin) => (
              <g key={pin.label} pointerEvents="none" aria-hidden="true">
                <circle cx={pin.x} cy={pin.y} r={s(11)} fill="#1d4ed8" stroke="white" strokeWidth={s(2)} />
                <text x={pin.x} y={pin.y} dy="0.35em" textAnchor="middle" fontSize={s(12)} fontWeight={700} fill="white">{pin.label}</text>
              </g>
            ))}
            {dragRect && (
              <rect x={dragRect.x} y={dragRect.y} width={dragRect.width} height={dragRect.height} fill={tool === "mask" ? "rgba(24,35,48,.6)" : "none"} stroke="#13714d" strokeWidth={s(1.5)} strokeDasharray={`${s(4)} ${s(3)}`} pointerEvents="none" />
            )}
            {selected && (tool === "select" || tool === "pan") && (
              <g>
                <rect x={selected.x} y={selected.y} width={selected.width} height={selected.height} fill="none" stroke="#13714d" strokeWidth={s(1.5)} strokeDasharray={`${s(4)} ${s(3)}`} pointerEvents="none" />
                {tool === "select" && SIDES.map((side) => {
                  const h = handlePoint(selected, side);
                  return (
                    <g key={side} data-handle={side} style={{ cursor: `${side}-resize` }}>
                      <rect x={h.x - handleHit / 2} y={h.y - handleHit / 2} width={handleHit} height={handleHit} fill="transparent" />
                      <rect x={h.x - handleSize / 2} y={h.y - handleSize / 2} width={handleSize} height={handleSize} fill="white" stroke="#13714d" strokeWidth={s(1.5)} />
                    </g>
                  );
                })}
              </g>
            )}
            {[corner, cursor].filter((p): p is MarkupPoint => !!p).map((p, i) => (
              <g key={i} pointerEvents="none">
                <rect x={p.x - s(5)} y={p.y - s(5)} width={s(10)} height={s(10)} fill="none" stroke="white" strokeWidth={s(3)} />
                <rect x={p.x - s(5)} y={p.y - s(5)} width={s(10)} height={s(10)} fill="none" stroke="#008951" strokeWidth={s(1.5)} />
              </g>
            ))}
          </svg>
        </div>
      </div>
    </div>
  );
}
