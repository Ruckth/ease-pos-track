import { Button } from "@/components/ui/button";
import type { MarkupMark } from "@/lib/image-markup";
import type { MarkupLabels } from "@/lib/markup-labels";
import { cn } from "@/lib/utils";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Circle, Crop, Eraser, Hand, Minus, MousePointer2, MoveHorizontal, Plus, Redo2, Shrink, Square, Undo2 } from "lucide-react";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { MarkupTool, MarkupZoom } from "./image-markup-canvas";
import { useWheelResize } from "./image-markup-wheel";

export type StrokeChoice = "thin" | "medium" | "thick";

/** Pressed tools, modes and panels stay neutral: blue is kept for the one primary action. */
const PRESSED = "aria-pressed:border-foreground/45 aria-pressed:bg-none aria-pressed:bg-foreground/[.07] aria-pressed:text-foreground aria-pressed:shadow-[inset_0_0_0_1px_hsl(var(--foreground)/0.45)]";
export const EXPANDED = "aria-expanded:border-foreground/45 aria-expanded:bg-none aria-expanded:bg-foreground/[.07] aria-expanded:text-foreground aria-expanded:shadow-[inset_0_0_0_1px_hsl(var(--foreground)/0.45)]";

const TOOL_ICONS: Record<MarkupTool, ReactNode> = {
  select: <MousePointer2 aria-hidden="true" />,
  pan: <Hand aria-hidden="true" />,
  circle: <Circle aria-hidden="true" />,
  crop: <Crop aria-hidden="true" />,
  mask: <Square aria-hidden="true" className="fill-current" />,
  erase: <Eraser aria-hidden="true" />,
};

/** All six tools on every screen size: icon over a short label on phones, icon beside the full name above. */
export function ImageMarkupToolbar({ tool, labels, onTool, disabled }: {
  tool: MarkupTool; labels: MarkupLabels; onTool: (tool: MarkupTool) => void; disabled?: boolean;
}) {
  const tools: Array<[MarkupTool, string, string]> = [
    ["select", labels.select, labels.select],
    ["pan", labels.pan, labels.panShort],
    ["circle", labels.circle, labels.circle],
    ["crop", labels.crop, labels.crop],
    ["mask", labels.mask, labels.maskShort],
    ["erase", labels.eraser, labels.eraser],
  ];
  return (
    <div role="group" aria-label={labels.tools} className="grid shrink-0 grid-cols-[repeat(auto-fit,minmax(2.75rem,1fr))] gap-1 sm:flex sm:flex-wrap sm:gap-1.5">
      {tools.map(([value, label, short]) => (
        <Button
          key={value} type="button" size="touch" variant="outline" disabled={disabled}
          aria-label={label} aria-pressed={tool === value}
          className={cn(
            "min-w-0 sm:px-3 max-sm:h-14 max-sm:flex-col max-sm:gap-0.5 max-sm:px-0.5 max-sm:text-[11px] max-sm:font-normal max-sm:leading-tight max-sm:[&_svg]:size-5 max-sm:aria-pressed:font-semibold [@media(pointer:coarse)]:min-w-0",
            PRESSED,
          )}
          onClick={() => onTool(value)}
        >
          {TOOL_ICONS[value]}
          <span aria-hidden="true" className="max-w-full truncate sm:hidden">{short}</span>
          <span aria-hidden="true" className="max-sm:hidden">{label}</span>
        </Button>
      ))}
    </div>
  );
}

export function HistoryControls({ labels, canUndo, canRedo, onUndo, onRedo }: {
  labels: MarkupLabels; canUndo: boolean; canRedo: boolean; onUndo: () => void; onRedo: () => void;
}) {
  return (
    <div className="ms-auto flex gap-1 sm:gap-1.5">
      <Button type="button" size="icon-touch" variant="outline" aria-label={labels.undo} title={labels.undo} disabled={!canUndo} onClick={onUndo}><Undo2 aria-hidden="true" /></Button>
      <Button type="button" size="icon-touch" variant="outline" aria-label={labels.redo} title={labels.redo} disabled={!canRedo} onClick={onRedo}><Redo2 aria-hidden="true" /></Button>
    </div>
  );
}

/** Zoom out / level / zoom in, fit width and fit image (named on wider screens), then optional actions such as Undo/Redo. */
export function ZoomControls({ zoom, labels, actions }: { zoom: MarkupZoom; labels: MarkupLabels; actions?: ReactNode }) {
  const fits: Array<["width" | "fit", string, ReactNode, () => void]> = [
    ["width", labels.fitWidth, <MoveHorizontal aria-hidden="true" />, zoom.fitWidth],
    ["fit", labels.fitImage, <Shrink aria-hidden="true" />, zoom.fit],
  ];
  return (
    <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-1 sm:gap-1.5">
      <div role="group" aria-label={labels.view} className="flex min-w-0 flex-wrap items-center gap-1 sm:gap-1.5">
        <div className="aurora-control flex h-11 min-w-0 items-center overflow-hidden rounded-lg">
          <Button type="button" size="icon-touch" variant="ghost" className="rounded-none border-0 focus-visible:ring-inset focus-visible:ring-offset-0" aria-label={labels.zoomOut} disabled={!zoom.canZoomOut} onClick={zoom.zoomOut}><Minus aria-hidden="true" /></Button>
          <output className="w-12 shrink-0 border-x border-border/70 text-center text-sm leading-6 tabular-nums" aria-label={labels.zoomLevel}>{zoom.percent}%</output>
          <Button type="button" size="icon-touch" variant="ghost" className="rounded-none border-0 focus-visible:ring-inset focus-visible:ring-offset-0" aria-label={labels.zoomIn} disabled={!zoom.canZoomIn} onClick={zoom.zoomIn}><Plus aria-hidden="true" /></Button>
        </div>
        {fits.map(([view, label, icon, onClick]) => (
          <Button
            key={view} type="button" size="touch" variant="outline" aria-pressed={zoom.view === view} title={label}
            className={cn("px-0 sm:px-3", PRESSED)} onClick={onClick}
          >
            {icon}<span className="max-sm:sr-only">{label}</span>
          </Button>
        ))}
      </div>
      {actions}
    </div>
  );
}

/**
 * Whole source pixels. Typing commits on Enter or blur (one undo step);
 * ArrowUp/ArrowDown commit ±1 (Shift ±10) immediately.
 */
function PixelField({ label, value, min, max, onCommit }: { label: string; value: number; min: number; max: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    const n = Math.round(Number(draft));
    if (draft.trim() !== "" && Number.isFinite(n)) {
      const next = Math.min(max, Math.max(min, n));
      if (next !== value) onCommit(next);
    }
  };
  return (
    <span className="inline-flex items-center gap-1">
      <input
        type="number" inputMode="numeric" step={1} min={min} max={max}
        aria-label={`${label} (px)`}
        className="aurora-control h-11 w-20 rounded-lg border bg-background px-2 text-center text-sm tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        value={draft ?? value}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); commit(); return; }
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault();
          setDraft(null);
          const next = Math.min(max, Math.max(min, value + (event.key === "ArrowUp" ? 1 : -1) * (event.shiftKey ? 10 : 1)));
          if (next !== value) onCommit(next);
        }}
      />
      <span aria-hidden="true" className="text-sm text-muted-foreground">px</span>
    </span>
  );
}

function Stepper({ label, value, min, max, less, more, onLess, onMore, onSet }: {
  label: string; value: number; min: number; max: number; less: string; more: string;
  onLess: () => void; onMore: () => void; onSet: (value: number) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={label}>
      <span className="w-16 shrink-0 text-sm text-muted-foreground lg:w-full">{label}</span>
      <Button type="button" size="icon-touch" variant="outline" aria-label={`${label}: ${less}`} onClick={onLess}><Minus aria-hidden="true" /></Button>
      <PixelField label={label} value={value} min={min} max={max} onCommit={onSet} />
      <Button type="button" size="icon-touch" variant="outline" aria-label={`${label}: ${more}`} onClick={onMore}><Plus aria-hidden="true" /></Button>
    </div>
  );
}

function StrokePicker({ value, labels, onChange }: { value: StrokeChoice | null; labels: MarkupLabels; onChange: (choice: StrokeChoice) => void }) {
  const choices: Array<[StrokeChoice, string, string]> = [["thin", labels.thin, "border-b"], ["medium", labels.medium, "border-b-2"], ["thick", labels.thick, "border-b-4"]];
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={labels.outline}>
      <span className="w-16 shrink-0 text-sm text-muted-foreground lg:w-full">{labels.outline}</span>
      {choices.map(([choice, label, line]) => (
        <Button key={choice} type="button" size="touch" className={cn("px-2.5", PRESSED)} variant="outline" aria-pressed={value === choice} onClick={() => onChange(choice)}>
          <span aria-hidden="true" className={cn("w-4 border-current", line)} />{label}
        </Button>
      ))}
    </div>
  );
}

export type MarkupField = "x" | "y" | "width" | "height";

export type CircleSizing = {
  /** Width in source px; height follows proportionally. */
  value: number; min: number; max: number; height: number;
  /** Slider drag: one undo unit until `onEnd`. */
  onSet: (width: number) => void;
  /** Proportional steps (positive grows). `group` joins a wheel burst or held key into one undo unit. */
  onStep: (steps: number, group: "wheel" | "slider" | null) => void;
  onEnd: (group: "wheel" | "slider") => void;
};

/**
 * Visible proportional size control. Wheel over it, drag or key the slider, or tap Smaller/Larger.
 */
export function CircleSize({ sizing, labels }: { sizing: CircleSizing; labels: MarkupLabels }) {
  const slider = useRef<HTMLInputElement>(null);
  useWheelResize(slider, { owns: () => true, active: () => true, step: (n) => sizing.onStep(n, "wheel"), end: () => sizing.onEnd("wheel") });
  const keys: Record<string, number> = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 3, PageDown: -3 };
  const key = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Home" || event.key === "End") { event.preventDefault(); sizing.onSet(event.key === "Home" ? sizing.min : sizing.max); return; }
    const n = keys[event.key];
    if (!n) return;
    event.preventDefault();
    sizing.onStep(n, "slider");
  };
  const end = () => sizing.onEnd("slider");
  return (
    <div className="grid min-w-0 gap-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <label htmlFor="image-markup-circle-size" className="text-sm font-medium">{labels.circleSize}</label>
        <span className="text-xs text-muted-foreground">
          <span className="[@media(pointer:coarse)]:hidden">{labels.hintResizeCircle}</span>
          <span className="hidden [@media(pointer:coarse)]:inline">{labels.hintTouchSize}</span>
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <Button type="button" size="icon-touch" variant="outline" aria-label={labels.smaller} title={labels.smaller} disabled={sizing.value <= sizing.min} onClick={() => sizing.onStep(-2, null)}><Minus aria-hidden="true" /></Button>
        <input
          ref={slider} id="image-markup-circle-size" type="range" min={sizing.min} max={sizing.max} step={1} value={sizing.value}
          aria-valuetext={labels.sizeValue(sizing.value, sizing.height)}
          className="h-11 w-full min-w-0 flex-1 cursor-pointer accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onChange={(event) => sizing.onSet(Number(event.target.value))}
          onPointerDown={event => event.currentTarget.setPointerCapture(event.pointerId)}
          onKeyDown={key} onKeyUp={end} onPointerUp={end} onPointerCancel={end} onBlur={end}
        />
        <Button type="button" size="icon-touch" variant="outline" aria-label={labels.larger} title={labels.larger} disabled={sizing.value >= sizing.max} onClick={() => sizing.onStep(2, null)}><Plus aria-hidden="true" /></Button>
      </div>
    </div>
  );
}

/** The Fine-tune panel: pick a mark from a list, choose the outline, and set exact size and position. */
export function ImageMarkupFineTune({ id, className, marks, selected, labels, nameOf, step, imageWidth, imageHeight, minSize, strokeChoice, showStroke, onSelect, onResize, onMove, onSet, onStroke }: {
  id: string; className?: string; marks: readonly MarkupMark[]; selected: MarkupMark | null; labels: MarkupLabels; nameOf: (m: MarkupMark) => string; step: number;
  imageWidth: number; imageHeight: number; minSize: number;
  strokeChoice: StrokeChoice | null; showStroke: boolean;
  onSelect: (id: number | null) => void; onResize: (dw: number, dh: number) => void; onMove: (dx: number, dy: number) => void;
  onSet: (field: MarkupField, value: number) => void; onStroke: (choice: StrokeChoice) => void;
}) {
  const [fine, setFine] = useState(false);
  const d = fine ? 1 : step;
  return (
    <div id={id} tabIndex={-1} className={cn("grid min-w-0 shrink-0 gap-2 rounded-md border p-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", className)} role="group" aria-label={labels.fineTune}>
      {marks.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <label htmlFor="image-markup-marks" className="w-16 shrink-0 text-sm text-muted-foreground lg:w-full">{labels.marks}</label>
          <select
            id="image-markup-marks"
            className="aurora-control h-11 min-w-0 flex-1 rounded-lg border bg-background px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:max-w-56 md:text-sm lg:max-w-none"
            value={selected?.id ?? ""}
            onChange={(event) => onSelect(Number(event.target.value) || null)}
          >
            <option value="">{labels.chooseMark}</option>
            {marks.map((m) => <option key={m.id} value={m.id}>{nameOf(m)}</option>)}
          </select>
        </div>
      )}
      {showStroke && <StrokePicker value={strokeChoice} labels={labels} onChange={onStroke} />}
      {selected && <div key={selected.id} className="grid min-w-0 gap-2">
        <div>
          <Button type="button" size="touch" className={cn("px-3", PRESSED)} variant="outline" aria-pressed={fine} onClick={() => setFine(!fine)}>{labels.fineSteps}</Button>
        </div>
        <Stepper
          label={labels.width} value={selected.width} min={minSize} max={imageWidth - selected.x} less={labels.narrower} more={labels.wider}
          onLess={() => onResize(-d, 0)} onMore={() => onResize(d, 0)} onSet={(v) => onSet("width", v)}
        />
        <Stepper
          label={labels.height} value={selected.height} min={minSize} max={imageHeight - selected.y} less={labels.shorter} more={labels.taller}
          onLess={() => onResize(0, -d)} onMore={() => onResize(0, d)} onSet={(v) => onSet("height", v)}
        />
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={labels.move}>
          <span className="w-16 shrink-0 text-sm text-muted-foreground lg:w-full">{labels.move}</span>
          <Button type="button" size="icon-touch" variant="outline" aria-label={labels.moveLeft} onClick={() => onMove(-d, 0)}><ArrowLeft aria-hidden="true" /></Button>
          <Button type="button" size="icon-touch" variant="outline" aria-label={labels.moveUp} onClick={() => onMove(0, -d)}><ArrowUp aria-hidden="true" /></Button>
          <Button type="button" size="icon-touch" variant="outline" aria-label={labels.moveDown} onClick={() => onMove(0, d)}><ArrowDown aria-hidden="true" /></Button>
          <Button type="button" size="icon-touch" variant="outline" aria-label={labels.moveRight} onClick={() => onMove(d, 0)}><ArrowRight aria-hidden="true" /></Button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={labels.position}>
          <span className="w-16 shrink-0 text-sm text-muted-foreground lg:w-full">{labels.position}</span>
          <span className="inline-flex items-center gap-1.5">
            <span className="text-sm text-muted-foreground" aria-hidden="true">{labels.left}</span>
            <PixelField label={labels.left} value={selected.x} min={0} max={imageWidth - selected.width} onCommit={(v) => onSet("x", v)} />
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="text-sm text-muted-foreground" aria-hidden="true">{labels.top}</span>
            <PixelField label={labels.top} value={selected.y} min={0} max={imageHeight - selected.height} onCommit={(v) => onSet("y", v)} />
          </span>
        </div>
      </div>}
    </div>
  );
}
