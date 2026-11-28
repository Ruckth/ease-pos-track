import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { exportMarkupImage, imageMarkupErrorCode, loadMarkupImage, type MarkupMark, type MarkupRect } from "@/lib/image-markup";
import { markupLabels, type ImageMarkupErrorCode } from "@/lib/markup-labels";
import { nextSizeStep, scaleLimits, scaleRect, SIZE_STEP, stepLimits } from "@/lib/markup-geometry";
import type { PendingMedia } from "@/lib/types";
import { useMediaQuery } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";
import { AlertTriangle, ArrowLeft, Check, Loader2, Maximize2, SlidersHorizontal, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { adjustRect, clamp, ImageMarkupCanvas, ImageMarkupPreview, type MarkupPin, type MarkupPoint, type MarkupTool } from "./image-markup-canvas";
import { CircleSize, CircleSizeHint, CompactViewBar, EXPANDED, HistoryControls, ImageMarkupFineTune, ImageMarkupToolbar, type CircleSizing, type MarkupField, type StrokeChoice } from "./image-markup-controls";

type Reviewed = { source: File; file: File; url: string; crop: MarkupRect; width: number; height: number; failed: boolean; marks: readonly MarkupMark[] };
type Phase = "edit" | "exporting" | "review" | "applying";
type MarkHistory = { stack: Array<readonly MarkupMark[]>; pos: number };
type SizeGroup = "wheel" | "slider";
/** An open resize gesture: later steps replace its undo entry and derive from `origin` to avoid drift. */
type OpenGroup = { key: SizeGroup; origin: MarkupMark; exponent: number; before: MarkHistory };

/** Same tolerance and inclusive bounds as the draft owner's pin reprojection. */
const EPSILON = Number.EPSILON * 4;

const STROKE_FACTOR: Record<StrokeChoice, number> = { thin: 2, medium: 4, thick: 7 };

function formatBytes(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Local screenshot editor for a draft image. Geometry is in oriented source pixels;
 * the crop passed to onApply is normalized 0..1 against the same oriented source.
 */
export function ImageMarkupEditor({ item, pins, onApply, onCancel, onDirtyChange }: {
  item: PendingMedia;
  pins: Array<{ x?: number; y?: number; label: number }>;
  onApply: (file: File, crop: { x: number; y: number; width: number; height: number }) => boolean;
  onCancel: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { language } = useI18n();
  const labels = markupLabels(language);
  /** Phones fold the view row into the hint row under the photo. */
  const phone = useMediaQuery("(max-width: 639px)");
  const [image, setImage] = useState<ImageBitmap | null>(null);
  const [loadError, setLoadError] = useState<ImageMarkupErrorCode | null>(null);
  const [history, setHistory] = useState<MarkHistory>({ stack: [[]], pos: 0 });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [tool, setTool] = useState<MarkupTool>("circle");
  const [corner, setCorner] = useState<MarkupPoint | null>(null);
  const [strokeChoice, setStrokeChoice] = useState<StrokeChoice>("medium");
  const [tuneOpen, setTuneOpen] = useState(false);
  /** Opening Fine-tune from its button moves focus into the panel, which comes earlier in tab order. */
  const focusTuning = useRef(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [phase, setPhase] = useState<Phase>("edit");
  const [reviewed, setReviewed] = useState<Reviewed | null>(null);
  const nextId = useRef(1);
  const mounted = useRef(true);
  const exportToken = useRef(0);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const editBody = useRef<HTMLDivElement>(null);
  const group = useRef<OpenGroup | null>(null);
  const marks = history.stack[history.pos];
  const marksRef = useRef(marks);
  marksRef.current = marks;
  const dirty = marks.length > 0;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let alive = true, loaded: ImageBitmap | null = null;
    // Marks are in this file's pixels: a new source starts a fresh session.
    setImage(null);
    setLoadError(null);
    setHistory({ stack: [[]], pos: 0 });
    group.current = null;
    setSelectedId(null);
    setCorner(null);
    setTuneOpen(false);
    setReviewed(null);
    setPhase("edit");
    exportToken.current++;
    loadMarkupImage(item.file).then(
      (bitmap) => { if (alive) { loaded = bitmap; setImage(bitmap); } else bitmap.close(); },
      (reason: unknown) => { if (alive) setLoadError(imageMarkupErrorCode(reason)); },
    );
    return () => { alive = false; loaded?.close(); };
  }, [item.file]);

  const reviewedUrl = reviewed?.url;
  useEffect(() => () => { if (reviewedUrl) URL.revokeObjectURL(reviewedUrl); }, [reviewedUrl]);

  useEffect(() => {
    if (phase === "review") reviewHeading.current?.focus();
  }, [phase]);

  useEffect(() => {
    if (!tuneOpen || !focusTuning.current) return;
    focusTuning.current = false;
    // The panel itself takes focus (announced as the Fine-tune group); Tab continues into its controls.
    editBody.current?.querySelector<HTMLElement>("#image-markup-precise")?.focus();
  }, [tuneOpen]);

  const W = image?.width ?? 1, H = image?.height ?? 1;
  const base = Math.min(W, H);
  // Never larger than half the short side, so tiny images still allow every mark.
  const minSize = Math.max(1, Math.min(Math.max(4, Math.round(base / 100)), Math.floor(base / 2)));
  const step = Math.max(2, Math.round(base / 50));
  const strokeUnit = Math.max(1, Math.round(base / 400));
  const strokeOf = (choice: StrokeChoice) => STROKE_FACTOR[choice] * strokeUnit;
  const choiceOf = (stroke: number) => (Object.keys(STROKE_FACTOR) as StrokeChoice[]).find((c) => strokeOf(c) === stroke) ?? null;

  const selected = marks.find((m) => m.id === selectedId) ?? null;
  const crop = marks.find((m) => m.kind === "crop") ?? null;
  const nameOf = (m: MarkupMark) => labels.markName(m.kind, m.id);

  // Normalized crop exactly as onApply receives it; mark geometry is whole source pixels.
  const crop01 = crop ? { x: crop.x / W, y: crop.y / H, width: crop.width / W, height: crop.height / H } : { x: 0, y: 0, width: 1, height: 1 };
  const pins01 = useMemo(() => pins.flatMap((p) =>
    typeof p.x === "number" && typeof p.y === "number" && Number.isFinite(p.x) && Number.isFinite(p.y) ? [{ x: p.x, y: p.y, label: p.label }] : []), [pins]);
  const placedPins = useMemo<MarkupPin[]>(() => pins01.map((p) => ({ x: p.x * W, y: p.y * H, label: p.label })), [pins01, W, H]);
  const excluded = crop ? pins01.filter((p) => p.x < crop01.x - EPSILON || p.x > crop01.x + crop01.width + EPSILON
    || p.y < crop01.y - EPSILON || p.y > crop01.y + crop01.height + EPSILON) : [];

  function save(next: readonly MarkupMark[], message: string) {
    group.current = null;
    if (next.length === 0 && tool !== "circle") setTuneOpen(false);
    setHistory((h) => ({ stack: [...h.stack.slice(0, h.pos + 1), next], pos: h.pos + 1 }));
    setNotice(message);
    setError("");
  }
  const replace = (m: MarkupMark) => marks.map((old) => (old.id === m.id ? m : old));

  /** Closes an open wheel or slider gesture so the next edit is its own undo unit. */
  function endGroup(key?: SizeGroup) {
    const g = group.current;
    if (!g || (key && g.key !== key)) return;
    group.current = null;
    const m = marksRef.current.find((x) => x.id === g.origin.id);
    if (m) setNotice(labels.resized(nameOf(m), m.width, m.height));
  }

  /** Proportional circle resize around its centre. Grouped steps form one undo unit. */
  function resizeCircle(key: SizeGroup | null, exponentOf: (g: OpenGroup) => number) {
    if (selected?.kind !== "circle" || phase !== "edit") return;
    const open = key && group.current?.key === key && group.current.origin.id === selected.id ? group.current : null;
    if (!open) endGroup();
    const g: OpenGroup = open ?? { key: key ?? "slider", origin: selected, exponent: 0, before: history };
    const limits = stepLimits(g.origin, W, H, minSize);
    g.exponent = clamp(exponentOf(g), limits.min, limits.max);
    const next = scaleRect(g.origin, SIZE_STEP ** g.exponent, W, H, minSize);
    const { before, origin } = g;
    group.current = key ? g : null;
    if (next.x === origin.x && next.y === origin.y && next.width === origin.width && next.height === origin.height) {
      // A gesture that returns to its start preserves both Undo and Redo.
      setHistory(before);
      return;
    }
    const top = before.stack[before.pos].map((mark) => mark.id === next.id ? next : mark);
    setHistory({ stack: [...before.stack.slice(0, before.pos + 1), top], pos: before.pos + 1 });
    setError("");
    if (!key) setNotice(labels.resized(nameOf(next), next.width, next.height));
  }

  function switchTool(next: MarkupTool) {
    if (next !== tool) setTuneOpen(false);
    setTool(next);
  }

  function chooseTool(next: MarkupTool) {
    endGroup();
    if (next !== tool && editBody.current) editBody.current.scrollTop = 0;
    switchTool(next);
    setCorner(null);
    if (next !== "select" && next !== "erase" && next !== "pan") setSelectedId(null);
    setNotice("");
  }

  function select(id: number | null, fromFineTune = false) {
    endGroup();
    setSelectedId(id);
    setCorner(null);
    if (fromFineTune) setTool("select");
    else if (tool !== "erase") switchTool("select");
    const m = marks.find((x) => x.id === id);
    setNotice(m ? labels.selected(nameOf(m)) : "");
  }

  function addMark(kind: MarkupMark["kind"], rect: MarkupRect) {
    const existing = kind === "crop" ? crop : null;
    const m: MarkupMark = { ...rect, kind, id: existing?.id ?? nextId.current++, stroke: strokeOf(strokeChoice) };
    switchTool("select");
    setSelectedId(m.id);
    setCorner(null);
    save(existing ? replace(m) : [...marks, m], labels.selected(nameOf(m)));
  }

  function addRect(rect: MarkupRect) {
    if (tool !== "crop" && tool !== "mask") return;
    if (rect.width < minSize || rect.height < minSize) { setNotice(labels.areaTooSmall); return; }
    addMark(tool, rect);
  }

  function place(p: MarkupPoint) {
    if (tool === "circle") {
      const width = Math.min(W, Math.max(minSize, Math.round(base * 0.25)));
      const height = Math.min(H, Math.max(minSize, Math.round(base * 0.12)));
      addMark("circle", { x: clamp(Math.round(p.x - width / 2), 0, W - width), y: clamp(Math.round(p.y - height / 2), 0, H - height), width, height });
      return;
    }
    if (tool !== "crop" && tool !== "mask") return;
    if (!corner) { setCorner(p); setNotice(labels.hintSecondCorner); return; }
    addRect({ x: Math.min(corner.x, p.x), y: Math.min(corner.y, p.y), width: Math.abs(corner.x - p.x), height: Math.abs(corner.y - p.y) });
  }

  function erase(m: MarkupMark | null) {
    if (!m) return;
    setSelectedId(null);
    save(marks.filter((x) => x.id !== m.id), m.kind === "crop" ? labels.cropReset : labels.erased(nameOf(m)));
  }

  function commit(m: MarkupMark) { save(replace(m), labels.adjusted(nameOf(m))); }

  function adjustSelected(side: "move" | "e" | "s", dx: number, dy: number) {
    if (!selected) return;
    const next = adjustRect(selected, side, dx, dy, W, H, minSize);
    if (next.x !== selected.x || next.y !== selected.y || next.width !== selected.width || next.height !== selected.height) commit(next);
  }

  /** Exact whole-pixel geometry from the numeric fields, clamped like a drag. */
  function setGeometry(field: MarkupField, value: number) {
    if (!selected) return;
    const d = value - selected[field];
    if (field === "x") adjustSelected("move", d, 0);
    else if (field === "y") adjustSelected("move", 0, d);
    else if (field === "width") adjustSelected("e", d, 0);
    else adjustSelected("s", 0, d);
  }

  function changeStroke(choice: StrokeChoice) {
    setStrokeChoice(choice);
    if (selected?.kind === "circle" && selected.stroke !== strokeOf(choice)) commit({ ...selected, stroke: strokeOf(choice) });
  }

  function travel(delta: -1 | 1) {
    const pos = history.pos + delta;
    if (pos < 0 || pos >= history.stack.length) return;
    group.current = null;
    const prev = marks, next = history.stack[pos];
    setHistory({ ...history, pos });
    const changed = next.find((m) => !prev.includes(m)) ?? null;
    setSelectedId(changed?.id ?? (next.some((m) => m.id === selectedId) ? selectedId : null));
    switchTool("select");
    if (next.length === 0) setTuneOpen(false);
    setCorner(null);
    setNotice(delta === -1 ? labels.undone : labels.redone);
  }

  function expandCrop() {
    if (!crop || !excluded.length) return;
    const pad = Math.max(8, Math.round(base * 0.03));
    let x1 = crop.x, y1 = crop.y, x2 = crop.x + crop.width, y2 = crop.y + crop.height;
    for (const p of excluded) {
      x1 = Math.min(x1, p.x * W - pad); y1 = Math.min(y1, p.y * H - pad);
      x2 = Math.max(x2, p.x * W + pad); y2 = Math.max(y2, p.y * H + pad);
    }
    x1 = clamp(Math.floor(x1), 0, W); y1 = clamp(Math.floor(y1), 0, H);
    x2 = clamp(Math.ceil(x2), 0, W); y2 = clamp(Math.ceil(y2), 0, H);
    setSelectedId(crop.id);
    switchTool("select");
    commit({ ...crop, x: x1, y: y1, width: x2 - x1, height: y2 - y1 });
  }

  async function review() {
    if (!image || phase !== "edit") return;
    if (corner) { setNotice(labels.finishSelection); return; }
    if (excluded.length) return;
    endGroup();
    const token = ++exportToken.current;
    const snapshot = marks, source = item.file;
    const cropOut = crop01;
    setPhase("exporting");
    setError("");
    try {
      const file = await exportMarkupImage(image, snapshot, source.type);
      if (!mounted.current || token !== exportToken.current) return;
      const url = URL.createObjectURL(file);
      setReviewed({ source, file, url, crop: cropOut, width: 0, height: 0, failed: false, marks: snapshot });
      setPhase("review");
    } catch (reason) {
      if (!mounted.current || token !== exportToken.current) return;
      setError(labels.exportError(imageMarkupErrorCode(reason)));
      setPhase("edit");
    }
  }

  function backToEdit() {
    exportToken.current++;
    setReviewed(null);
    setError("");
    setPhase("edit");
    requestAnimationFrame(() => reviewButton.current?.focus());
  }

  function apply() {
    if (!reviewed || reviewed.failed || !reviewed.width || phase !== "review" || !mounted.current || reviewed.marks !== marks || reviewed.source !== item.file) return;
    setPhase("applying");
    const ok = onApply(reviewed.file, reviewed.crop);
    if (!mounted.current) return;
    if (!ok) { setError(labels.applyFailed); setPhase("review"); }
  }

  function rootKey(event: KeyboardEvent<HTMLDivElement>) {
    if (phase !== "edit" || (event.target as Element).closest("input:not([type=range]), textarea, select")) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === "z") { event.preventDefault(); travel(event.shiftKey ? 1 : -1); }
    else if (mod && event.key.toLowerCase() === "y") { event.preventDefault(); travel(1); }
    else if ((event.key === "Delete" || event.key === "Backspace") && selected) { event.preventDefault(); erase(selected); }
  }

  if (loadError) {
    return (
      <div className="grid gap-3" role="alert">
        <p className="flex items-center gap-2 text-sm"><AlertTriangle aria-hidden="true" className="size-4 text-destructive" />{labels.loadError(loadError)}</p>
        <div><Button type="button" size="touch" variant="outline" onClick={onCancel}>{labels.cancel}</Button></div>
      </div>
    );
  }
  if (!image) {
    return <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground" role="status"><Loader2 aria-hidden="true" className="size-4 animate-spin" />{labels.loading}</p>;
  }

  if (reviewed && (phase === "review" || phase === "applying")) {
    return (
      <section className="flex min-h-0 flex-1 flex-col gap-2 sm:gap-3" aria-labelledby="image-markup-review-title">
        <h3 id="image-markup-review-title" ref={reviewHeading} tabIndex={-1} className="text-base font-semibold outline-none">{labels.reviewTitle}</h3>
        <p className="text-sm text-muted-foreground">{labels.reviewHint}</p>
        <ImageMarkupPreview
          url={reviewed.url} alt={labels.reviewTitle} width={reviewed.width} height={reviewed.height} labels={labels}
          onLoad={(width, height) => setReviewed((r) => (r && r.url === reviewed.url ? { ...r, width, height } : r))}
          onError={() => { setReviewed((r) => (r && r.url === reviewed.url ? { ...r, failed: true } : r)); setError(labels.exportFailed); }}
        />
        {reviewed.width > 0 && (
          <p className="hidden text-sm tabular-nums text-muted-foreground sm:block">{labels.outputMeta(reviewed.width, reviewed.height, formatBytes(reviewed.file.size), reviewed.file.type.replace("image/", "").toUpperCase())}</p>
        )}
        {error && <p role="alert" className="shrink-0 text-sm text-destructive">{error}</p>}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t pt-2 sm:pt-3">
          <Button type="button" size="touch" variant="outline" className="px-3" onClick={backToEdit} disabled={phase === "applying"}><ArrowLeft aria-hidden="true" />{labels.backToEdit}</Button>
          <Button type="button" size="touch" className="px-5 max-sm:flex-1" onClick={apply} disabled={phase === "applying" || reviewed.failed || !reviewed.width} aria-busy={phase === "applying"}>
            {phase === "applying" ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Check aria-hidden="true" />}
            {phase === "applying" ? labels.applying : labels.apply}
          </Button>
        </div>
      </section>
    );
  }

  const circleSelected = tool === "select" && selected?.kind === "circle" ? selected : null;
  const sizeRange = circleSelected && scaleLimits(circleSelected, W, H, minSize);
  const circle: CircleSizing | null = circleSelected && sizeRange ? {
    value: circleSelected.width, height: circleSelected.height,
    min: Math.min(circleSelected.width, Math.ceil(sizeRange.min * circleSelected.width)),
    max: Math.max(circleSelected.width, Math.floor(sizeRange.max * circleSelected.width)),
    onSet: (width) => resizeCircle("slider", (g) => Math.log(width / g.origin.width) / Math.log(SIZE_STEP)),
    onStep: (steps, key) => resizeCircle(key, (g) => nextSizeStep(g.origin, g.exponent, steps)),
    onEnd: endGroup,
  } : null;
  const hints: Record<MarkupTool, string> = { select: labels.hintSelect, pan: labels.hintPan, circle: labels.hintCircle, crop: labels.hintCrop, mask: labels.hintMask, erase: labels.hintErase };
  const hint = corner ? labels.hintSecondCorner : hints[tool];
  const historyControls = <HistoryControls labels={labels} canUndo={history.pos > 0} canRedo={history.pos < history.stack.length - 1} onUndo={() => travel(-1)} onRedo={() => travel(1)} />;
  const busy = phase === "exporting";
  const needsAction = notice === labels.areaTooSmall || notice === labels.finishSelection;
  const showStroke = tool === "circle" || !!circleSelected;
  const canTune = marks.length > 0 || showStroke;
  const removeLabel = selected?.kind === "crop" ? labels.resetCrop : labels.removeSelected;
  function toggleTuning() {
    focusTuning.current = !tuneOpen;
    setTuneOpen(!tuneOpen);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 sm:gap-3" onKeyDown={rootKey}>
      <ImageMarkupToolbar tool={tool} labels={labels} onTool={chooseTool} disabled={busy} />
      <p id="image-markup-keyboard-hint" className="sr-only">{labels.keyboardHint}</p>
      {/* The actions below stay in view: smaller screens scroll this area, large ones show Fine-tune beside the photo. */}
      <div ref={editBody} inert={busy || undefined} className={cn("flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto sm:gap-3", tuneOpen && "lg:flex-row lg:overflow-hidden")}>
        <div className={cn("flex min-h-[min(24rem,55dvh)] min-w-0 flex-1 flex-col gap-2 sm:gap-3", tuneOpen && "lg:min-h-0 lg:overflow-y-auto")}>
          <ImageMarkupCanvas
            image={image} marks={marks} selectedId={selectedId} tool={tool} pins={placedPins} corner={corner} minSize={minSize} labels={labels}
            actions={historyControls} compact={phone}
            onSelect={select} onCommit={commit} onPlace={place} onRect={addRect} onErase={erase}
            onMoveSelected={(dx, dy) => adjustSelected("move", dx, dy)}
            onEscape={() => { setCorner(null); setNotice(""); }}
            onWheelResize={(steps) => resizeCircle("wheel", (g) => nextSizeStep(g.origin, g.exponent, steps))}
            onWheelEnd={() => endGroup("wheel")}
            below={(zoom) => phone ? (
              // Selecting or moving a mark must preserve the fitted image during the gesture: Select reserves the slider row.
              <div className={cn("flex shrink-0 flex-col gap-1", tool === "select" && "min-h-24")}>
                <CompactViewBar zoom={zoom} labels={labels} actions={historyControls} disabled={busy}>
                  {circle
                    ? <><span className="font-medium text-foreground">{labels.circleSize}</span>{" "}<CircleSizeHint labels={labels} /></>
                    : corner ? <div className="grid">
                      <span aria-hidden="true" className="invisible col-start-1 row-start-1">{hints[tool]}</span>
                      <span className="col-start-1 row-start-1">{hint}</span>
                    </div> : hint}
                </CompactViewBar>
                {circle && <CircleSize sizing={circle} labels={labels} header={false} />}
              </div>
            ) : (
              <div className={cn("flex shrink-0 flex-col justify-center", tool === "select" ? "min-h-[4.25rem]" : "min-h-10 sm:min-h-[4.25rem]")}>
                {circle ? <CircleSize sizing={circle} labels={labels} /> : <p className="text-sm leading-5 text-muted-foreground">{hint}</p>}
              </div>
            )}
          />
          <p className={needsAction ? "shrink-0 text-sm" : "sr-only"} role="status">{notice}</p>
          {excluded.length > 0 && (
            <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
              <AlertTriangle aria-hidden="true" className="size-4 shrink-0 text-destructive" />
              <span className="min-w-0 flex-1">{labels.pinsOutside(excluded.map((p) => `[${p.label}]`).join(", "))}</span>
              <Button type="button" size="touch" variant="outline" onClick={expandCrop}><Maximize2 aria-hidden="true" />{labels.expandCrop}</Button>
            </div>
          )}
        </div>
        {tuneOpen && (
          <ImageMarkupFineTune
            id="image-markup-precise" className="lg:max-h-full lg:w-[22rem] lg:self-start lg:overflow-y-auto" marks={marks} selected={selected} labels={labels} nameOf={nameOf} step={step} imageWidth={W} imageHeight={H} minSize={minSize}
            strokeChoice={selected?.kind === "circle" ? choiceOf(selected.stroke) : strokeChoice}
            showStroke={showStroke}
            onSelect={(id) => select(id, true)}
            onResize={(dw, dh) => adjustSelected(dw ? "e" : "s", dw, dh)}
            onMove={(dx, dy) => adjustSelected("move", dx, dy)}
            onSet={setGeometry}
            onStroke={changeStroke}
          />
        )}
      </div>
      {error && <p role="alert" className="shrink-0 text-sm text-destructive">{error}</p>}
      <div className="flex shrink-0 items-center gap-2 border-t pt-1.5 sm:pt-3">
        <Button
          type="button" size="touch" variant="outline" className={cn("px-3", EXPANDED)} disabled={busy || !canTune}
          aria-expanded={tuneOpen} aria-controls={tuneOpen ? "image-markup-precise" : undefined}
          onClick={toggleTuning}
        ><SlidersHorizontal aria-hidden="true" />{labels.fineTune}</Button>
        <Button type="button" size="icon-touch" variant="outline" aria-label={removeLabel} title={removeLabel} disabled={busy || !selected} onClick={() => erase(selected)}><Trash2 aria-hidden="true" /></Button>
        <span aria-hidden="true" className="mx-1 h-7 w-px shrink-0 bg-border sm:hidden" />
        <Button ref={reviewButton} type="button" size="touch" className="px-5 max-sm:flex-1 sm:ms-auto" onClick={review} disabled={busy || excluded.length > 0} aria-busy={busy}>
          {busy ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Check aria-hidden="true" />}
          {busy ? labels.reviewing : labels.review}
        </Button>
      </div>
    </div>
  );
}
