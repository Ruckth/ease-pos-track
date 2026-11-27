/** Small builders for ordinary raster fixtures: extra metadata records, APNGs and icons. */
import { crc32 } from "node:zlib";
import sharp from "sharp";

export const concat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));
export const solid = (width: number, height: number, background: string, channels: 3 | 4 = 3) =>
  sharp({ create: { width, height, channels, background } });

export function pngChunk(name: string, data: Uint8Array) {
  const body = concat(Buffer.from(name, "latin1"), data);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  Buffer.from(body).copy(chunk, 4);
  chunk.writeUInt32BE(crc32(body), 8 + data.length);
  return new Uint8Array(chunk);
}

/** Insert a chunk right after IHDR (8-byte signature + 25-byte IHDR chunk). */
export const withPngChunk = (png: Uint8Array, chunk: Uint8Array) => concat(png.subarray(0, 33), chunk, png.subarray(33));

/** Insert a segment right after the start-of-image marker. */
export function withJpegSegment(jpeg: Uint8Array, marker: number, payload: string) {
  const data = Buffer.from(payload, "latin1");
  const header = Buffer.from([0xff, marker, (data.length + 2) >> 8, (data.length + 2) & 0xff]);
  return concat(jpeg.subarray(0, 2), header, data, jpeg.subarray(2));
}

/** A two-frame APNG made from two ordinary PNG encodings of the same size. */
export async function apng(options: { width?: number; height?: number; frames?: number; swapSequence?: boolean; offsetX?: number } = {}) {
  const { width = 8, height = 6 } = options;
  const chunksOf = (png: Buffer) => {
    const out: Array<{ name: string; data: Buffer }> = [];
    for (let p = 8; p < png.length;) {
      const length = png.readUInt32BE(p);
      out.push({ name: png.toString("latin1", p + 4, p + 8), data: png.subarray(p + 8, p + 8 + length) });
      p += 12 + length;
    }
    return out;
  };
  const [first, second] = await Promise.all(["#f80", "#08f"].map(color => solid(width, height, color).png().toBuffer()));
  const header = chunksOf(first).find(chunk => chunk.name === "IHDR")!.data;
  const data = (png: Buffer) => Buffer.concat(chunksOf(png).filter(chunk => chunk.name === "IDAT").map(chunk => chunk.data));
  const u32 = (...values: number[]) => Buffer.concat(values.map(value => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; }));
  // Frame control: sequence, size, offset, a 10/100 s delay, no disposal or blending.
  const control = (sequence: number, x = 0) => concat(u32(sequence, width, height, x, 0), Buffer.from([0, 10, 0, 100, 0, 0]));
  const [s1, s2] = options.swapSequence ? [2, 1] : [1, 2];
  return concat(
    first.subarray(0, 8),
    pngChunk("IHDR", header),
    pngChunk("acTL", u32(options.frames ?? 2, 0)),
    pngChunk("fcTL", control(0)),
    pngChunk("IDAT", data(first)),
    pngChunk("fcTL", control(s1, options.offsetX ?? 0)),
    pngChunk("fdAT", concat(u32(s2), data(second))),
    pngChunk("IEND", new Uint8Array()),
  );
}

/** An icon with one PNG and one 32-bit bitmap variant, both 16 × 16. */
export async function icon(png?: Uint8Array) {
  const variant = png ?? new Uint8Array(await solid(16, 16, "#2a6", 4).png().toBuffer());
  const bitmap = Buffer.alloc(40 + 16 * 16 * 4 + 16 * 4);
  bitmap.writeUInt32LE(40, 0);
  bitmap.writeInt32LE(16, 4);
  bitmap.writeInt32LE(32, 8); // colour rows plus the transparency mask
  bitmap.writeUInt16LE(1, 12);
  bitmap.writeUInt16LE(32, 14);
  const directory = Buffer.alloc(6 + 32);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(2, 4);
  let offset = directory.length;
  for (const [index, image] of [variant, bitmap].entries()) {
    const at = 6 + 16 * index;
    directory[at] = directory[at + 1] = 16;
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(image.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += image.length;
  }
  return concat(directory, variant, bitmap);
}
