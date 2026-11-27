import { fitImage, IMAGE_ERRORS, IMAGE_SOURCE_BYTES, inspectRaster, readRasterHeader } from "../../shared/image-optimization";
import { assertPreparedRaster, rasterTraits, withoutMetadata } from "../../shared/raster-structure";
import { MEDIA_POLICY } from "../../shared/ticket-contracts";
export { canMarkupImage } from "./types";

export type MarkupRect = { x: number; y: number; width: number; height: number };
export type MarkupMark = MarkupRect & { id: number; kind: "circle" | "mask" | "crop"; stroke: number };
type Size = Pick<MarkupRect, "width" | "height">;
type Mime = "image/png" | "image/jpeg";
type Canvas = HTMLCanvasElement | OffscreenCanvas;
type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export const MARKUP_MAX_EDGE = 16_384;
export const MARKUP_MAX_PIXELS = 16_777_216;
export const MARKUP_CIRCLE_COLOR = "#bd3928";
export const MARKUP_CIRCLE_HALO_COLOR = "#ffffff";
export const MARKUP_CIRCLE_HALO_EXTRA = 3;
export const MARKUP_MASK_COLOR = "#182330";
export const IMAGE_MARKUP_ERRORS = {
  ...IMAGE_ERRORS,
  tooLarge: "IMAGE_TOO_LARGE",
  dimensionsTooLarge: "IMAGE_DIMENSIONS_TOO_LARGE",
  exportFailed: "IMAGE_MARKUP_EXPORT_FAILED",
} as const;
type ErrorCode = (typeof IMAGE_MARKUP_ERRORS)[keyof typeof IMAGE_MARKUP_ERRORS];

export function imageMarkupErrorCode(error: unknown): ErrorCode {
  return Object.values(IMAGE_MARKUP_ERRORS).find(code => error instanceof Error && error.message === code) ?? IMAGE_ERRORS.invalid;
}

function isSupported(type: string): type is Mime {
  return type === "image/png" || type === "image/jpeg";
}

function checkSize({ width, height }: Size) {
  if (![width, height].every(value => Number.isSafeInteger(value) && value > 0)) throw Error(IMAGE_ERRORS.invalid);
  if (width > MARKUP_MAX_EDGE || height > MARKUP_MAX_EDGE || width * height > MARKUP_MAX_PIXELS) {
    throw Error(IMAGE_MARKUP_ERRORS.dimensionsTooLarge);
  }
}

/** Take dimensions and orientation from the decoded source used for both editing and export. */
export async function loadMarkupImage(file: File): Promise<ImageBitmap> {
  if (!file.size) throw Error(IMAGE_ERRORS.invalid);
  if (file.size > IMAGE_SOURCE_BYTES) throw Error(IMAGE_MARKUP_ERRORS.tooLarge);
  const declared = file.type.split(";")[0].trim().toLowerCase();
  if (declared && !isSupported(declared)) throw Error(IMAGE_ERRORS.format);
  let bytes: Uint8Array<ArrayBuffer>;
  try { bytes = new Uint8Array(await file.arrayBuffer()); }
  catch { throw Error(IMAGE_ERRORS.invalid); }
  let info: ReturnType<typeof inspectRaster>;
  try { info = inspectRaster(bytes); }
  catch {
    // The shared upload inspector also rejects images above its pixel ceiling.
    // Distinguish a valid oversized header from a broken one before allocating a bitmap.
    let header: ReturnType<typeof readRasterHeader>;
    try { header = readRasterHeader(bytes); } catch { throw Error(IMAGE_ERRORS.invalid); }
    if (header.type !== "png" && header.type !== "jpg") throw Error(IMAGE_ERRORS.format);
    checkSize(header);
    throw Error(IMAGE_ERRORS.invalid);
  }
  if (!isSupported(info.type)) throw Error(IMAGE_ERRORS.format);
  checkSize(info);
  const traits = rasterTraits(bytes, info.type);
  if (traits.animated) throw Error(IMAGE_ERRORS.animation);
  if (!traits.frames) throw Error(IMAGE_ERRORS.invalid);
  let image: ImageBitmap;
  try { image = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch { throw Error(IMAGE_ERRORS.invalid); }
  try { checkSize(image); }
  catch (error) { image.close(); throw error; }
  return image;
}

function checkRect(rect: MarkupRect) {
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) {
    throw Error(IMAGE_ERRORS.invalid);
  }
}

/** Outward rounding covers the entire selection, including fractional edge pixels. */
function projectRect(rect: MarkupRect, from: MarkupRect, to: Size): MarkupRect {
  const sx = to.width / from.width, sy = to.height / from.height;
  const left = Math.max(0, Math.floor((rect.x - from.x) * sx));
  const top = Math.max(0, Math.floor((rect.y - from.y) * sy));
  const right = Math.min(to.width, Math.ceil((rect.x + rect.width - from.x) * sx));
  const bottom = Math.min(to.height, Math.ceil((rect.y + rect.height - from.y) * sy));
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export function resolveMarkupCrop(width: number, height: number, marks: readonly MarkupMark[]): MarkupRect {
  checkSize({ width, height });
  const bounds = { x: 0, y: 0, width, height };
  let crop: MarkupMark | undefined;
  for (const mark of marks) if (mark.kind === "crop") crop = mark;
  if (!crop) return bounds;
  checkRect(crop);
  const result = projectRect(crop, bounds, bounds);
  checkRect(result);
  return result;
}

function canvasOf({ width, height }: Size): Canvas {
  if (typeof document === "undefined") {
    if (typeof OffscreenCanvas === "undefined") throw Error(IMAGE_MARKUP_ERRORS.exportFailed);
    return new OffscreenCanvas(width, height);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function contextOf(canvas: Canvas): Context {
  const context = canvas.getContext("2d") as Context | null;
  if (!context) throw Error(IMAGE_MARKUP_ERRORS.exportFailed);
  return context;
}

function release(canvas: Canvas | undefined) {
  if (canvas) canvas.width = canvas.height = 0;
}

function drawMasks(context: Context, masks: readonly MarkupRect[]) {
  context.fillStyle = MARKUP_MASK_COLOR;
  for (const mask of masks) context.fillRect(mask.x, mask.y, mask.width, mask.height);
}

function drawCircle(context: Context, circle: MarkupMark, crop: MarkupRect) {
  const rx = circle.width / 2, ry = circle.height / 2;
  context.beginPath();
  context.ellipse(circle.x - crop.x + rx, circle.y - crop.y + ry, rx, ry, 0, 0, 2 * Math.PI);
  context.strokeStyle = MARKUP_CIRCLE_HALO_COLOR;
  context.lineWidth = circle.stroke + MARKUP_CIRCLE_HALO_EXTRA;
  context.stroke();
  context.strokeStyle = MARKUP_CIRCLE_COLOR;
  context.lineWidth = circle.stroke;
  context.stroke();
}

type Encoding = { file: File } | { oversized: Mime } | null;

/** Browsers can silently return PNG when asked for JPEG. Inspect the actual bytes. */
async function encode(canvas: Canvas, type: Mime, quality?: number): Promise<Encoding> {
  try {
    const blob = "convertToBlob" in canvas
      ? await canvas.convertToBlob({ type, quality })
      : await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, quality));
    if (!blob?.size) return null;
    if (blob.size > IMAGE_SOURCE_BYTES) return isSupported(blob.type) ? { oversized: blob.type } : null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const detected = inspectRaster(bytes);
    if (!isSupported(detected.type)) return null;
    const cleaned = withoutMetadata(bytes, detected.type);
    const verified = assertPreparedRaster(cleaned);
    if (verified.frames !== 1 || verified.width !== canvas.width || verified.height !== canvas.height) return null;
    if (cleaned.length > MEDIA_POLICY.image.maxBytes) return { oversized: detected.type };
    const extension = detected.type === "image/jpeg" ? "jpg" : "png";
    return { file: new File([cleaned], `ticket-markup-${crypto.randomUUID()}.${extension}`, { type: detected.type }) };
  } catch { return null; }
}

async function encodeJpeg(canvas: Canvas): Promise<Encoding> {
  const opaque = canvasOf(canvas);
  try {
    const ctx = contextOf(opaque);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(canvas, 0, 0);
    let result: Encoding = null;
    for (const quality of [0.92, 0.85, 0.78, 0.7]) {
      result = await encode(opaque, "image/jpeg", quality);
      if (!result || "file" in result || result.oversized !== "image/jpeg") break;
    }
    return result;
  } finally { release(opaque); }
}

async function exportFile(canvas: Canvas, preferJpeg: boolean): Promise<File> {
  let result: Encoding;
  if (preferJpeg) {
    result = await encodeJpeg(canvas) ?? await encode(canvas, "image/png");
  } else {
    result = await encode(canvas, "image/png");
    if (result && "oversized" in result) result = await encodeJpeg(canvas) ?? result;
  }
  if (!result) throw Error(IMAGE_MARKUP_ERRORS.exportFailed);
  if ("oversized" in result) throw Error(IMAGE_MARKUP_ERRORS.tooLarge);
  return result.file;
}

/** Apply masks before resampling to prevent filter kernels from reading hidden pixels.
 * Cover their final pixel bounds again so the downsampled edges are opaque. */
export async function exportMarkupImage(image: ImageBitmap, marks: readonly MarkupMark[], sourceType: string): Promise<File> {
  const crop = resolveMarkupCrop(image.width, image.height, marks);
  for (const mark of marks) {
    checkRect(mark);
    if (mark.kind === "circle" && (!Number.isFinite(mark.stroke) || mark.stroke <= 0)) throw Error(IMAGE_ERRORS.invalid);
  }
  const masks: MarkupRect[] = [];
  let native: Canvas | undefined;
  let resized: Canvas | undefined;
  try {
    native = canvasOf(crop);
    const ctx = contextOf(native);
    ctx.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
    for (const mark of marks) {
      if (mark.kind === "circle") {
        drawCircle(ctx, mark, crop);
      } else if (mark.kind === "mask") {
        const area = projectRect(mark, crop, crop);
        if (area.width && area.height) masks.push(area);
      }
    }
    drawMasks(ctx, masks);
    let destination = native;
    const output = fitImage(crop.width, crop.height);
    if (output.width !== crop.width || output.height !== crop.height) {
      resized = canvasOf(output);
      destination = resized;
      const target = contextOf(resized);
      target.imageSmoothingQuality = "high";
      target.drawImage(native, 0, 0, output.width, output.height);
      release(native);
      native = undefined;
      const bounds = { ...crop, x: 0, y: 0 };
      drawMasks(target, masks.map(mask => projectRect(mask, bounds, output)));
    }
    return await exportFile(destination, !masks.length && sourceType.split(";")[0].trim().toLowerCase() === "image/jpeg");
  } finally {
    release(native);
    release(resized);
  }
}
