import assert from "node:assert/strict";
import test from "node:test";
import {
  IMAGE_MARKUP_ERRORS,
  MARKUP_MAX_EDGE,
  canMarkupImage,
  exportMarkupImage,
  imageMarkupErrorCode,
  loadMarkupImage,
  resolveMarkupCrop,
  type MarkupMark,
} from "../src/lib/image-markup";
import { IMAGE_SOURCE_BYTES } from "../shared/image-optimization";
import { apng, concat, icon, pngChunk, solid } from "./fixtures/rasters";

function pngWithDimensions(width: number, height: number) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return concat(
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", new Uint8Array([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])),
    pngChunk("IEND", new Uint8Array()),
  );
}

const unexpectedDecode = () => assert.fail("preflight must reject before browser decode");
const crop = (x: number, y: number, width: number, height: number): MarkupMark =>
  ({ id: 1, kind: "crop", x, y, width, height, stroke: 0 });

test("markup eligibility recognizes PNG and JPEG MIME or a filename without MIME", () => {
  for (const [name, type] of [
    ["shot.png", "image/png"], ["PHOTO.JPG", "IMAGE/JPEG; charset=binary"],
    ["camera.jpeg", ""], ["shot.png", ""],
  ]) {
    assert.equal(canMarkupImage(new File(["test"], name, { type })), true, name);
  }
  for (const type of ["image/gif", "image/webp", "image/avif", "image/heic", "image/svg+xml", "video/mp4"]) {
    assert.equal(canMarkupImage(new File(["test"], "disguised.png", { type })), false, type);
  }
  assert.equal(canMarkupImage(new File(["test"], "notes.txt")), false);
});

test("preflight rejects unsupported, animated, malformed and oversized images before decoding", async () => {
  const oldDecode = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");
  let decodeCalls = 0;
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    value: async () => { decodeCalls++; return unexpectedDecode(); },
  });
  try {
    const { invalid, format, animation, tooLarge, dimensionsTooLarge } = IMAGE_MARKUP_ERRORS;
    const webp = new Uint8Array(await solid(16, 12, "#228855").webp().toBuffer());
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
    const candidates: [File, string][] = [
      [new File([], "empty.png", { type: "image/png" }), invalid],
      [new File(["garbage"], "bad.png", { type: "image/png" }), invalid],
      [new File([await apng({ width: 16, height: 12 })], "animated.png"), animation],
      [new File([webp], "valid.webp", { type: "image/webp" }), format],
      [new File([webp], "spoof.png", { type: "image/png" }), format],
      [new File([await icon()], "spoof.png", { type: "image/png" }), format],
      [new File([svg], "spoof.png", { type: "image/png" }), format],
      [new File([pngWithDimensions(MARKUP_MAX_EDGE + 1, 100)], "edge.png"), dimensionsTooLarge],
      [new File([pngWithDimensions(5000, 5000)], "pixels.png"), dimensionsTooLarge],
      [new File([new Uint8Array(IMAGE_SOURCE_BYTES + 1)], "huge.jpg"), tooLarge],
    ];
    for (const [file, code] of candidates) {
      await assert.rejects(loadMarkupImage(file), { message: code });
    }
    assert.equal(decodeCalls, 0);
  } finally {
    if (oldDecode) Object.defineProperty(globalThis, "createImageBitmap", oldDecode);
    else Reflect.deleteProperty(globalThis, "createImageBitmap");
  }
});

test("preflight closes an unexpectedly oversized decoded image", async () => {
  const oldDecode = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");
  const png = new Uint8Array(await solid(16, 16, "#123456").png().toBuffer());
  let closed = false;
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    value: async () => ({ width: MARKUP_MAX_EDGE + 1, height: 10, close: () => { closed = true; } }),
  });
  try {
    await assert.rejects(loadMarkupImage(new File([png], "shot.png")), {
      message: IMAGE_MARKUP_ERRORS.dimensionsTooLarge,
    });
    assert.equal(closed, true);
  } finally {
    if (oldDecode) Object.defineProperty(globalThis, "createImageBitmap", oldDecode);
    else Reflect.deleteProperty(globalThis, "createImageBitmap");
  }
});

test("crop preserves integer pixels and rounds fractional bounds outward within the source", () => {
  assert.deepEqual(resolveMarkupCrop(100, 80, []), { x: 0, y: 0, width: 100, height: 80 });
  assert.deepEqual(resolveMarkupCrop(100, 80, [crop(10, 20, 30, 40)]),
    { x: 10, y: 20, width: 30, height: 40 });
  assert.deepEqual(resolveMarkupCrop(100, 80, [crop(10, 20, 30, 40), crop(-5.4, 10.7, 20.1, 90)]),
    { x: 0, y: 10, width: 15, height: 70 });
});

test("invalid crop and mark geometry fail before rendering", async () => {
  const invalid = { message: IMAGE_MARKUP_ERRORS.invalid };
  assert.throws(() => resolveMarkupCrop(0, 80, []), invalid);
  for (const mark of [crop(120, 1, 20, 20), crop(1, 1, 0, 20), crop(1, NaN, 20, 20)]) {
    assert.throws(() => resolveMarkupCrop(100, 80, [mark]), invalid);
  }
  const image = { width: 100, height: 80 } as ImageBitmap;
  await assert.rejects(exportMarkupImage(image, [{ ...crop(1, 2, 20, 20), kind: "circle" }], "image/png"), invalid);
  await assert.rejects(exportMarkupImage(image, [{ ...crop(1, 2, -20, 20), kind: "mask" }], "image/png"), invalid);
  assert.equal(imageMarkupErrorCode(new Error(IMAGE_MARKUP_ERRORS.exportFailed)), IMAGE_MARKUP_ERRORS.exportFailed);
  assert.equal(imageMarkupErrorCode(new Error("browser details")), IMAGE_MARKUP_ERRORS.invalid);
});
