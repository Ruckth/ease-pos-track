// The app's browser image preparation with Chromium's real canvas encoders and
// worker (tests/browser/encoders.html): photos compress, UI pixels stay exact,
// metadata and colour profiles are removed, and animations keep their frames.
import assert from "node:assert/strict";
import { after, test as nodeTest } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import sharp from "sharp";
import { capture, newContext } from "../../scripts/browser-evidence";
import { photographicPixels } from "../fixtures/photo";
import type { PreparedSummary } from "./encoders";

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
