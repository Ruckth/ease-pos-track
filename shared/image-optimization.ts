import { imageSize } from "image-size";

export const IMAGE_SOURCE_BYTES = 20 * 1024 * 1024;
export const IMAGE_SOURCE_PIXELS = 40_000_000;
export const IMAGE_WIDTH = 1920;
export const IMAGE_HEIGHT = 1080;

/** Error codes shared by the browser, CLI and server image pipelines. */
export const IMAGE_ERRORS = {
  /** Unreadable, malformed, over the source limits, or not a supported raster. */
  invalid: "IMAGE_INVALID",
  /** An animation we cannot keep: APNG or animated AVIF over Full HD, animated AVIF
   * anywhere, or any animation over Full HD in the browser (no animated encoder). */
  animation: "IMAGE_ANIMATION_UNSUPPORTED",
  /** A recognised format this runtime cannot decode, such as HEIC outside Safari. */
  format: "IMAGE_FORMAT_UNSUPPORTED",
} as const;

/** The specific image error code carried by `error`, otherwise `IMAGE_INVALID`. */
export function imageErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return Object.values(IMAGE_ERRORS).find(code => code === message) ?? IMAGE_ERRORS.invalid;
}

const mimeTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  avif: "image/avif",
  gif: "image/gif",
  ico: "image/x-icon",
  heic: "image/heic",
  heif: "image/heif",
};

/** Read raw dimensions before choosing decode limits. */
export function readRasterHeader(bytes: Uint8Array) {
  // Valid JPEGs may start directly with a frame header when metadata was
  // removed. image-size expects at least one segment before that header.
  const firstFrame = bytes.length >= 11 && bytes[0] === 0xff && bytes[1] === 0xd8
    && bytes[2] === 0xff && [0xc0, 0xc1, 0xc2].includes(bytes[3]);
  return firstFrame
    ? { type: "jpg", height: bytes[7] * 256 + bytes[8], width: bytes[9] * 256 + bytes[10], images: [] }
    : imageSize(bytes);
}

/** Detect the format and declared size from the header, before decoding anything. */
export function inspectRaster(bytes: Uint8Array, fullHD = false) {
  try {
    if (!bytes.length || bytes.length > IMAGE_SOURCE_BYTES) throw Error();
    const image = readRasterHeader(bytes);
    const type = mimeTypes[image.type ?? ""];
    if (!type) throw Error();
    for (const frame of [image, ...(image.images ?? [])]) {
      if (
        !Number.isSafeInteger(frame.width) ||
        !Number.isSafeInteger(frame.height) ||
        frame.width <= 0 ||
        frame.height <= 0 ||
        frame.width * frame.height > IMAGE_SOURCE_PIXELS
      )
        throw Error();
      if (fullHD && (frame.width > IMAGE_WIDTH || frame.height > IMAGE_HEIGHT))
        throw Error();
    }
    return { type, width: image.width, height: image.height };
  } catch {
    throw new Error(IMAGE_ERRORS.invalid);
  }
}

export function fitImage(width: number, height: number) {
  const scale = Math.min(1, IMAGE_WIDTH / width, IMAGE_HEIGHT / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

const LUMA = [0.299, 0.587, 0.114];
/** Share of pixels whose colour may move beyond the per-channel limit in photo mode. */
const PHOTO_COLOUR_SHIFT = 0.005;

/**
 * Whether a candidate encoding looks the same as the reference pixels.
 *
 * Alpha must match exactly. By default every colour channel stays within 24
 * levels on every pixel, so small text and one-pixel UI edges cannot blur or
 * change colour. `photo` relaxes colour only: brightness (luma), which carries
 * edges and legibility, still stays within 24 on every pixel, while chroma
 * subsampling may shift the colour of up to 0.5% of pixels further. Both modes
 * cap the mean squared error at 12 per channel.
 */
export function faithfulPixels(
  reference: Uint8Array | Uint8ClampedArray,
  pixels: Uint8Array | Uint8ClampedArray,
  photo = false,
) {
  if (pixels.length !== reference.length) return false;
  let squared = 0;
  let colourShifted = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = reference[i + 3];
    if (alpha !== pixels[i + 3]) return false;
    let luma = 0;
    let shifted = false;
    for (let c = 0; c < 3; c++) {
      const delta = ((reference[i + c] - pixels[i + c]) * alpha) / 255;
      if (Math.abs(delta) > 24) {
        if (!photo) return false;
        shifted = true;
      }
      squared += delta * delta;
      luma += LUMA[c] * delta;
    }
    if (shifted && (Math.abs(luma) > 24 || ++colourShifted > (pixels.length / 4) * PHOTO_COLOUR_SHIFT)) return false;
  }
  return squared <= (pixels.length / 4) * 3 * 12;
}

/**
 * How to judge candidates for one resized reference (RGBA rows of `width`).
 *
 * Camera photos have sensor noise and gradients, so horizontally neighbouring
 * pixels rarely match exactly (under 55% in the photos we measured).
 * Screenshots, documents and UI are mostly flat fills (over 75%). Only opaque
 * photographic content gets the colour tolerance of `faithfulPixels`; anything
 * that looks like UI keeps the strict comparison.
 */
export function pixelPolicy(reference: Uint8Array | Uint8ClampedArray, width: number) {
  let opaque = true;
  for (let i = 3; i < reference.length; i += 4) {
    if (reference[i] !== 255) {
      opaque = false;
      break;
    }
  }
  let same = 0;
  let pairs = 0;
  // Every third pixel is enough to tell the two kinds of content apart.
  for (let pixel = 0; pixel + 1 < reference.length / 4; pixel += 3) {
    if (pixel % width === width - 1) continue;
    const i = pixel * 4;
    pairs++;
    if (reference[i] === reference[i + 4] && reference[i + 1] === reference[i + 5] && reference[i + 2] === reference[i + 6]) same++;
  }
  const photo = opaque && pairs > 0 && same / pairs < 0.6;
  return {
    opaque,
    photo,
    faithful: (pixels: Uint8Array | Uint8ClampedArray) => faithfulPixels(reference, pixels, photo),
  };
}

export function encodedName(name: string, type: string) {
  const ext = type === "image/jpeg" ? "jpg" : type.split("/")[1];
  return name.replace(/\.[^.]*$/, "") + "." + ext;
}
