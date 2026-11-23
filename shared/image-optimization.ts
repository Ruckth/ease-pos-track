import { imageSize } from "image-size";

export const IMAGE_SOURCE_BYTES = 20 * 1024 * 1024;
export const IMAGE_SOURCE_PIXELS = 40_000_000;
export const IMAGE_WIDTH = 1920;
export const IMAGE_HEIGHT = 1080;
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

export function inspectRaster(bytes: Uint8Array, fullHD = false) {
  try {
    if (!bytes.length || bytes.length > IMAGE_SOURCE_BYTES) throw Error();
    // Valid JPEGs may start directly with a frame header when metadata was
    // removed. image-size expects at least one segment before that header.
    const firstFrame = bytes.length >= 11 && bytes[0] === 0xff && bytes[1] === 0xd8
      && bytes[2] === 0xff && [0xc0, 0xc1, 0xc2].includes(bytes[3]);
    const image = firstFrame
      ? { type: "jpg", height: bytes[7] * 256 + bytes[8], width: bytes[9] * 256 + bytes[10], images: [] }
      : imageSize(bytes);
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
    throw new Error("IMAGE_INVALID");
  }
}

export function fitImage(width: number, height: number) {
  const scale = Math.min(1, IMAGE_WIDTH / width, IMAGE_HEIGHT / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Compare the candidate with the resized reference. Reject large local errors (text
 * edges), excessive average error and any alpha change, even on isolated pixels. */
export function faithfulPixels(
  reference: Uint8Array | Uint8ClampedArray,
  pixels: Uint8Array | Uint8ClampedArray,
) {
  if (pixels.length !== reference.length) return false;
  let squared = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = reference[i + 3];
    if (alpha !== pixels[i + 3]) return false;
    for (let c = 0; c < 3; c++) {
      const delta = ((reference[i + c] - pixels[i + c]) * alpha) / 255;
      if (Math.abs(delta) > 24) return false;
      squared += delta * delta;
    }
  }
  return squared <= (pixels.length / 4) * 3 * 12;
}

const text = new TextDecoder("latin1");
/** Read native container chunk boundaries, never search compressed pixel bytes. */
export function rasterTraits(bytes: Uint8Array, type: string) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let animated = type === "image/gif";
  let simple = type === "image/jpeg" && cleanJpeg(bytes);
  if (type === "image/png" || type === "image/webp") {
    const png = type === "image/png";
    let end = png ? 8 : 12;
    simple = true;
    let pixels = false;
    let tail = false;
    while (end + (png ? 12 : 8) <= bytes.length) {
      const nameStart = end + (png ? 4 : 0);
      const name = text.decode(bytes.subarray(nameStart, nameStart + 4));
      const size = view.getUint32(end + (png ? 0 : 4), !png);
      if (name === "acTL" || name === "ANIM") animated = true;
      if (["IDAT", "VP8 ", "VP8L", "ANMF"].includes(name)) pixels = true;
      tail = name === "IEND";
      if (
        !(
          png
            ? ["IHDR", "PLTE", "tRNS", "IDAT", "IEND", "sRGB", "gAMA", "cHRM"]
            : ["VP8 ", "VP8L", "VP8X", "ALPH"]
        ).includes(name)
      )
        simple = false;
      end += size + (png ? 12 : 8 + (size % 2));
    }
    if (end !== bytes.length || !pixels || (png && !tail))
      throw new Error("IMAGE_INVALID");
  }
  if (type === "image/avif")
    animated = text
      .decode(bytes.subarray(8, Math.min(bytes.length, 64)))
      .includes("avis");
  return { animated, simple };
}

export function encodedName(name: string, type: string) {
  const ext = type === "image/jpeg" ? "jpg" : type.split("/")[1];
  return name.replace(/\.[^.]*$/, "") + "." + ext;
}

/** Private application segments prevent retaining a JPEG verbatim. Entropy-coded
 * FF bytes are stuffed, so scanning also covers multi-scan/progressive JPEGs. */
export function cleanJpeg(bytes: Uint8Array) {
  if (bytes[bytes.length - 2] !== 255 || bytes[bytes.length - 1] !== 217)
    return false;
  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] !== 255) continue;
    const marker = bytes[i + 1];
    if (
      marker === 224 &&
      !(
        bytes[i + 2] === 0 &&
        bytes[i + 3] === 16 &&
        text.decode(bytes.subarray(i + 4, i + 9)) === "JFIF\0"
      )
    )
      return false;
    if ((marker >= 225 && marker <= 239) || marker === 254) return false;
  }
  return true;
}

/** Strip metadata segments before the first JPEG scan without recompressing.
 * Callers compare the decoded result to the oriented, color-managed reference:
 * removing orientation or an ICC profile can change its appearance. */
export function jpegWithoutMetadata(bytes: Uint8Array<ArrayBuffer>) {
  const chunks: Uint8Array[] = [bytes.subarray(0, 2)];
  let start = 2;
  while (start + 4 <= bytes.length && bytes[start] === 0xff) {
    const marker = bytes[start + 1];
    if (marker === 0xda) {
      chunks.push(bytes.subarray(start));
      const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      if (size === bytes.length) return;
      const clean = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        clean.set(chunk, offset);
        offset += chunk.length;
      }
      return cleanJpeg(clean) ? clean : undefined;
    }
    const size = bytes[start + 2] * 256 + bytes[start + 3];
    const end = start + 2 + size;
    if (size < 2 || end > bytes.length) return;
    if ((marker < 0xe0 || marker > 0xef) && marker !== 0xfe) {
      chunks.push(bytes.subarray(start, end));
    }
    start = end;
  }
}

/** Remove private ancillary records without touching compressed frames or timing.
 * GIF application extensions can carry arbitrary metadata; retain its loop control. */
export function stripRasterMetadata(
  bytes: Uint8Array<ArrayBuffer>,
  type: string,
): Uint8Array<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  let removed = false;
  if (type === "image/gif") {
    let p = 13 + (bytes[10] & 128 ? 3 * (2 << (bytes[10] & 7)) : 0);
    chunks.push(bytes.subarray(0, p));
    while (p < bytes.length) {
      const start = p,
        tag = bytes[p++];
      if (tag === 0x3b) {
        chunks.push(bytes.subarray(start, p));
        removed ||= p !== bytes.length;
        break;
      }
      let keep = true;
      if (tag === 0x2c) {
        const flags = bytes[p + 8];
        p += 10 + (flags & 128 ? 3 * (2 << (flags & 7)) : 0);
      } else if (tag === 0x21) {
        const label = bytes[p++];
        keep =
          label === 0xf9 ||
          (label === 0xff &&
            ["NETSCAPE2.0", "ANIMEXTS1.0"].includes(
              text.decode(bytes.subarray(p + 1, p + 12)),
            ));
      } else throw new Error("IMAGE_INVALID");
      while (p < bytes.length && bytes[p]) p += 1 + bytes[p];
      if (p >= bytes.length) throw new Error("IMAGE_INVALID");
      p++;
      if (keep) chunks.push(bytes.subarray(start, p));
      else removed = true;
    }
    if (chunks[chunks.length - 1]?.[0] !== 0x3b)
      throw new Error("IMAGE_INVALID");
  } else if (type === "image/png" || type === "image/webp") {
    const png = type === "image/png";
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let p = png ? 8 : 12;
    chunks.push(bytes.subarray(0, p));
    while (p < bytes.length) {
      const start = p;
      const n = view.getUint32(p + (png ? 0 : 4), !png);
      const off = p + (png ? 4 : 0);
      const name = text.decode(bytes.subarray(off, off + 4));
      p += n + (png ? 12 : 8 + (n % 2));
      if (p > bytes.length) throw new Error("IMAGE_INVALID");
      if (
        ["eXIf", "tEXt", "iTXt", "zTXt", "tIME", "EXIF", "XMP "].includes(name)
      )
        removed = true;
      else chunks.push(bytes.subarray(start, p));
    }
  } else return bytes;
  if (!removed) return bytes;
  const out = new Uint8Array(
    chunks.reduce((count, chunk) => count + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  if (type === "image/webp") {
    new DataView(out.buffer).setUint32(4, out.length - 8, true);
    if (text.decode(out.subarray(12, 16)) === "VP8X") out[20] &= ~0x0c;
  }
  return out;
}
