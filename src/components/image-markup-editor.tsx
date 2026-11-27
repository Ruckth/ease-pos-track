import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { exportMarkupImage, imageMarkupErrorCode, loadMarkupImage, type MarkupMark, type MarkupRect } from "@/lib/image-markup";
import { markupLabels, type ImageMarkupErrorCode } from "@/lib/markup-labels";
import type { PendingMedia } from "@/lib/types";
import { AlertTriangle, ArrowLeft, Check, Loader2, Maximize2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { adjustRect, clamp, ImageMarkupCanvas, ImageMarkupPreview, type MarkupPin, type MarkupPoint, type MarkupTool } from "./image-markup-canvas";
import { ImageMarkupInspector, ImageMarkupToolbar, type MarkupField, type StrokeChoice } from "./image-markup-controls";

type Reviewed = { source: File; file: File; url: string; crop: MarkupRect; width: number; height: number; failed: boolean; marks: readonly MarkupMark[] };
type Phase = "edit" | "exporting" | "review" | "applying";

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
export function ImageMarkupEditor({ item, pins, onApply, onCancel }: {
  item: PendingMedia;
  pins: Array<{ x?: number; y?: number; label: number }>;
  onApply: (file: File, crop: { x: number; y: number; width: number; height: number }) => boolean;
  onCancel: () => void;
}) {
  const { language } = useI18n();
  const labels = markupLabels(language);
  const [image, setImage] = useState<ImageBitmap | null>(null);
  const [loadError, setLoadError] = useState<ImageMarkupErrorCode | null>(null);
  const [history, setHistory] = useState<{ stack: Array<readonly MarkupMark[]>; pos: number }>({ stack: [[]], pos: 0 });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [tool, setTool] = useState<MarkupTool>("circle");
  const [corner, setCorner] = useState<MarkupPoint | null>(null);
  const [strokeChoice, setStrokeChoice] = useState<StrokeChoice>("medium");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [phase, setPhase] = useState<Phase>("edit");
  const [reviewed, setReviewed] = useState<Reviewed | null>(null);
  const nextId = useRef(1);
  const mounted = useRef(true);
  const exportToken = useRef(0);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const marks = history.stack[history.pos];

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
    setSelectedId(null);
    setCorner(null);
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
    setHistory((h) => ({ stack: [...h.stack.slice(0, h.pos + 1), next], pos: h.pos + 1 }));
    setNotice(message);
    setError("");
  }
  const replace = (m: MarkupMark) => marks.map((old) => (old.id === m.id ? m : old));

  function chooseTool(next: MarkupTool) {
    setTool(next);
    setCorner(null);
    if (next !== "select" && next !== "erase" && next !== "pan") setSelectedId(null);
    setNotice("");
  }

  function select(id: number | null) {
    setSelectedId(id);
    setCorner(null);
    if (tool !== "erase") setTool("select");
    const m = marks.find((x) => x.id === id);
    setNotice(m ? labels.selected(nameOf(m)) : "");
  }

  function addMark(kind: MarkupMark["kind"], rect: MarkupRect) {
    const existing = kind === "crop" ? crop : null;
    const m: MarkupMark = { ...rect, kind, id: existing?.id ?? nextId.current++, stroke: strokeOf(strokeChoice) };
    setTool("select");
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
    const prev = marks, next = history.stack[pos];
    setHistory({ ...history, pos });
    const changed = next.find((m) => !prev.includes(m)) ?? null;
    setSelectedId(changed?.id ?? (next.some((m) => m.id === selectedId) ? selectedId : null));
    setTool("select");
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
    setTool("select");
    commit({ ...crop, x: x1, y: y1, width: x2 - x1, height: y2 - y1 });
  }

  async function review() {
    if (!image || phase !== "edit") return;
    if (corner) { setNotice(labels.finishSelection); return; }
    if (excluded.length) return;
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

  function cancel() {
    exportToken.current++;
    onCancel();
  }

  function rootKey(event: KeyboardEvent<HTMLDivElement>) {
    if (phase !== "edit" || (event.target as Element).closest("input, textarea, select")) return;
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
      <section className="grid gap-3" aria-labelledby="image-markup-review-title">
        <h3 id="image-markup-review-title" ref={reviewHeading} tabIndex={-1} className="text-base font-semibold outline-none">{labels.reviewTitle}</h3>
        <p className="text-sm text-muted-foreground">{labels.reviewHint}</p>
        <ImageMarkupPreview
          url={reviewed.url} alt={labels.reviewTitle} width={reviewed.width} height={reviewed.height} labels={labels}
          onLoad={(width, height) => setReviewed((r) => (r && r.url === reviewed.url ? { ...r, width, height } : r))}
          onError={() => { setReviewed((r) => (r && r.url === reviewed.url ? { ...r, failed: true } : r)); setError(labels.exportFailed); }}
        />
        {reviewed.width > 0 && (
          <p className="text-sm tabular-nums text-muted-foreground">{labels.outputMeta(reviewed.width, reviewed.height, formatBytes(reviewed.file.size), reviewed.file.type.replace("image/", "").toUpperCase())}</p>
        )}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" size="touch" variant="outline" onClick={backToEdit} disabled={phase === "applying"}><ArrowLeft aria-hidden="true" />{labels.backToEdit}</Button>
          <Button type="button" size="touch" onClick={apply} disabled={phase === "applying" || reviewed.failed || !reviewed.width} aria-busy={phase === "applying"}>
            {phase === "applying" ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Check aria-hidden="true" />}
            {phase === "applying" ? labels.applying : labels.apply}
          </Button>
        </div>
      </section>
    );
  }

  const hints: Record<MarkupTool, string> = { select: labels.hintSelect, pan: labels.hintPan, circle: labels.hintCircle, crop: labels.hintCrop, mask: labels.hintMask, erase: labels.hintErase };
  const busy = phase === "exporting";

  return (
    <div className="grid gap-3" onKeyDown={rootKey}>
      <ImageMarkupToolbar
        tool={tool} labels={labels} onTool={chooseTool} disabled={busy}
        canUndo={history.pos > 0} canRedo={history.pos < history.stack.length - 1}
        onUndo={() => travel(-1)} onRedo={() => travel(1)}
      />
      <p className="text-sm text-muted-foreground">{corner ? labels.hintSecondCorner : hints[tool]}</p>
      <p id="image-markup-keyboard-hint" className="sr-only">{labels.keyboardHint}</p>
      <div inert={busy || undefined} className="grid gap-3">
        <ImageMarkupCanvas
          image={image} marks={marks} selectedId={selectedId} tool={tool} pins={placedPins} corner={corner} minSize={minSize} labels={labels}
          onSelect={select} onCommit={commit} onPlace={place} onRect={addRect} onErase={erase}
          onMoveSelected={(dx, dy) => adjustSelected("move", dx, dy)}
          onEscape={() => { setCorner(null); setNotice(""); }}
        />
      <p className="min-h-5 text-sm" role="status" aria-live="polite">{notice}</p>
      {excluded.length > 0 && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <AlertTriangle aria-hidden="true" className="size-4 shrink-0 text-destructive" />
          <span className="min-w-0 flex-1">{labels.pinsOutside(excluded.map((p) => `[${p.label}]`).join(", "))}</span>
          <Button type="button" size="touch" variant="outline" onClick={expandCrop}><Maximize2 aria-hidden="true" />{labels.expandCrop}</Button>
        </div>
      )}
      <ImageMarkupInspector
        marks={marks} selected={selected} labels={labels} nameOf={nameOf} step={step} imageWidth={W} imageHeight={H} minSize={minSize}
        strokeChoice={selected?.kind === "circle" ? choiceOf(selected.stroke) : strokeChoice}
        showStroke={tool === "circle" || selected?.kind === "circle"}
        onSelect={select}
        onResize={(dw, dh) => adjustSelected(dw ? "e" : "s", dw, dh)}
        onMove={(dx, dy) => adjustSelected("move", dx, dy)}
        onSet={setGeometry}
        onStroke={changeStroke}
        onRemove={() => erase(selected)}
      />
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" size="touch" variant="outline" onClick={cancel}><X aria-hidden="true" />{labels.cancel}</Button>
        <Button ref={reviewButton} type="button" size="touch" onClick={review} disabled={busy || excluded.length > 0} aria-busy={busy}>
          {busy ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Check aria-hidden="true" />}
          {busy ? labels.reviewing : labels.review}
        </Button>
      </div>
    </div>
  );
}
