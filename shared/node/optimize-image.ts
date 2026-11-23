import sharp from "sharp";
import {
  encodedName,
  IMAGE_ERRORS,
  IMAGE_HEIGHT,
  IMAGE_SOURCE_BYTES,
  IMAGE_SOURCE_PIXELS,
  IMAGE_WIDTH,
  imageErrorCode,
  inspectRaster,
  pixelPolicy,
} from "../image-optimization";
import { assertPreparedRaster, cleanCopy, rasterTraits, withoutMetadata } from "../raster-structure";

const fit = { width: IMAGE_WIDTH, height: IMAGE_HEIGHT, fit: "inside", withoutEnlargement: true } as const;
const decodeOptions = { limitInputPixels: IMAGE_SOURCE_PIXELS, failOn: "warning" } as const;

/** Sharp recognises only Node Buffers from its own realm (Convex actions may pass others). */
const buffer = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** Whether this libvips build decodes HEIC (Sharp's prebuilt binaries decode only AVIF). */
const decodesHeic = () => (sharp.format.heif?.input.fileSuffix ?? []).includes(".heic");

/**
 * Prepare one image with Sharp: fit within Full HD, remove metadata, then keep
 * the smallest encoding that looks the same as the resized reference.
 * Throws one of `IMAGE_ERRORS`.
 */
export async function optimizeImage(file: File): Promise<File> {
  try {
    if (file.size > IMAGE_SOURCE_BYTES) throw new Error(IMAGE_ERRORS.invalid);
    const source = new Uint8Array(await file.arrayBuffer());
    const info = inspectRaster(source);
    if ((info.type === "image/heic" || info.type === "image/heif") && !decodesHeic())
      throw new Error(IMAGE_ERRORS.format);
    const traits = rasterTraits(source, info.type);
    const prepared = info.type === "image/x-icon"
      ? { bytes: withoutMetadata(source, info.type), type: info.type }
      : traits.animated
        ? await animation(source, info)
        : await still(source, info, traits.clean);
    assertPreparedRaster(prepared.bytes);
    return new File([prepared.bytes], prepared.type === info.type ? file.name : encodedName(file.name, prepared.type), {
      type: prepared.type,
      lastModified: file.lastModified,
    });
  } catch (error) {
    throw new Error(imageErrorCode(error));
  }
}

type Source = { type: string; width: number; height: number };

/**
 * Animations within Full HD keep their frames and timing byte for byte, minus
 * metadata. Larger GIF and WebP animations are resized to lossless animated WebP
 * with every frame and delay checked; libvips cannot write APNG or animated AVIF.
 */
async function animation(source: Uint8Array<ArrayBuffer>, info: Source) {
  if (info.type === "image/avif") throw new Error(IMAGE_ERRORS.animation);
  if (info.width <= IMAGE_WIDTH && info.height <= IMAGE_HEIGHT)
    return { bytes: withoutMetadata(source, info.type), type: info.type };
  if (info.type !== "image/gif" && info.type !== "image/webp") throw new Error(IMAGE_ERRORS.animation);
  const input = sharp(buffer(source), { ...decodeOptions, animated: true });
  const meta = await input.metadata();
  const frames = meta.pages ?? 1;
  if (info.width * info.height * frames > IMAGE_SOURCE_PIXELS) throw new Error(IMAGE_ERRORS.animation);
  const bytes = await input.resize(fit).webp({ lossless: true, effort: 3 }).toBuffer();
  const out = await sharp(bytes, { animated: true }).metadata();
  const sameTiming = (out.delay ?? []).join() === (meta.delay ?? []).join() && (out.loop ?? 0) === (meta.loop ?? 0);
  if ((out.pages ?? 1) !== frames || !sameTiming) throw new Error(IMAGE_ERRORS.animation);
  return { bytes: new Uint8Array(bytes), type: "image/webp" };
}

/** Candidates must be smaller than the best so far and pass the pixel comparison. */
async function still(source: Uint8Array<ArrayBuffer>, info: Source, clean: boolean) {
  const { data, info: raw } = await sharp(buffer(source), decodeOptions)
    .rotate()
    .resize(fit)
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const base = sharp(data, { raw: { width: raw.width, height: raw.height, channels: 4 } });
  const policy = pixelPolicy(data, raw.width);
  const decodes = async (bytes: Uint8Array) => policy.faithful(await sharp(buffer(bytes)).ensureAlpha().raw().toBuffer());

  let best = { bytes: new Uint8Array(await base.clone().webp({ lossless: true, effort: 3 }).toBuffer()), type: "image/webp" };
  if (raw.width === info.width && raw.height === info.height) {
    // At the original size, the original itself (or a copy without its metadata)
    // usually beats a re-encode and loses nothing.
    if (clean && source.length <= best.bytes.length) best = { bytes: source, type: info.type };
    else if (!clean) {
      const stripped = cleanCopy(source, info.type);
      if (stripped && stripped.length < best.bytes.length && await decodes(stripped)) best = { bytes: stripped, type: info.type };
    }
  }
  if (best.bytes.length <= 512) return best;
  const candidates = [
    { type: "image/webp", encode: () => base.clone().webp({ quality: 90, smartSubsample: true }).toBuffer() },
    ...(policy.opaque
      ? [{ type: "image/jpeg", encode: () => base.clone().jpeg({ quality: 91, chromaSubsampling: "4:4:4" }).toBuffer() }]
      : []),
    { type: "image/avif", encode: () => base.clone().avif({ quality: 70, effort: 3, chromaSubsampling: "4:4:4" }).toBuffer() },
  ];
  for (const candidate of candidates) {
    const bytes = new Uint8Array(await candidate.encode());
    if (bytes.length < best.bytes.length && await decodes(bytes)) best = { bytes, type: candidate.type };
  }
  return best;
}
