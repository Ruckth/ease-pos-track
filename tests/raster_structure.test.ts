// Container checks for prepared images. Fixtures are ordinary images with
// ordinary metadata (comments, text notes, EXIF), plus truncated or padded copies.
import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { assertPreparedRaster, rasterTraits, withoutMetadata } from "../shared/raster-structure";
import { validatePreparedRaster } from "../shared/node/validate-raster";
import { apng, concat, icon, pngChunk, solid, withJpegSegment, withPngChunk } from "./fixtures/rasters";

const rejects = (bytes: Uint8Array) => assert.throws(() => assertPreparedRaster(bytes), /IMAGE_INVALID/);

test("JPEG: our encoder output is clean; comments, application records and trailing bytes are not", async () => {
  const jpeg = new Uint8Array(await solid(32, 24, "#3a7").jpeg().toBuffer());
  assert.deepEqual(assertPreparedRaster(jpeg), { type: "image/jpeg", width: 32, height: 24, frames: 1 });
  const commented = withJpegSegment(jpeg, 0xfe, "Taken at the front counter");
  const vendorNote = withJpegSegment(jpeg, 0xef, "VENDOR settings=standard");
  const padded = concat(jpeg, Buffer.from("extra bytes"));
  for (const bytes of [commented, vendorNote, padded]) {
    rejects(bytes);
    const clean = withoutMetadata(bytes, "image/jpeg");
    assert.deepEqual(clean, jpeg, "the original scan data is kept exactly");
  }
  rejects(new Uint8Array(await solid(32, 24, "#3a7").withMetadata({ orientation: 1 }).jpeg().toBuffer()));
  rejects(jpeg.subarray(0, jpeg.length - 2));
  rejects(jpeg.subarray(0, 40));
  assert.throws(() => withoutMetadata(jpeg.subarray(0, 40), "image/jpeg"), /IMAGE_INVALID/);
});

test("PNG: only drawing records are allowed; text notes and private chunks are removed, not tolerated", async () => {
  const png = new Uint8Array(await solid(20, 10, "#12579a80", 4).png().toBuffer());
  assert.equal(assertPreparedRaster(png).frames, 1);
  const noted = withPngChunk(png, pngChunk("tEXt", Buffer.from("Comment\0Counter 2 screenshot")));
  const privateNote = withPngChunk(png, pngChunk("prVt", Buffer.from("app settings")));
  const padded = concat(png, Buffer.from("extra"));
  for (const bytes of [noted, privateNote, padded]) {
    rejects(bytes);
    assert.deepEqual(withoutMetadata(bytes, "image/png"), png);
  }
  const badChecksum = png.slice();
  badChecksum[30] ^= 1; // inside IHDR's checksum
  rejects(badChecksum);
  // An unknown critical chunk is needed for decoding, so it cannot be dropped.
  assert.throws(() => withoutMetadata(withPngChunk(png, pngChunk("ZZZZ", Buffer.from("x"))), "image/png"), /IMAGE_INVALID/);
  rejects(png.subarray(0, png.length - 6));
});

test("APNG: frames are counted and must be numbered in order, fit the canvas and match the declared count", async () => {
  const animation = await apng();
  assert.equal(assertPreparedRaster(animation).frames, 2);
  assert.equal(rasterTraits(animation, "image/png").animated, true);
  rejects(await apng({ frames: 3 }));
  rejects(await apng({ swapSequence: true }));
  rejects(await apng({ offsetX: 1 }));
  assert.equal(await validatePreparedRaster(animation), "image/png");
});

test("WebP: still and animated encodings are clean; EXIF, colour profiles and broken frames are not", async () => {
  const lossless = new Uint8Array(await solid(20, 10, "#12579a80", 4).webp({ lossless: true }).toBuffer());
  assert.equal(assertPreparedRaster(lossless).frames, 1);
  const withExif = new Uint8Array(await solid(20, 10, "#159").withMetadata({ exif: { IFD0: { Copyright: "Ease POS" } } }).webp().toBuffer());
  rejects(withExif);
  const stripped = withoutMetadata(withExif, "image/webp");
  assert.equal(assertPreparedRaster(stripped).frames, 1);
  assert.equal((await sharp(stripped).metadata()).exif, undefined);

  const frames = await Promise.all(["#f80", "#08f", "#0a4"].map(color => solid(12, 8, color).png().toBuffer()));
  const animated = new Uint8Array(await sharp(frames, { join: { animated: true } }).webp({ delay: [80, 120, 200], loop: 0 }).toBuffer());
  assert.equal(assertPreparedRaster(animated).frames, 3);
  assert.equal(rasterTraits(animated, "image/webp").animated, true);
  // Cut the last frame short while keeping the RIFF size consistent.
  const truncated = animated.slice(0, animated.length - 6);
  new DataView(truncated.buffer).setUint32(4, truncated.length - 8, true);
  rejects(truncated);
  assert.equal(await validatePreparedRaster(animated), "image/webp");
});

test("GIF: a single frame is a still image; comments and trailing bytes are removed; frames and delays are counted", async () => {
  const still = new Uint8Array(await solid(10, 8, "#c33").gif().toBuffer());
  assert.deepEqual(rasterTraits(still, "image/gif"), { frames: 1, animated: false, clean: true });
  const trailerAt = still.length - 1;
  const commented = concat(still.subarray(0, trailerAt), Buffer.from([0x21, 0xfe, 6]), Buffer.from("Shift2"), Buffer.from([0, 0x3b]));
  const padded = concat(still, Buffer.from("extra"));
  for (const bytes of [commented, padded]) {
    rejects(bytes);
    assert.deepEqual(withoutMetadata(bytes, "image/gif"), still);
  }
  const frames = await Promise.all(["#f80", "#08f"].map(color => solid(10, 8, color).png().toBuffer()));
  const animated = new Uint8Array(await sharp(frames, { join: { animated: true } }).gif({ delay: [70, 120], loop: 3 }).toBuffer());
  assert.equal(assertPreparedRaster(animated).frames, 2);
  rejects(animated.subarray(0, animated.length - 4));
  assert.equal(await validatePreparedRaster(animated), "image/gif");
});

test("ICO: each variant is checked; PNG variants lose their metadata and unrelated payloads are refused", async () => {
  const ico = await icon();
  assert.equal(assertPreparedRaster(ico).type, "image/x-icon");
  assert.equal(await validatePreparedRaster(ico), "image/x-icon");

  const png = new Uint8Array(await solid(16, 16, "#2a6", 4).png().toBuffer());
  const noted = await icon(withPngChunk(png, pngChunk("tEXt", Buffer.from("Software\0Icon editor"))));
  rejects(noted);
  const cleaned = withoutMetadata(noted, "image/x-icon");
  assert.deepEqual(cleaned, ico, "the directory is rebuilt around the cleaned variant");

  rejects(concat(ico, Buffer.from("extra")));
  // A directory entry followed by text instead of an image.
  const directory = Buffer.alloc(22);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(1, 4);
  directory[6] = directory[7] = 16;
  directory.writeUInt32LE(40, 14);
  directory.writeUInt32LE(22, 18);
  rejects(concat(directory, Buffer.from("<p>Store hours: 9 to 5</p>".padEnd(40, " "))));
});

test("AVIF: still AV1 output is clean; an EXIF item or embedded colour profile is not", async () => {
  const avif = new Uint8Array(await solid(20, 10, "#12579a80", 4).avif().toBuffer());
  assert.equal(assertPreparedRaster(avif).frames, 1);
  assert.equal(await validatePreparedRaster(avif), "image/avif");
  rejects(new Uint8Array(await solid(20, 10, "#159").withMetadata({ exif: { IFD0: { Copyright: "Ease POS" } } }).avif().toBuffer()));
});

test("prepared images must fit Full HD and be a supported container", async () => {
  rejects(new Uint8Array(await solid(1921, 10, "#000").png().toBuffer()));
  rejects(new Uint8Array(Buffer.from("plain text, not an image")));
  rejects(new Uint8Array());
});
