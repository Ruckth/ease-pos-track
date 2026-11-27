// The app's browser image preparation with Chromium's real canvas encoders and
// worker (tests/browser/encoders.html): photos compress, UI pixels stay exact,
// metadata and colour profiles are removed, and animations keep their frames.
import assert from "node:assert/strict";
import { after, test as nodeTest } from "node:test";
import { crc32 } from "node:zlib";
import { chromium, type Browser, type Page } from "playwright";
import sharp from "sharp";
import { capture, newContext } from "../../scripts/browser-evidence";
import { MEDIA_POLICY } from "../../shared/ticket-contracts";
import { photographicPixels } from "../fixtures/photo";
import type { MarkupInput, MarkupResult, PreparedSummary } from "./encoders";

const baseURL = process.env.BROWSER_BASE_URL!;
let browser: Promise<Browser> | undefined;
after(async () => { if (browser) await (await browser).close(); });
const test = (name: string, run: () => Promise<void>) => nodeTest(name, { timeout: 60_000 }, () => capture("encoders", name, run));

async function page() {
  const context = await newContext(await (browser ??= chromium.launch()));
  const result = await context.newPage();
  await result.goto(`${baseURL}/tests/browser/encoders.html`);
  await result.waitForFunction(() => "prepareForTest" in window);
  return result;
}
type Prepared = Exclude<PreparedSummary, { error: string }>;
async function prepare(target: Page, bytes: Buffer, name: string, type: string) {
  return await target.evaluate(([base64, name, type]) =>
    (window as unknown as { prepareForTest: (...args: string[]) => Promise<PreparedSummary> }).prepareForTest(base64, name, type),
  [bytes.toString("base64"), name, type]);
}
async function prepared(target: Page, bytes: Buffer, name: string, type: string) {
  const result = await prepare(target, bytes, name, type);
  if ("error" in result) assert.fail(`${name}: ${result.error}`);
  return result as Prepared;
}

test("a resized phone photo becomes a much smaller lossy image whose brightness detail is intact", async () => {
  const target = await page();
  const photo = await sharp(Buffer.from(photographicPixels(2000, 1400)), { raw: { width: 2000, height: 1400, channels: 3 } })
    .jpeg({ quality: 95 }).withMetadata({ exif: { IFD0: { Make: "Fixture camera" } } }).toBuffer();
  const result = await prepared(target, photo, "counter.jpg", "image/jpeg");
  assert.ok(["image/webp", "image/jpeg"].includes(result.type), result.type);
  assert.ok(result.size < photo.length / 2, `${result.size} of ${photo.length} bytes`);
  assert.deepEqual([result.width, result.height, result.photo, result.tolerant], [1543, 1080, true, true]);
  // The worker (used for this file size) has the same encoders as the main thread.
  const main = await target.evaluate(([base64, name, type]) =>
    (window as unknown as { mainThreadForTest: (...args: string[]) => Promise<{ type: string; size: number }> }).mainThreadForTest(base64, name, type),
  [photo.toString("base64"), "counter.jpg", "image/jpeg"]);
  assert.deepEqual(main, { type: result.type, size: result.size });
});

test("a screenshot with small text keeps exact edges, and transparency survives", async () => {
  const target = await page();
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="300"><rect width="2400" height="300" fill="#fff"/>'
    + '<text x="8" y="40" font-size="24" fill="#d22">Ticket POS-0007 · Total 1,234.50</text><path d="M0 80h2400" stroke="#1257aa" stroke-width="2"/></svg>');
  const screenshot = await sharp(svg).png().toBuffer();
  const ui = await prepared(target, screenshot, "screen.png", "image/png");
  assert.deepEqual([ui.width, ui.height, ui.photo, ui.strict], [1920, 240, false, true]);
  const translucent = await sharp({ create: { width: 3000, height: 300, channels: 4, background: "#1495ac80" } }).png().toBuffer();
  const alpha = await prepared(target, translucent, "overlay.png", "image/png");
  assert.notEqual(alpha.type, "image/jpeg");
  assert.equal(alpha.strict, true, "alpha matches exactly");
});

test("the stored bytes carry no EXIF or colour profile", async () => {
  const target = await page();
  const source = await sharp({ create: { width: 900, height: 600, channels: 3, background: "#4a8" } })
    .withMetadata({ exif: { IFD0: { Make: "Fixture camera" } } }).jpeg().toBuffer();
  const result = await target.evaluate(([base64, name, type]) =>
    (window as unknown as { preparedBytesForTest: (...args: string[]) => Promise<string> }).preparedBytesForTest(base64, name, type),
  [source.toString("base64"), "shelf.jpg", "image/jpeg"]);
  const meta = await sharp(Buffer.from(result, "base64")).metadata();
  assert.deepEqual([meta.exif, meta.icc, meta.xmp], [undefined, undefined, undefined]);
});

test("a single-frame GIF is prepared as a still; animations keep their frames or report a specific error", async () => {
  const target = await page();
  const still = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#c33" } }).gif().toBuffer();
  assert.equal((await prepared(target, still, "still.gif", "image/gif")).frames, 1);
  const frame = (color: string, width: number) => sharp({ create: { width, height: 40, channels: 3, background: color } }).png().toBuffer();
  const small = await sharp(await Promise.all(["#f80", "#08f", "#0a4"].map(color => frame(color, 60))), { join: { animated: true } }).gif({ delay: [70, 120, 300] }).toBuffer();
  const kept = await prepared(target, small, "recording.gif", "image/gif");
  assert.deepEqual([kept.type, kept.frames], ["image/gif", 3]);
  const wide = await sharp(await Promise.all(["#f80", "#08f"].map(color => frame(color, 2400))), { join: { animated: true } }).gif().toBuffer();
  assert.deepEqual(await prepare(target, wide, "wide.gif", "image/gif"), { error: "IMAGE_ANIMATION_UNSUPPORTED" });
});

async function markup(target: Page, source: Buffer, options: Omit<MarkupInput, "base64">) {
  return await target.evaluate(input =>
    (window as unknown as { markupForTest(input: MarkupInput): Promise<MarkupResult> }).markupForTest(input),
  { ...options, base64: source.toString("base64") });
}

function exported(result: MarkupResult) {
  if ("error" in result) assert.fail(String(result.error));
  assert.equal(result.type, result.prepared.type);
  assert.equal(result.prepared.frames, 1);
  assert.match(result.name, /^ticket-markup-[\w-]+\.(?:png|jpg)$/);
  assert.ok(result.name.endsWith(result.type === "image/jpeg" ? ".jpg" : ".png"));
  return Buffer.from(result.encoded, "base64");
}

async function assertMetadataFree(bytes: Buffer, format: "jpeg" | "png") {
  const meta = await sharp(bytes).metadata();
  assert.equal(meta.format, format);
  assert.deepEqual([meta.exif, meta.icc, meta.xmp, meta.orientation], [undefined, undefined, undefined, undefined]);
}

async function pixel(bytes: Buffer, left: number, top: number) {
  return [...await sharp(bytes).extract({ left, top, width: 1, height: 1 }).ensureAlpha().raw().toBuffer()];
}

test("screenshot markup crops real EXIF orientations 3, 6 and 8 in display coordinates", async () => {
  const target = await page();
  const corner = Buffer.from('<svg width="80" height="48" xmlns="http://www.w3.org/2000/svg"><rect width="80" height="48" fill="#160a70"/>'
    + '<rect width="24" height="24" fill="#ffa0b0"/></svg>');
  for (const fixture of [
    { orientation: 3, dimensions: [80, 48], x: 60, y: 30 },
    { orientation: 6, dimensions: [48, 80], x: 30, y: 4 },
    { orientation: 8, dimensions: [48, 80], x: 4, y: 60 },
  ]) {
    const jpeg = await sharp(corner).jpeg({ quality: 100 }).withMetadata({
      orientation: fixture.orientation, exif: { IFD0: { Make: "Private camera name" } },
    }).toBuffer();
    const result = await markup(target, jpeg, {
      name: "private-name.jpg", type: "image/jpeg",
      marks: [{ id: 1, kind: "crop", x: fixture.x, y: fixture.y, width: 12, height: 12, stroke: 0 }],
    });
    const bytes = exported(result);
    assert.deepEqual([result.sourceWidth, result.sourceHeight], fixture.dimensions);
    assert.deepEqual([result.prepared?.width, result.prepared?.height], [12, 12]);
    await assertMetadataFree(bytes, "jpeg");
    const [red, green, blue, alpha] = await pixel(bytes, 6, 6);
    assert.ok(red > 240 && green > 140 && blue > 150 && blue < 190, `EXIF ${fixture.orientation}: ${[red, green, blue]}`);
    assert.equal(alpha, 255);
  }
});

test("fractional masks isolate source secrets before reduction and cover circles", async () => {
  const target = await page();
  const fixture = (secret: string) => sharp(Buffer.from(
    '<svg width="4200" height="420" xmlns="http://www.w3.org/2000/svg">'
    + '<rect width="4200" height="420" fill="#46a2aa" opacity="0.5"/>'
    + `<rect x="120" y="91" width="332" height="147" fill="${secret}"/></svg>`,
  )).withMetadata().png().toBuffer();
  const options: Omit<MarkupInput, "base64"> = {
    name: "private.png", type: "image/png", marks: [
      { id: 1, kind: "crop", x: 11, y: 11, width: 4178, height: 398, stroke: 0 },
      { id: 2, kind: "mask", x: 120.1, y: 91.1, width: 331.4, height: 146.4, stroke: 0 },
      { id: 3, kind: "circle", x: 200, y: 140, width: 400, height: 60, stroke: 16 },
    ],
  };
  const [redSecret, greenSecret] = await Promise.all([fixture("#ff0000"), fixture("#00ff00")]);
  const first = await markup(target, redSecret, options);
  const second = await markup(target, greenSecret, options);
  const originalOptions = { ...options, marks: options.marks.filter(mark => mark.kind !== "mask") };
  const original = await markup(target, redSecret, originalOptions);
  const bytes = exported(first);
  const decoded = (file: Buffer) => sharp(file).ensureAlpha().raw().toBuffer();
  assert.deepEqual(await decoded(bytes), await decoded(exported(second)));
  assert.deepEqual([first.prepared?.width, first.prepared?.height], [1920, 183]);
  await assertMetadataFree(bytes, "png");
  assert.deepEqual(await pixel(bytes, 52, 38), [24, 35, 48, 255]);
  assert.deepEqual(await pixel(bytes, 87, 73), [24, 35, 48, 255]);
  assert.notDeepEqual(await pixel(exported(original), 87, 73), [24, 35, 48, 255]);
  assert.equal((await pixel(bytes, 5, 5))[3], 128);
  const [red, green, blue, alpha] = await pixel(bytes, 270, 73);
  assert.ok(red > 150 && green < 90 && blue < 80 && alpha === 255, `circle pixel: ${[red, green, blue, alpha]}`);
});

test("markup reports null encodes and uses real fallback bytes and bounded JPEG quality retries", async () => {
  const target = await page();
  const jpeg = await sharp({ create: { width: 40, height: 24, channels: 3, background: "#146688" } }).jpeg().toBuffer();
  const options = { name: "private.jpg", type: "image/jpeg", marks: [] };
  for (const encoder of ["jpeg-null", "jpeg-png"] as const) {
    const fallback = await markup(target, jpeg, { ...options, encoder });
    await assertMetadataFree(exported(fallback), "png");
    assert.deepEqual(fallback.attempts.map(attempt => attempt.type),
      encoder === "jpeg-null" ? ["image/jpeg", "image/png"] : ["image/jpeg"]);
  }
  const unavailable = await markup(target, jpeg, { ...options, encoder: "null" });
  assert.equal(unavailable.error, "IMAGE_MARKUP_EXPORT_FAILED");
  const retried = await markup(target, jpeg, { ...options, encoder: "jpeg-oversized-first" });
  await assertMetadataFree(exported(retried), "jpeg");
  assert.deepEqual(retried.attempts.map(attempt => attempt.quality), [0.92, 0.85]);
  const oversized = await markup(target, jpeg, { ...options, encoder: "jpeg-oversized-all" });
  assert.equal(oversized.error, "IMAGE_TOO_LARGE");
  assert.deepEqual(oversized.attempts.map(attempt => attempt.quality), [0.92, 0.85, 0.78, 0.7]);
});

test("an oversized redacted PNG falls back to a JPEG with opaque masks and white flattening", async () => {
  const target = await page();
  const source = await sharp({ create: { width: 80, height: 60, channels: 4, background: "#0000" } }).png().toBuffer();
  const result = await markup(target, source, {
    name: "private.png", type: "",
    marks: [{ id: 1, kind: "mask", x: 15, y: 15, width: 45, height: 30, stroke: 0 }],
    encoder: "png-oversized",
    pngPaddingChecksum: crc32(Buffer.alloc(MEDIA_POLICY.image.maxBytes), crc32("IDAT")),
  });
  const bytes = exported(result);
  await assertMetadataFree(bytes, "jpeg");
  assert.deepEqual(result.attempts.map(attempt => attempt.type), ["image/png", "image/jpeg"]);
  const masked = await pixel(bytes, 40, 30);
  assert.ok(masked.every((channel, i) => Math.abs(channel - [24, 35, 48, 255][i]) < 5));
  assert.deepEqual(await pixel(bytes, 3, 3), [255, 255, 255, 255]);
});
