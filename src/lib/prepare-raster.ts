import {
  encodedName,
  fitImage,
  IMAGE_ERRORS,
  IMAGE_HEIGHT,
  IMAGE_SOURCE_BYTES,
  IMAGE_WIDTH,
  imageErrorCode,
  inspectRaster,
  pixelPolicy,
} from "../../shared/image-optimization";
import { assertPreparedRaster, cleanCopy, rasterTraits, withoutMetadata } from "../../shared/raster-structure";

type Canvas = HTMLCanvasElement | OffscreenCanvas;
type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function encode(canvas: Canvas, type: string, quality?: number): Promise<Blob | null> {
  return "convertToBlob" in canvas
    ? canvas.convertToBlob({ type, quality })
    : new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

const encoders = new Map<string, boolean>();
/** A browser without an encoder silently returns PNG, so check the returned type. */
async function supports(type: string) {
  if (encoders.has(type)) return encoders.get(type);
  const probe = typeof document === "undefined" ? new OffscreenCanvas(1, 1) : document.createElement("canvas");
  probe.width = probe.height = 1;
  // An OffscreenCanvas cannot encode until it has a rendering context.
  probe.getContext("2d");
  let supported = false;
  try {
    supported = (await encode(probe, type))?.type === type;
  } catch {
    /* Optional encoder unavailable. */
  }
  encoders.set(type, supported);
  return supported;
}

async function decode(blob: Blob) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(blob, { imageOrientation: "from-image" });
    } catch {
      if (typeof document === "undefined") throw new Error(IMAGE_ERRORS.invalid);
    }
  }
  const url = URL.createObjectURL(blob);
  const img = new Image();
  try {
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

/**
 * Prepare one image in the browser with the native canvas encoders: fit within
 * Full HD, remove metadata, then keep the smallest encoding that looks the same
 * as the resized reference. The result always passes `assertPreparedRaster`.
 * Throws one of `IMAGE_ERRORS`.
 */
export async function prepareRaster(file: File) {
  try {
    return await prepare(file);
  } catch (error) {
    throw new Error(imageErrorCode(error));
  }
}

async function prepare(file: File) {
  if (file.size > IMAGE_SOURCE_BYTES) throw new Error(IMAGE_ERRORS.invalid);
  const source = new Uint8Array(await file.arrayBuffer());
  const info = inspectRaster(source);
  const traits = rasterTraits(source, info.type);
  if (traits.animated || info.type === "image/x-icon") {
    // Canvas encoders write a single frame, so animations keep their own bytes.
    const tooLarge = info.width > IMAGE_WIDTH || info.height > IMAGE_HEIGHT;
    if (traits.animated && (tooLarge || info.type === "image/avif")) throw new Error(IMAGE_ERRORS.animation);
    return output(file, { bytes: source, type: info.type }, withoutMetadata(source, info.type), info.type);
  }
  let image: ImageBitmap | HTMLImageElement;
  try {
    image = await decode(file);
  } catch {
    // Only Safari decodes HEIC; other browsers recognise it but cannot draw it.
    throw new Error(info.type === "image/heic" || info.type === "image/heif" ? IMAGE_ERRORS.format : IMAGE_ERRORS.invalid);
  }
  const { width, height } = fitImage(image.width, image.height);
  const sameSize = width === info.width && height === info.height;
  const canvas = typeof document === "undefined" ? new OffscreenCanvas(width, height) : document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true }) as Context | null;
  if (!ctx) throw new Error(IMAGE_ERRORS.invalid);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, 0, 0, width, height);
  if ("close" in image) image.close();
  const reference = ctx.getImageData(0, 0, width, height);
  const policy = pixelPolicy(reference.data, width);
  const looksSame = async (bytes: Uint8Array<ArrayBuffer>, type: string) => {
    const check = await decode(new Blob([bytes], { type }));
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(check, 0, 0);
    if ("close" in check) check.close();
    return policy.faithful(ctx.getImageData(0, 0, width, height).data);
  };

  const lossless = await encode(canvas, "image/png");
  if (!lossless) throw new Error(IMAGE_ERRORS.invalid);
  let best = { bytes: withoutMetadata(await bytesOf(lossless), "image/png"), type: "image/png" };
  if (sameSize) {
    // At the original size, the original itself (or a copy without its metadata)
    // usually beats a re-encode and loses nothing.
    if (traits.clean && source.length <= best.bytes.length) best = { bytes: source, type: info.type };
    else if (!traits.clean) {
      const stripped = cleanCopy(source, info.type);
      if (stripped && stripped.length < best.bytes.length && await looksSame(stripped, info.type)) best = { bytes: stripped, type: info.type };
    }
  }
  if (best.bytes.length > 512) {
    for (const [type, quality] of [["image/webp", 0.92], ["image/jpeg", 0.92], ["image/avif", 0.84]] as const) {
      if ((type === "image/jpeg" && !policy.opaque) || !(await supports(type))) continue;
      ctx.putImageData(reference, 0, 0);
      const blob = await encode(canvas, type, quality);
      if (!blob || blob.type !== type) continue;
      // Chromium tags canvas output with its sRGB profile. Untagged images are
      // shown as sRGB, so removing it changes nothing; the comparison confirms that.
      const bytes = withoutMetadata(await bytesOf(blob), type);
      if (bytes.length < best.bytes.length && await looksSame(bytes, type)) best = { bytes, type };
    }
  }
  return output(file, { bytes: source, type: info.type }, best.bytes, best.type);
}

/** The original File when its bytes and type are kept, otherwise a renamed copy. */
function output(file: File, source: { bytes: Uint8Array; type: string }, bytes: Uint8Array<ArrayBuffer>, type: string) {
  assertPreparedRaster(bytes);
  if (bytes === source.bytes && file.type === type) return file;
  return new File([bytes], type === source.type ? file.name : encodedName(file.name, type), { type, lastModified: file.lastModified });
}
