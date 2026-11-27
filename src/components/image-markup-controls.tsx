import { Button } from "@/components/ui/button";
import type { MarkupMark } from "@/lib/image-markup";
import type { MarkupLabels } from "@/lib/markup-labels";
import { cn } from "@/lib/utils";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Circle, Crop, Eraser, Hand, Minus, MousePointer2, MoveHorizontal, Plus, Redo2, Shrink, SlidersHorizontal, Square, Trash2, Undo2, ZoomIn, ZoomOut } from "lucide-react";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { MarkupTool, MarkupZoom } from "./image-markup-canvas";
import { useWheelResize } from "./image-markup-wheel";

export type StrokeChoice = "thin" | "medium" | "thick";

export function ImageMarkupToolbar({ tool, labels, onTool, canUndo, canRedo, onUndo, onRedo, disabled }: {
  tool: MarkupTool; labels: MarkupLabels; onTool: (tool: MarkupTool) => void;
  canUndo: boolean; canRedo: boolean; onUndo: () => void; onRedo: () => void; disabled?: boolean;
}) {
  const tools: Array<[MarkupTool, string, ReactNode]> = [
    ["select", labels.select, <MousePointer2 key="i" aria-hidden="true" />],
    ["pan", labels.pan, <Hand key="i" aria-hidden="true" />],
    ["circle", labels.circle, <Circle key="i" aria-hidden="true" />],
    ["crop", labels.crop, <Crop key="i" aria-hidden="true" />],
    ["mask", labels.mask, <Square key="i" aria-hidden="true" className="fill-current" />],
    ["erase", labels.eraser, <Eraser key="i" aria-hidden="true" />],
  ];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <div role="toolbar" aria-label={labels.tools} className="grid w-full grid-cols-3 gap-1 sm:flex sm:w-auto sm:flex-wrap">
        {tools.map(([value, label, icon]) => (
          <Button
            key={value} type="button" size="touch" disabled={disabled} className="max-sm:flex-col max-sm:gap-0.5 max-sm:px-1 max-sm:text-xs sm:px-3"
            variant={tool === value ? "default" : "outline"}
            aria-pressed={tool === value}
            onClick={() => onTool(value)}
          >
            {icon}{label}
          </Button>
        ))}
      </div>
      <div className="ms-auto flex gap-1">
        <Button type="button" size="icon-touch" variant="outline" aria-label={labels.undo} title={labels.undo} disabled={disabled || !canUndo} onClick={onUndo}><Undo2 aria-hidden="true" /></Button>
        <Button type="button" size="icon-touch" variant="outline" aria-label={labels.redo} title={labels.redo} disabled={disabled || !canRedo} onClick={onRedo}><Redo2 aria-hidden="true" /></Button>
      </div>
    </div>
  );
}

/** Zoom out / level / zoom in, then fit-whole-image and fit-width (for long receipts). */
export function ZoomControls({ zoom, labels }: { zoom: MarkupZoom; labels: MarkupLabels }) {
  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label={labels.view}>
      <Button type="button" size="icon-touch" variant="outline" aria-label={labels.zoomOut} disabled={!zoom.canZoomOut} onClick={zoom.zoomOut}><ZoomOut aria-hidden="true" /></Button>
      <output className="w-12 text-center text-sm tabular-nums" aria-label={labels.zoomLevel}>{zoom.percent}%</output>
      <Button type="button" size="icon-touch" variant="outline" aria-label={labels.zoomIn} disabled={!zoom.canZoomIn} onClick={zoom.zoomIn}><ZoomIn aria-hidden="true" /></Button>
      <Button type="button" size="touch" className="px-3" variant={zoom.view === "fit" ? "default" : "outline"} aria-pressed={zoom.view === "fit"} onClick={zoom.fit}><Shrink aria-hidden="true" />{labels.fitImage}</Button>
      <Button type="button" size="touch" className="px-3" variant={zoom.view === "width" ? "default" : "outline"} aria-pressed={zoom.view === "width"} onClick={zoom.fitWidth}><MoveHorizontal aria-hidden="true" />{labels.fitWidth}</Button>
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
      <span className="w-20 text-sm text-muted-foreground">{label}</span>
      <Button type="button" size="icon-touch" variant="outline" aria-label={`${label}: ${less}`} onClick={onLess}><Minus aria-hidden="true" /></Button>
      <PixelField label={label} value={value} min={min} max={max} onCommit={onSet} />
      <Button type="button" size="icon-touch" variant="outline" aria-label={`${label}: ${more}`} onClick={onMore}><Plus aria-hidden="true" /></Button>
    </div>
  );
}

export function StrokePicker({ value, labels, onChange }: { value: StrokeChoice | null; labels: MarkupLabels; onChange: (choice: StrokeChoice) => void }) {
  const choices: Array<[StrokeChoice, string, string]> = [["thin", labels.thin, "border-b"], ["medium", labels.medium, "border-b-2"], ["thick", labels.thick, "border-b-4"]];
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={labels.outline}>
      <span className="w-20 text-sm text-muted-foreground">{labels.outline}</span>
      {choices.map(([choice, label, line]) => (
        <Button key={choice} type="button" size="touch" className="px-3" variant={value === choice ? "default" : "outline"} aria-pressed={value === choice} onClick={() => onChange(choice)}>
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
function CircleSize({ sizing, labels }: { sizing: CircleSizing; labels: MarkupLabels }) {
  const slider = useRef<HTMLInputElement>(null);
  useWheelResize(slider, { owns: () => true, active: () => true, step: (n) => sizing.onStep(n, "wheel"), end: () => sizing.onEnd("wheel") });
  const text = labels.sizeValue(sizing.value, sizing.height);
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
    <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 sm:grid-cols-[auto_auto_minmax(0,1fr)_auto_auto]">
      <div className="col-span-full flex justify-between gap-2 sm:contents">
        <label htmlFor="image-markup-circle-size" className="text-sm font-medium sm:col-start-1 sm:row-start-1">{labels.circleSize}</label>
        <output htmlFor="image-markup-circle-size" aria-live="off" className="text-end text-sm tabular-nums text-muted-foreground sm:col-start-5 sm:row-start-1">{text}</output>
      </div>
      <Button type="button" size="icon-touch" variant="outline" aria-label={labels.smaller} title={labels.smaller} disabled={sizing.value <= sizing.min} onClick={() => sizing.onStep(-2, null)}><Minus aria-hidden="true" /></Button>
      <input
        ref={slider} id="image-markup-circle-size" type="range" min={sizing.min} max={sizing.max} step={1} value={sizing.value}
        aria-valuetext={text}
        className="h-11 w-full min-w-0 flex-1 cursor-pointer accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onChange={(event) => sizing.onSet(Number(event.target.value))}
        onPointerDown={event => event.currentTarget.setPointerCapture(event.pointerId)}
        onKeyDown={key} onKeyUp={end} onPointerUp={end} onPointerCancel={end} onBlur={end}
      />
      <Button type="button" size="icon-touch" variant="outline" aria-label={labels.larger} title={labels.larger} disabled={sizing.value >= sizing.max} onClick={() => sizing.onStep(2, null)}><Plus aria-hidden="true" /></Button>
    </div>
  );
}

export function ImageMarkupInspector({ marks, selected, labels, nameOf, step, imageWidth, imageHeight, minSize, strokeChoice, showStroke, circle, onSelect, onResize, onMove, onSet, onStroke, onRemove }: {
  marks: readonly MarkupMark[]; selected: MarkupMark | null; labels: MarkupLabels; nameOf: (m: MarkupMark) => string; step: number;
  imageWidth: number; imageHeight: number; minSize: number;
  strokeChoice: StrokeChoice | null; showStroke: boolean;
  /** Present when the selection is a circle. */
  circle: CircleSizing | null;
  onSelect: (id: number | null) => void; onResize: (dw: number, dh: number) => void; onMove: (dx: number, dy: number) => void;
  onSet: (field: MarkupField, value: number) => void;
  onStroke: (choice: StrokeChoice) => void; onRemove: () => void;
}) {
  const [fine, setFine] = useState(false);
  const [precise, setPrecise] = useState(false);
  const d = fine ? 1 : step;
  const removeLabel = selected?.kind === "crop" ? labels.resetCrop : labels.removeSelected;
  return (
    <div className="grid gap-2">
      {circle && <CircleSize sizing={circle} labels={labels} />}
      {(marks.length > 0 || showStroke) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {(marks.length > 1 || (marks.length === 1 && !selected)) && (
            <>
              <label htmlFor="image-markup-marks" className="text-sm text-muted-foreground">{labels.marks}</label>
              <select
                id="image-markup-marks"
                className="aurora-control h-11 min-w-0 flex-1 rounded-lg border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:max-w-56"
                value={selected?.id ?? ""}
                onChange={(event) => onSelect(Number(event.target.value) || null)}
              >
                <option value="">{labels.chooseMark}</option>
                {marks.map((m) => <option key={m.id} value={m.id}>{nameOf(m)}</option>)}
              </select>
            </>
          )}
          {(selected || showStroke) && (
            <Button type="button" size="touch" className="px-3" variant={precise ? "default" : "outline"} aria-expanded={precise} aria-controls={precise ? "image-markup-precise" : undefined} onClick={() => setPrecise(!precise)}>
              <SlidersHorizontal aria-hidden="true" />{labels.fineTune}
            </Button>
          )}
          {selected && <Button type="button" size="icon-touch" variant="outline" aria-label={removeLabel} title={removeLabel} onClick={onRemove}><Trash2 aria-hidden="true" /></Button>}
        </div>
      )}
      {precise && (selected || showStroke) && (
        <div id="image-markup-precise" className="grid min-w-0 gap-2 rounded-md border p-2" role="group" aria-label={labels.fineTune}>
          {showStroke && <StrokePicker value={strokeChoice} labels={labels} onChange={onStroke} />}
          {selected && <div key={selected.id} className="grid min-w-0 gap-2">
            <div>
              <Button type="button" size="touch" className="px-3" variant={fine ? "default" : "outline"} aria-pressed={fine} onClick={() => setFine(!fine)}>{labels.fineSteps}</Button>
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
              <span className="w-20 text-sm text-muted-foreground">{labels.move}</span>
              <Button type="button" size="icon-touch" variant="outline" aria-label={labels.moveLeft} onClick={() => onMove(-d, 0)}><ArrowLeft aria-hidden="true" /></Button>
              <Button type="button" size="icon-touch" variant="outline" aria-label={labels.moveUp} onClick={() => onMove(0, -d)}><ArrowUp aria-hidden="true" /></Button>
              <Button type="button" size="icon-touch" variant="outline" aria-label={labels.moveDown} onClick={() => onMove(0, d)}><ArrowDown aria-hidden="true" /></Button>
              <Button type="button" size="icon-touch" variant="outline" aria-label={labels.moveRight} onClick={() => onMove(d, 0)}><ArrowRight aria-hidden="true" /></Button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={labels.position}>
              <span className="w-20 text-sm text-muted-foreground">{labels.position}</span>
              <span className="text-sm text-muted-foreground" aria-hidden="true">{labels.left}</span>
              <PixelField label={labels.left} value={selected.x} min={0} max={imageWidth - selected.width} onCommit={(v) => onSet("x", v)} />
              <span className="text-sm text-muted-foreground" aria-hidden="true">{labels.top}</span>
              <PixelField label={labels.top} value={selected.y} min={0} max={imageHeight - selected.height} onCommit={(v) => onSet("y", v)} />
            </div>
          </div>}
        </div>
      )}
    </div>
  );
}
