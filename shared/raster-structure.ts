/**
 * Byte-level structure of the raster formats Tickets store.
 *
 * A prepared image (the bytes we upload, store and serve) must be clean: a
 * well-formed container holding only the records a decoder needs to draw the
 * pixels, ending exactly where the format ends. Anything else (camera EXIF, XMP,
 * comments, colour profiles, private or unknown records, bytes after the end
 * marker) is rejected. These checks read container records only; they never
 * search compressed pixel data. Node additionally decodes the pixels with Sharp
 * (`shared/node/validate-raster.ts`).
 *
 * A source image (what a person chose) may carry metadata. `withoutMetadata`
 * removes it without re-encoding, after which the same checks pass.
 */
import { IMAGE_ERRORS, inspectRaster } from "./image-optimization.js";

const latin1 = new TextDecoder("latin1");
const ascii = (bytes: Uint8Array, at: number, length = 4) => latin1.decode(bytes.subarray(at, at + length));
const u16be = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const u16le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u24le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
const u32be = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const u32le = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

function check(condition: unknown): asserts condition {
  if (!condition) throw new Error(IMAGE_ERRORS.invalid);
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// JPEG

type JpegSegment = { marker: number; start: number; end: number };
const JPEG_FRAMES = new Set([0xc0, 0xc1, 0xc2]); // baseline, extended and progressive Huffman
const JPEG_TABLES = new Set([0xc4, 0xdb, 0xdd]); // Huffman tables, quantization tables, restart interval
const isJpegMetadata = (marker: number) => (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;

/** Marker segments up to the end-of-image marker. A scan segment extends over its
 * entropy-coded data, where 0xFF bytes are always followed by 0x00 or a restart marker. */
function jpegSegments(bytes: Uint8Array) {
  check(bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8);
  const segments: JpegSegment[] = [];
  let p = 2;
  for (;;) {
    check(p + 1 < bytes.length && bytes[p] === 0xff);
    while (bytes[p + 1] === 0xff) {
      p++; // optional fill bytes before a marker
      check(p + 1 < bytes.length);
    }
    const marker = bytes[p + 1];
    if (marker === 0xd9) return { segments, end: p + 2 };
    check(marker !== 0x00 && marker !== 0x01 && !(marker >= 0xd0 && marker <= 0xd8));
    check(p + 4 <= bytes.length);
    let end = p + 2 + u16be(bytes, p + 2);
    check(u16be(bytes, p + 2) >= 2 && end <= bytes.length);
    if (marker === 0xda) {
      while (end < bytes.length) {
        if (bytes[end] === 0xff && end + 1 < bytes.length) {
          const next = bytes[end + 1];
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
            end += 2;
            continue;
          }
          break;
        }
        end++;
      }
    }
    segments.push({ marker, start: p, end });
    p = end;
  }
}

/** A JFIF header without an embedded thumbnail. */
function plainJfif(bytes: Uint8Array, segment: JpegSegment) {
  return segment.end - segment.start === 18 && ascii(bytes, segment.start + 4, 5) === "JFIF\0"
    && bytes[segment.start + 16] === 0 && bytes[segment.start + 17] === 0;
}

function cleanJpeg(bytes: Uint8Array) {
  const { segments, end } = jpegSegments(bytes);
  check(end === bytes.length);
  let frame: JpegSegment | undefined;
  let scans = 0;
  for (const segment of segments) {
    if (JPEG_FRAMES.has(segment.marker)) {
      check(!frame);
      frame = segment;
    } else if (segment.marker === 0xda) {
      check(frame);
      scans++;
    } else check(JPEG_TABLES.has(segment.marker) || (segment.marker === 0xe0 && plainJfif(bytes, segment)));
  }
  check(frame && scans > 0);
  check(u16be(bytes, frame.start + 5) > 0 && u16be(bytes, frame.start + 7) > 0);
  return 1;
}

function jpegWithoutMetadata(bytes: Uint8Array) {
  const { segments } = jpegSegments(bytes);
  const kept = segments.filter(segment => !isJpegMetadata(segment.marker));
  return concat([bytes.subarray(0, 2), ...kept.map(s => bytes.subarray(s.start, s.end)), new Uint8Array([0xff, 0xd9])]);
}

// ---------------------------------------------------------------------------
// PNG and APNG

type PngChunk = { name: string; start: number; data: Uint8Array; end: number };
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
/** Records needed to draw the pixels: header, palette, transparency, data, end,
 * standard sRGB/gamma/chromaticity colour notes, pixel density and APNG frames. */
const PNG_CHUNKS = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND", "sRGB", "gAMA", "cHRM", "pHYs", "acTL", "fcTL", "fdAT"]);

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Chunks through IEND, each with a verified checksum. */
function pngChunks(bytes: Uint8Array) {
  check(bytes.length >= 8 && PNG_SIGNATURE.every((value, index) => bytes[index] === value));
  const chunks: PngChunk[] = [];
  let p = 8;
  for (;;) {
    check(p + 12 <= bytes.length);
    const length = u32be(bytes, p);
    const end = p + 12 + length;
    check(length < 2 ** 31 && end <= bytes.length);
    const name = ascii(bytes, p + 4);
    check(/^[A-Za-z]{4}$/.test(name));
    check(crc32(bytes.subarray(p + 4, p + 8 + length)) === u32be(bytes, p + 8 + length));
    chunks.push({ name, start: p, data: bytes.subarray(p + 8, p + 8 + length), end });
    p = end;
    if (name === "IEND") return { chunks, end };
  }
}

function cleanPng(bytes: Uint8Array) {
  const { chunks, end } = pngChunks(bytes);
  check(end === bytes.length);
  const [header] = chunks;
  check(header.name === "IHDR" && header.data.length === 13);
  const width = u32be(header.data, 0), height = u32be(header.data, 4);
  check(width > 0 && height > 0);
  check(chunks.at(-1)!.data.length === 0);
  // Image data chunks are consecutive.
  const firstData = chunks.findIndex(chunk => chunk.name === "IDAT");
  const dataRuns = chunks.filter((chunk, index) => chunk.name === "IDAT" && chunks[index - 1]?.name !== "IDAT");
  check(firstData > 0 && dataRuns.length === 1);
  for (const [index, chunk] of chunks.entries()) {
    check(PNG_CHUNKS.has(chunk.name));
    if (index > 0) check(chunk.name !== "IHDR");
    if (chunk.name === "PLTE" || chunk.name === "acTL") check(index < firstData);
  }
  return apngFrames(chunks, width, height, firstData);
}

/** APNG frames must be numbered in order, fit the canvas and each carry image data. */
function apngFrames(chunks: PngChunk[], width: number, height: number, firstData: number) {
  const control = chunks.filter(chunk => chunk.name === "acTL");
  const animated = chunks.filter(chunk => chunk.name === "fcTL" || chunk.name === "fdAT");
  if (!control.length) {
    check(!animated.length);
    return 1;
  }
  check(control.length === 1 && control[0].data.length === 8);
  const frames = u32be(control[0].data, 0);
  check(frames >= 1);
  let sequence = 0;
  let controls = 0;
  let frameHasData = true;
  for (const [index, chunk] of chunks.entries()) {
    if (chunk.name === "fcTL") {
      check(frameHasData && chunk.data.length === 26 && u32be(chunk.data, 0) === sequence++);
      const [w, h, x, y] = [4, 8, 12, 16].map(at => u32be(chunk.data, at));
      check(w > 0 && h > 0 && x + w <= width && y + h <= height && chunk.data[24] <= 2 && chunk.data[25] <= 1);
      // A control before the default image makes it frame one, covering the canvas.
      if (index < firstData) check(controls === 0 && x === 0 && y === 0 && w === width && h === height);
      controls++;
      frameHasData = index < firstData;
    } else if (chunk.name === "fdAT") {
      check(controls > 0 && index > firstData && chunk.data.length > 4 && u32be(chunk.data, 0) === sequence++);
      frameHasData = true;
    }
  }
  check(frameHasData && controls === frames);
  return frames;
}

function pngWithoutMetadata(bytes: Uint8Array) {
  const { chunks, end } = pngChunks(bytes);
  // An unknown critical chunk (uppercase first letter) is required for decoding.
  check(chunks.every(chunk => PNG_CHUNKS.has(chunk.name) || chunk.name.charCodeAt(0) >= 97));
  const kept = chunks.filter(chunk => PNG_CHUNKS.has(chunk.name));
  if (kept.length === chunks.length && end === bytes.length) return bytes;
  return concat([bytes.subarray(0, 8), ...kept.map(chunk => bytes.subarray(chunk.start, chunk.end))]);
}

// ---------------------------------------------------------------------------
// WebP (RIFF)

type RiffChunk = { name: string; start: number; data: Uint8Array; end: number };
const WEBP_FLAGS = { icc: 0x20, alpha: 0x10, exif: 0x08, xmp: 0x04, animation: 0x02 };

function riffChunks(bytes: Uint8Array, from: number, to: number) {
  const chunks: RiffChunk[] = [];
  for (let p = from; p < to;) {
    check(p + 8 <= to);
    const size = u32le(bytes, p + 4);
    const end = p + 8 + size + (size % 2);
    check(end <= to);
    chunks.push({ name: ascii(bytes, p), start: p, data: bytes.subarray(p + 8, p + 8 + size), end });
    p = end;
  }
  return chunks;
}

function webpChunks(bytes: Uint8Array) {
  check(bytes.length >= 12 && ascii(bytes, 0) === "RIFF" && ascii(bytes, 8) === "WEBP");
  const end = 8 + u32le(bytes, 4);
  check(end >= 12 && end <= bytes.length);
  return { chunks: riffChunks(bytes, 12, end), end };
}

/** One frame's bitstream: optional alpha with lossy data, or lossless data. */
function webpBitstream(chunks: RiffChunk[]) {
  const names = chunks.map(chunk => chunk.name).join(",");
  check(["VP8 ", "ALPH,VP8 ", "VP8L"].includes(names));
  const image = chunks.at(-1)!;
  if (image.name === "VP8L") check(image.data.length >= 5 && image.data[0] === 0x2f);
  else check(image.data.length >= 10 && image.data[3] === 0x9d && image.data[4] === 0x01 && image.data[5] === 0x2a);
}

function cleanWebp(bytes: Uint8Array) {
  const { chunks, end } = webpChunks(bytes);
  check(end === bytes.length && chunks.length > 0);
  if (chunks[0].name !== "VP8X") {
    webpBitstream(chunks);
    return 1;
  }
  const [header, ...rest] = chunks;
  check(header.data.length === 10);
  const flags = header.data[0];
  check((flags & (WEBP_FLAGS.icc | WEBP_FLAGS.exif | WEBP_FLAGS.xmp | 0xc1)) === 0);
  const width = 1 + u24le(header.data, 4), height = 1 + u24le(header.data, 7);
  if (!(flags & WEBP_FLAGS.animation)) {
    webpBitstream(rest);
    return 1;
  }
  check(rest[0]?.name === "ANIM" && rest[0].data.length === 6 && rest.length > 1);
  for (const frame of rest.slice(1)) {
    check(frame.name === "ANMF" && frame.data.length > 16);
    const [x, y] = [0, 3].map(at => 2 * u24le(frame.data, at));
    const [w, h] = [6, 9].map(at => 1 + u24le(frame.data, at));
    check(x + w <= width && y + h <= height && (frame.data[15] & 0xfc) === 0);
    webpBitstream(riffChunks(frame.data, 16, frame.data.length));
  }
  return rest.length - 1;
}

function webpWithoutMetadata(bytes: Uint8Array) {
  const { chunks, end } = webpChunks(bytes);
  check(chunks.length > 0);
  const extended = chunks[0].name === "VP8X";
  const kept = extended ? chunks.filter(chunk => ["VP8X", "ANIM", "ANMF", "ALPH", "VP8 ", "VP8L"].includes(chunk.name)) : chunks;
  if (kept.length === chunks.length && end === bytes.length && !(extended && chunks[0].data[0] & (WEBP_FLAGS.icc | WEBP_FLAGS.exif | WEBP_FLAGS.xmp))) return bytes;
  const out = concat([bytes.subarray(0, 12), ...kept.map(chunk => bytes.subarray(chunk.start, chunk.end))]);
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  if (extended) out[20] &= ~(WEBP_FLAGS.icc | WEBP_FLAGS.exif | WEBP_FLAGS.xmp);
  return out;
}

// ---------------------------------------------------------------------------
// GIF

type GifBlock = { start: number; end: number; keep: boolean; image: boolean };

/** Blocks after the header and global palette, through the trailer. Only images,
 * frame timing (graphic control) and the loop count are needed for display. */
function gifBlocks(bytes: Uint8Array) {
  check(bytes.length >= 14 && ["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6)));
  const palette = (flags: number) => (flags & 0x80 ? 3 * (2 << (flags & 7)) : 0);
  const header = 13 + palette(bytes[10]);
  const blocks: GifBlock[] = [];
  const subBlocks = (p: number) => {
    while (p < bytes.length && bytes[p]) p += 1 + bytes[p];
    check(p < bytes.length);
    return p + 1;
  };
  for (let p = header; ;) {
    check(p < bytes.length);
    const start = p;
    const tag = bytes[p];
    if (tag === 0x3b) return { header, blocks, end: p + 1 };
    if (tag === 0x2c) {
      check(p + 11 <= bytes.length);
      p += 10 + palette(bytes[p + 9]);
      check(p < bytes.length && bytes[p] >= 2 && bytes[p] <= 8); // LZW minimum code size
      p = subBlocks(p + 1);
      blocks.push({ start, end: p, keep: true, image: true });
    } else if (tag === 0x21) {
      check(p + 2 < bytes.length);
      const label = bytes[p + 1];
      p = subBlocks(p + 2);
      const timing = label === 0xf9 && bytes[start + 2] === 4 && p === start + 8;
      const loop = label === 0xff && bytes[start + 2] === 11
        && ["NETSCAPE2.0", "ANIMEXTS1.0"].includes(ascii(bytes, start + 3, 11))
        && [3, 5].includes(bytes[start + 14]) && p === start + 16 + bytes[start + 14];
      blocks.push({ start, end: p, keep: timing || loop, image: false });
    } else check(false);
  }
}

function cleanGif(bytes: Uint8Array) {
  const { blocks, end } = gifBlocks(bytes);
  check(end === bytes.length && blocks.every(block => block.keep));
  const frames = blocks.filter(block => block.image).length;
  check(frames > 0);
  return frames;
}

function gifWithoutMetadata(bytes: Uint8Array) {
  const { header, blocks, end } = gifBlocks(bytes);
  if (end === bytes.length && blocks.every(block => block.keep)) return bytes;
  return concat([bytes.subarray(0, header), ...blocks.filter(b => b.keep).map(b => bytes.subarray(b.start, b.end)), new Uint8Array([0x3b])]);
}

// ---------------------------------------------------------------------------
// ICO

type IcoEntry = { width: number; height: number; bitCount: number; start: number; end: number; png: boolean };

/** Directory entries whose images tile the file exactly after the directory. */
function icoEntries(bytes: Uint8Array) {
  check(bytes.length >= 6 && u16le(bytes, 0) === 0 && u16le(bytes, 2) === 1);
  const count = u16le(bytes, 4);
  check(count > 0 && count <= 64 && bytes.length >= 6 + 16 * count);
  const entries: IcoEntry[] = [];
  for (let index = 0; index < count; index++) {
    const at = 6 + 16 * index;
    const size = u32le(bytes, at + 8), start = u32le(bytes, at + 12);
    check(bytes[at + 3] === 0 && size > 0 && start + size <= bytes.length);
    entries.push({
      width: bytes[at] || 256, height: bytes[at + 1] || 256, bitCount: u16le(bytes, at + 6),
      start, end: start + size, png: PNG_SIGNATURE.every((value, i) => bytes[start + i] === value),
    });
  }
  const ordered = [...entries].sort((a, b) => a.start - b.start);
  let expected = 6 + 16 * count;
  for (const entry of ordered) {
    check(entry.start === expected);
    expected = entry.end;
  }
  check(expected === bytes.length);
  return entries;
}

/** An uncompressed DIB: colour (XOR) rows then the 1-bit transparency (AND) mask. */
function cleanIcoBitmap(bytes: Uint8Array, entry: IcoEntry) {
  const dib = bytes.subarray(entry.start, entry.end);
  check(dib.length >= 40 && u32le(dib, 0) === 40);
  const width = u32le(dib, 4) | 0, doubledHeight = u32le(dib, 8) | 0;
  const bits = u16le(dib, 14);
  check(width === entry.width && doubledHeight === 2 * entry.height && u16le(dib, 12) === 1);
  check([1, 4, 8, 24, 32].includes(bits) && u32le(dib, 16) === 0);
  const colours = bits <= 8 ? u32le(dib, 32) || 2 ** bits : 0;
  check(bits > 8 || colours <= 2 ** bits);
  const row = (bitsPerPixel: number) => Math.ceil((width * bitsPerPixel) / 32) * 4;
  check(dib.length === 40 + 4 * colours + (row(bits) + row(1)) * entry.height);
}

function cleanIco(bytes: Uint8Array) {
  for (const entry of icoEntries(bytes)) {
    if (!entry.png) {
      cleanIcoBitmap(bytes, entry);
      continue;
    }
    const png = bytes.subarray(entry.start, entry.end);
    check(cleanPng(png) === 1);
    check(u32be(png, 16) === entry.width && u32be(png, 20) === entry.height);
  }
  return 1;
}

/** Rebuild the directory around PNG variants without their metadata. */
function icoWithoutMetadata(bytes: Uint8Array) {
  const entries = icoEntries(bytes);
  const images = entries.map(entry => {
    const image = bytes.subarray(entry.start, entry.end);
    return entry.png ? pngWithoutMetadata(image) : image;
  });
  if (images.every((image, index) => image.length === entries[index].end - entries[index].start)) return bytes;
  const directory = bytes.slice(0, 6 + 16 * entries.length);
  const view = new DataView(directory.buffer);
  let offset = directory.length;
  images.forEach((image, index) => {
    view.setUint32(6 + 16 * index + 8, image.length, true);
    view.setUint32(6 + 16 * index + 12, offset, true);
    offset += image.length;
  });
  return concat([directory, ...images]);
}

// ---------------------------------------------------------------------------
// AVIF (ISO base media file format)

type Box = { type: string; start: number; body: number; end: number };

function boxes(bytes: Uint8Array, from: number, to: number) {
  const out: Box[] = [];
  for (let p = from; p < to;) {
    check(p + 8 <= to);
    let size = u32be(bytes, p), body = p + 8;
    if (size === 1) {
      check(p + 16 <= to && u32be(bytes, p + 8) === 0);
      size = u32be(bytes, p + 12);
      body = p + 16;
    } else if (size === 0) size = to - p;
    check(size >= body - p && p + size <= to);
    out.push({ type: ascii(bytes, p + 4), start: p, body, end: p + size });
    p += size;
  }
  return out;
}

/** Item types and properties of a still AV1 image (with optional alpha or grid). */
const AVIF_ITEMS = new Set(["av01", "grid"]);
const AVIF_PROPERTIES = new Set(["ispe", "pixi", "av1C", "colr", "auxC", "irot", "imir", "clap", "pasp"]);
const AVIF_META = new Set(["hdlr", "pitm", "iloc", "iinf", "iprp", "iref", "idat", "dinf"]);

function avifTop(bytes: Uint8Array) {
  const top = boxes(bytes, 0, bytes.length);
  check(top[0]?.type === "ftyp" && top[0].end - top[0].body >= 8);
  const ftyp = top[0];
  const brands = [ascii(bytes, ftyp.body)];
  for (let p = ftyp.body + 8; p + 4 <= ftyp.end; p += 4) brands.push(ascii(bytes, p));
  return { top, brands };
}

function avifAnimated(bytes: Uint8Array) {
  const { top, brands } = avifTop(bytes);
  return brands.includes("avis") || top.some(box => box.type === "moov");
}

function cleanAvif(bytes: Uint8Array) {
  const { top, brands } = avifTop(bytes);
  check(brands.includes("avif") && !avifAnimated(bytes));
  check(top.slice(1).every(box => ["meta", "mdat", "free", "skip"].includes(box.type)));
  const metas = top.filter(box => box.type === "meta");
  check(metas.length === 1);
  const children = boxes(bytes, metas[0].body + 4, metas[0].end);
  check(children.every(box => AVIF_META.has(box.type)));
  const infos = children.filter(box => box.type === "iinf");
  check(infos.length === 1);
  const info = infos[0];
  const itemsAt = info.body + 4 + (bytes[info.body] === 0 ? 2 : 4);
  const items = boxes(bytes, itemsAt, info.end);
  check(items.length > 0);
  for (const item of items) {
    const version = bytes[item.body];
    check(item.type === "infe" && (version === 2 || version === 3));
    check(AVIF_ITEMS.has(ascii(bytes, item.body + 4 + (version === 2 ? 2 : 4) + 2)));
  }
  for (const properties of children.filter(box => box.type === "iprp")) {
    for (const box of boxes(bytes, properties.body, properties.end)) {
      check(box.type === "ipco" || box.type === "ipma");
      if (box.type !== "ipco") continue;
      for (const property of boxes(bytes, box.body, box.end)) {
        check(AVIF_PROPERTIES.has(property.type));
        // Colour as code points only (nclx); an embedded ICC profile is metadata here.
        if (property.type === "colr") check(ascii(bytes, property.body) === "nclx");
      }
    }
  }
  return 1;
}

// ---------------------------------------------------------------------------
// Shared entry points

const cleaners: Record<string, (bytes: Uint8Array) => number> = {
  "image/jpeg": cleanJpeg,
  "image/png": cleanPng,
  "image/webp": cleanWebp,
  "image/gif": cleanGif,
  "image/x-icon": cleanIco,
  "image/avif": cleanAvif,
};

export type PreparedRaster = { type: string; width: number; height: number; frames: number };

/**
 * Accept only clean bytes within Full HD. Browser, CLI and server outputs pass
 * through this before upload or storage, and the server repeats it on bytes it
 * did not produce. Throws `IMAGE_INVALID`.
 */
export function assertPreparedRaster(bytes: Uint8Array): PreparedRaster {
  const { type, width, height } = inspectRaster(bytes, true);
  const clean = cleaners[type];
  check(clean);
  try {
    return { type, width, height, frames: clean(bytes) };
  } catch {
    throw new Error(IMAGE_ERRORS.invalid);
  }
}

/** Remove metadata records without touching compressed pixels or frame timing.
 * Returns the same array when there was nothing to remove. Colour profiles are
 * removed too, so callers compare the decoded result when appearance matters. */
export function withoutMetadata(bytes: Uint8Array<ArrayBuffer>, type: string): Uint8Array<ArrayBuffer> {
  try {
    switch (type) {
      case "image/jpeg": return jpegWithoutMetadata(bytes);
      case "image/png": return pngWithoutMetadata(bytes) as Uint8Array<ArrayBuffer>;
      case "image/webp": return webpWithoutMetadata(bytes) as Uint8Array<ArrayBuffer>;
      case "image/gif": return gifWithoutMetadata(bytes) as Uint8Array<ArrayBuffer>;
      case "image/x-icon": return icoWithoutMetadata(bytes) as Uint8Array<ArrayBuffer>;
      default: return bytes;
    }
  } catch {
    throw new Error(IMAGE_ERRORS.invalid);
  }
}

/** A clean copy without metadata, or nothing when the source's records cannot be
 * rewritten (for example stray bytes between JPEG segments, which decoders skip). */
export function cleanCopy(bytes: Uint8Array<ArrayBuffer>, type: string) {
  try {
    const copy = withoutMetadata(bytes, type);
    return copy !== bytes && cleaners[type]?.(copy) ? copy : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the bytes are already a clean prepared image, and how many frames they show. */
export function rasterTraits(bytes: Uint8Array, type: string) {
  let frames = 1;
  try {
    if (type === "image/gif") frames = gifBlocks(bytes).blocks.filter(block => block.image).length;
    else if (type === "image/png") {
      const control = pngChunks(bytes).chunks.find(chunk => chunk.name === "acTL");
      if (control?.data.length === 8) frames = u32be(control.data, 0);
    } else if (type === "image/webp") {
      const { chunks } = webpChunks(bytes);
      if (chunks[0]?.name === "VP8X" && chunks[0].data[0] & WEBP_FLAGS.animation) frames = chunks.filter(chunk => chunk.name === "ANMF").length;
    } else if (type === "image/avif" && avifAnimated(bytes)) frames = 2;
  } catch {
    throw new Error(IMAGE_ERRORS.invalid);
  }
  let clean = false;
  try {
    clean = Boolean(cleaners[type]?.(bytes));
  } catch {
    /* Metadata or an unsupported record: the bytes need preparing. */
  }
  return { frames, animated: frames > 1, clean };
}
