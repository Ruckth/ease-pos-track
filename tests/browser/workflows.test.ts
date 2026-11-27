import { expectAccessible } from "./a11y";
import { markupLabels } from "../../src/lib/markup-labels";
import { formatTicketNumber } from "../../shared/ticket-numbers";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import path from "node:path";
import { after, test as nodeTest } from "node:test";
import type { BrowserContext, Locator, Page, Request } from "playwright";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { capture, newContext, redact } from "../../scripts/browser-evidence";
import { authStorageKeys, baseURL, hostedPageErrors, chooseProject, convex, copy, files, localIdentityAdmin, openHeaderMenu, projectSwitcher, suiteBrowser, open as openWith, seed, stats, type Language, LOCAL_CUSTOMER_PASSWORD } from "./harness";

const browsers = suiteBrowser();
after(() => browsers.close());
const open = async (role: "staff" | "customer", language?: Language, configure?: (context: BrowserContext) => Promise<void>) => openWith(await browsers.get(), role, language, configure);
// Every check runs in an evidence scope: failures keep a screenshot, the
// assertion, and (locally) a Playwright trace taken before teardown.
function test(name: string, run: () => Promise<void>): void;
function test(name: string, options: { timeout?: number; skip?: string | boolean }, run: () => Promise<void>): void;
function test(name: string, optionsOrRun: { timeout?: number; skip?: string | boolean } | (() => Promise<void>), maybeRun?: () => Promise<void>) {
  if (typeof optionsOrRun === "function") nodeTest(name, () => capture("workflows", name, optionsOrRun));
  else nodeTest(name, optionsOrRun, () => capture("workflows", name, maybeRun!));
}

const filterTrigger = (page: Page) => page.locator('[data-slot="ticket-filter-trigger"]');
const filterPanel = (page: Page) => page.locator('[data-slot="ticket-filter-panel"]');
async function openFilters(page: Page) {
  await filterTrigger(page).click();
  await filterPanel(page).waitFor();
}

async function closeFilters(page: Page) {
  await page.keyboard.press("Escape");
  await filterPanel(page).waitFor({ state: "hidden" });
}

async function selectMarkupMenu(page: Page, trigger: string, item: string) {
  await page.getByRole("button", { name: trigger, exact: true }).tap();
  const menu = page.getByRole("menu");
  await menu.getByRole("menuitemradio", { name: item, exact: true }).tap();
  await menu.waitFor({ state: "hidden" });
}

async function placeOnSurface(surface: Locator, x: number, y: number, input: "tap" | "click" = "tap") {
  await surface.scrollIntoViewIfNeeded();
  // The target can move during a keyboard resize or after changing tools.
  const settled = await surface.evaluate(async element => {
    const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    let previous = element.getBoundingClientRect();
    let stable = 0;
    for (let frame = 0; frame < 20 && stable < 2; frame++) {
      await nextFrame();
      const current = element.getBoundingClientRect();
      stable = current.width === previous.width && current.height === previous.height
        && current.x === previous.x && current.y === previous.y ? stable + 1 : 0;
      previous = current;
    }
    return stable === 2;
  });
  assert.ok(settled, "The editing surface should settle before placing a mark");
  const box = await surface.boundingBox();
  assert.ok(box);
  const position = { x: box.width * x, y: box.height * y };
  if (input === "tap") await surface.tap({ position });
  else await surface.click({ position });
}

async function attachLongReceipt(page: Page, name: string) {
  const data = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 1080; c.height = 6000;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = "#111"; ctx.font = "32px sans-serif";
    for (let y = 60; y < c.height; y += 100) ctx.fillText(`Receipt line ${y}`, 32, y);
    return c.toDataURL("image/png").split(",")[1];
  });
  await page.locator('[data-slot="ticket-draft-files"]').setInputFiles({ name, mimeType: "image/png", buffer: Buffer.from(data, "base64") });
}

test("mobile screenshot markup pans a long receipt and reviews the mask at its source position", async () => {
  const { context, page, errors, uploads } = await openWith(await browsers.get(), "customer", "en", undefined, {
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
  });
  try {
    const labels = markupLabels("en");
    const name = "long-receipt.png";
    await attachLongReceipt(page, name);
    await page.getByRole("button", { name: copy("en", "editImageNamed", { name }), exact: true }).tap();
    const editor = page.getByRole("dialog", { name: copy("en", "editDraftImage"), exact: true });
    const button = (name: string) => editor.getByRole("button", { name, exact: true });
    const surface = editor.getByRole("application");
    const viewport = surface.locator("../..");
    await selectMarkupMenu(page, labels.view, labels.fitWidth);
    await selectMarkupMenu(page, labels.moreTools, labels.pan);
    await viewport.scrollIntoViewIfNeeded();
    const available = (await viewport.boundingBox())!;
    const before = await viewport.evaluate(el => el.scrollTop);
    const finger = { x: available.x + 100, y: available.y + available.height * 0.7 };
    const cdp = await context.newCDPSession(page);
    try {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [finger] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: finger.x, y: finger.y - 110 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      assert.ok(await viewport.evaluate(el => el.scrollTop) > before + 70);
      const x = available.x + available.width * .5, y = available.y + available.height * .5;
      const pinch = (delta: number) => [{ x: x - delta, y, id: 0 }, { x: x + delta, y, id: 1 }];
      const widthBeforePinch = (await surface.boundingBox())!.width;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pinch(25) });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pinch(45) });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForFunction(({ el, width }) => el.getBoundingClientRect().width > width * 1.3,
        { el: (await surface.elementHandle())!, width: widthBeforePinch });
    } finally { await cdp.detach(); }
    await button(labels.mask).tap();
    await viewport.scrollIntoViewIfNeeded();
    const visible = (await viewport.boundingBox())!, source = (await surface.boundingBox())!;
    assert.ok(source.width > 300 && source.height > visible.height * 3);
    assert.ok(await editor.locator("canvas").evaluate(el => (el as HTMLCanvasElement).height < 1200));
    const x = visible.x + visible.width / 2, y = visible.y + visible.height / 2;
    const sample = { x: (x - source.x) / source.width, y: (y - source.y) / source.height };
    await page.touchscreen.tap(x - 24, y - 16);
    await page.touchscreen.tap(x + 24, y + 16);
    await button(labels.review).tap();
    const preview = editor.locator("img");
    await preview.waitFor();
    await selectMarkupMenu(page, labels.view, labels.fitWidth);
    const measured = (await preview.boundingBox())!;
    assert.ok(measured.width > 300 && measured.height > 1200);
    const pixel = await preview.evaluate(async (el, pos) => {
      const img = el as HTMLImageElement; await img.decode();
      const ctx = document.createElement("canvas").getContext("2d")!;
      ctx.drawImage(img, Math.floor(pos.x * img.naturalWidth), Math.floor(pos.y * img.naturalHeight), 1, 1, 0, 0, 1, 1);
      return Array.from(ctx.getImageData(0, 0, 1, 1).data);
    }, sample);
    assert.deepEqual(pixel, [24, 35, 48, 255]);
    assert.equal(uploads(), 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("screenshot markup wheel resizes a newly placed circle in one undo step while keeping receipt scroll, Pan, modifiers and Eraser intact", async () => {
  const { context, page, errors, uploads } = await open("customer", "en");
  try {
    const labels = markupLabels("en");
    const name = "wheel-receipt.png";
    await attachLongReceipt(page, name);
    await page.getByRole("button", { name: copy("en", "editImageNamed", { name }), exact: true }).click();
    const dialog = page.getByRole("dialog", { name: copy("en", "editDraftImage"), exact: true });
    const control = (label: string) => dialog.getByRole("button", { name: label, exact: true });
    const surface = dialog.getByRole("application", { name: labels.canvasLabel });
    const viewport = surface.locator("../..");
    const slider = dialog.getByRole("slider", { name: labels.circleSize, exact: true });
    const readCircle = () => surface.locator("ellipse").first().evaluate(el => ({
      cx: Number(el.getAttribute("cx")),
      cy: Number(el.getAttribute("cy")),
      width: Math.round(Number(el.getAttribute("rx")) * 2),
      height: Math.round(Number(el.getAttribute("ry")) * 2),
    }));
    const waitForWidth = (value: number, direction: "larger" | "smaller") =>
      page.waitForFunction(({ value, direction }) => {
        const mark = document.querySelector('[role="application"] ellipse');
        const width = Number(mark?.getAttribute("rx")) * 2;
        return mark && (direction === "larger" ? width > value : width < value);
      }, { value, direction });
    const screenPoint = (sourceX: number, sourceY: number) => surface.evaluate((el, pt) => {
      const rect = el.getBoundingClientRect();
      const [, , W, H] = (el.getAttribute("viewBox") ?? "0 0 1 1").split(" ").map(Number);
      return { x: rect.left + (pt.x / W) * rect.width, y: rect.top + (pt.y / H) * rect.height };
    }, { x: sourceX, y: sourceY });

    await control(labels.fitWidth).click();
    await viewport.scrollIntoViewIfNeeded();
    await viewport.evaluate(el => { el.scrollTop = 500; });
    const visible = (await viewport.boundingBox())!;
    assert.ok(await viewport.evaluate(el => el.scrollHeight > el.clientHeight * 3));

    // Place a circle in the default Circle tool: it is immediately selected without an extra click.
    assert.equal(await control(labels.circle).getAttribute("aria-pressed"), "true");
    const placePoint = { x: visible.x + visible.width / 2, y: visible.y + visible.height * 0.6 };
    await page.mouse.click(placePoint.x, placePoint.y);
    assert.equal(await control(labels.select).getAttribute("aria-pressed"), "true");
    await dialog.getByText(labels.hintResizeCircle, { exact: true }).waitFor();
    await slider.waitFor();
    assert.equal(await control(labels.fineTune).getAttribute("aria-expanded"), "false");
    assert.equal(await dialog.getByRole("spinbutton", { name: `${labels.width} (px)`, exact: true }).count(), 0);
    const initial = await readCircle();
    assert.equal(Number(await slider.inputValue()), initial.width);
    assert.equal(await slider.getAttribute("aria-valuetext"), labels.sizeValue(initial.width, initial.height));

    // Wheel UP burst with the mouse stationary where the circle was placed (no extra click or move):
    // grows proportionally around center in one undo unit.
    const scrollBeforeWheel = await viewport.evaluate(el => el.scrollTop);
    await page.mouse.wheel(0, -120);
    await waitForWidth(initial.width, "larger");
    await control(labels.undo).click();
    assert.equal((await readCircle()).width, initial.width);
    // Dispatch a single burst in the browser. A busy CI scheduler can pause between driver commands.
    await surface.evaluate((el, point) => {
      for (let i = 0; i < 4; i++) {
        const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: point.x, clientY: point.y, deltaY: -60 });
        if (el.dispatchEvent(event)) throw new Error("Selected circle did not consume the resize gesture");
      }
    }, placePoint);
    await waitForWidth(initial.width + 20, "larger");
    const grown = await readCircle();
    assert.ok(grown.width > initial.width + 20 && grown.height > initial.height + 10, `wheel up grew circle (${initial.width}x${initial.height} -> ${grown.width}x${grown.height})`);
    assert.ok(Math.abs(grown.cx - initial.cx) <= 1 && Math.abs(grown.cy - initial.cy) <= 1, "wheel up preserved center");
    assert.ok(Math.abs(grown.width / grown.height - initial.width / initial.height) < 0.05, "wheel up preserved aspect ratio");
    assert.equal(await viewport.evaluate(el => el.scrollTop), scrollBeforeWheel, "wheel over selected circle did not scroll receipt");
    assert.equal(Number(await slider.inputValue()), grown.width);
    await dialog.getByRole("status").filter({ hasText: labels.resized(labels.markName("circle", 1), grown.width, grown.height) }).waitFor();

    await control(labels.undo).click();
    const afterUndo = await readCircle();
    assert.deepEqual({ width: afterUndo.width, height: afterUndo.height }, { width: initial.width, height: initial.height });
    await control(labels.redo).click();
    const afterRedo = await readCircle();
    assert.deepEqual({ width: afterRedo.width, height: afterRedo.height }, { width: grown.width, height: grown.height });

    // Wheel DOWN burst shrinks the circle around the same center.
    const grownCenter = await screenPoint(grown.cx, grown.cy);
    await page.mouse.move(grownCenter.x, grownCenter.y);
    await page.mouse.wheel(0, 120);
    await waitForWidth(grown.width - 15, "smaller");
    const shrunk = await readCircle();
    assert.ok(shrunk.width < grown.width - 15 && shrunk.height < grown.height - 5, `wheel down shrank circle (${grown.width}x${grown.height} -> ${shrunk.width}x${shrunk.height})`);
    assert.ok(Math.abs(shrunk.cx - initial.cx) <= 1 && Math.abs(shrunk.cy - initial.cy) <= 1, "wheel down preserved center");
    await dialog.getByRole("status").filter({ hasText: labels.resized(labels.markName("circle", 1), shrunk.width, shrunk.height) }).waitFor();

    // Modified (pinch/Ctrl/Meta/Alt/Shift) and horizontal wheel events pass through without preventDefault or resizing.
    const shrunkCenter = await screenPoint(shrunk.cx, shrunk.cy);
    for (const init of [
      { deltaY: -120, ctrlKey: true },
      { deltaY: -120, metaKey: true },
      { deltaY: -120, altKey: true },
      { deltaY: -120, shiftKey: true },
      { deltaX: 120, deltaY: -20 },
    ]) {
      const notCanceled = await surface.evaluate((el, opts) =>
        el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ...opts })), { ...init, clientX: shrunkCenter.x, clientY: shrunkCenter.y });
      assert.equal(notCanceled, true, `modified/horizontal wheel not prevented: ${JSON.stringify(init)}`);
    }
    await page.mouse.move(shrunkCenter.x, shrunkCenter.y);
    await page.mouse.wheel(120, -20);
    assert.equal((await readCircle()).width, shrunk.width);
    await page.waitForTimeout(300);

    // Wheel outside the circle scrolls the receipt; continuing that burst over the circle still scrolls instead of resizing.
    await viewport.scrollIntoViewIfNeeded();
    const visibleForOutside = (await viewport.boundingBox())!;
    const outside = { x: visibleForOutside.x + 16, y: visibleForOutside.y + 16 };
    const scrollBeforeOutside = await viewport.evaluate(el => el.scrollTop);
    await page.mouse.move(outside.x, outside.y);
    await page.mouse.wheel(0, 120);
    await page.waitForFunction(({ el, prev }) => el.scrollTop > prev + 40, { el: (await viewport.elementHandle())!, prev: scrollBeforeOutside });
    await page.waitForTimeout(300);
    const circleAfterOutsideScroll = await screenPoint(shrunk.cx, shrunk.cy);
    const uncanceled = await surface.evaluate((el, { outside, center }) => {
      // Dispatch the two events in one burst even on a loaded CI machine.
      const send = (point: { x: number; y: number }, deltaY: number) =>
        el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: point.x, clientY: point.y, deltaY }));
      return [send(outside, 120), send(center, -100)];
    }, { outside, center: circleAfterOutsideScroll });
    assert.deepEqual(uncanceled, [true, true]);
    assert.equal((await readCircle()).width, shrunk.width, "momentum crossing circle from outside burst did not resize");
    await page.waitForTimeout(300);

    // One-click Pan mode leaves wheel scrolling over the circle intact.
    await control(labels.pan).click();
    assert.equal(await control(labels.pan).getAttribute("aria-pressed"), "true");
    await viewport.scrollIntoViewIfNeeded();
    const panCircleCenter = await screenPoint(shrunk.cx, shrunk.cy);
    const scrollBeforePan = await viewport.evaluate(el => el.scrollTop);
    await page.mouse.move(panCircleCenter.x, panCircleCenter.y);
    await page.mouse.wheel(0, 120);
    await page.waitForFunction(({ el, prev }) => el.scrollTop > prev + 40, { el: (await viewport.elementHandle())!, prev: scrollBeforePan });
    assert.equal((await readCircle()).width, shrunk.width, "wheel over circle in Pan mode did not resize");
    await page.waitForTimeout(300);

    // Switch back to Select and exercise the Circle size slider (wheel over slider, drag undo grouping, buttons, keyboard).
    await control(labels.select).click();
    assert.equal(await control(labels.select).getAttribute("aria-pressed"), "true");
    await slider.scrollIntoViewIfNeeded();
    const sliderBox = (await slider.boundingBox())!;
    await page.mouse.move(sliderBox.x + sliderBox.width / 2, sliderBox.y + sliderBox.height / 2);
    await page.mouse.wheel(0, -100);
    await waitForWidth(shrunk.width, "larger");
    const afterSliderWheel = await readCircle();
    assert.ok(afterSliderWheel.width > shrunk.width, "wheel over Circle size control grew circle");
    await dialog.getByRole("status").filter({ hasText: labels.resized(labels.markName("circle", 1), afterSliderWheel.width, afterSliderWheel.height) }).waitFor();

    await control(labels.larger).click();
    const afterLarger = await readCircle();
    assert.ok(afterLarger.width > afterSliderWheel.width);
    await control(labels.smaller).click();
    const afterSmaller = await readCircle();
    assert.ok(afterSmaller.width < afterLarger.width);

    // Slider drag across multiple values groups into one undo unit.
    const preDragWidth = afterSmaller.width;
    const minVal = Number(await slider.getAttribute("min"));
    const maxVal = Number(await slider.getAttribute("max"));
    const frac = (preDragWidth - minVal) / Math.max(1, maxVal - minVal);
    const dragStart = frac < 0.5 ? 0.6 : 0.4;
    const dragMid = frac < 0.5 ? 0.72 : 0.28;
    const dragEnd = frac < 0.5 ? 0.85 : 0.15;
    const dragBox = (await slider.boundingBox())!;
    await page.mouse.move(dragBox.x + dragBox.width * dragStart, dragBox.y + dragBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(dragBox.x + dragBox.width * dragMid, dragBox.y + dragBox.height / 2, { steps: 3 });
    await page.mouse.move(dragBox.x + dragBox.width * dragEnd, dragBox.y + dragBox.height / 2, { steps: 3 });
    await page.mouse.up();
    const afterDrag = await readCircle();
    assert.notEqual(afterDrag.width, preDragWidth);
    await control(labels.undo).click();
    assert.equal((await readCircle()).width, preDragWidth, "one Undo reversed multi-step slider drag");

    await slider.focus();
    await slider.press("PageUp");
    const afterPageUp = await readCircle();
    assert.ok(afterPageUp.width > preDragWidth);

    // Fine-tune disclosure exposes exact dimensions and independent width editing.
    const fineTune = control(labels.fineTune);
    await fineTune.click();
    assert.equal(await fineTune.getAttribute("aria-expanded"), "true");
    const widthInput = dialog.getByRole("spinbutton", { name: `${labels.width} (px)`, exact: true });
    const heightInput = dialog.getByRole("spinbutton", { name: `${labels.height} (px)`, exact: true });
    assert.equal(Number(await widthInput.inputValue()), afterPageUp.width);
    assert.equal(Number(await heightInput.inputValue()), afterPageUp.height);
    await widthInput.fill(String(afterPageUp.width + 12));
    await widthInput.press("Enter");
    assert.equal(Number(await widthInput.inputValue()), afterPageUp.width + 12);
    assert.equal(Number(await heightInput.inputValue()), afterPageUp.height);
    await dialog.getByRole("group", { name: labels.outline, exact: true }).waitFor();

    // Mask hides Circle size slider; Eraser ignores wheel resize, erases circle, and Undo restores it.
    await control(labels.mask).click();
    await viewport.evaluate((el, top) => { el.scrollTop = top; }, scrollBeforeWheel);
    await viewport.scrollIntoViewIfNeeded();
    const refreshedVisible = (await viewport.boundingBox())!;
    await page.mouse.click(refreshedVisible.x + 40, refreshedVisible.y + 40);
    await page.mouse.click(refreshedVisible.x + 140, refreshedVisible.y + 90);
    assert.equal(await slider.count(), 0, "Circle size slider is hidden when a mask is selected");

    await control(labels.eraser).click();
    assert.equal(await control(labels.eraser).getAttribute("aria-pressed"), "true");
    await viewport.evaluate((el, top) => { el.scrollTop = top; }, scrollBeforeWheel);
    await viewport.scrollIntoViewIfNeeded();
    const beforeErase = await readCircle();
    const scrollBeforeEraseWheel = await viewport.evaluate(el => el.scrollTop);
    const eraseWheelPoint = await screenPoint(beforeErase.cx, beforeErase.cy);
    await page.mouse.move(eraseWheelPoint.x, eraseWheelPoint.y);
    await page.mouse.wheel(0, -100);
    await page.waitForFunction(({ el, prev }) => el.scrollTop < prev - 40, { el: (await viewport.elementHandle())!, prev: scrollBeforeEraseWheel });
    assert.equal((await readCircle()).width, beforeErase.width, "wheel in Eraser mode did not resize circle");
    await page.waitForTimeout(300);
    const eraseClickPoint = await screenPoint(beforeErase.cx, beforeErase.cy);
    await page.mouse.click(eraseClickPoint.x, eraseClickPoint.y);
    assert.equal(await surface.locator("ellipse").count(), 0, "Eraser removed the circle");
    await control(labels.undo).click();
    assert.equal(await surface.locator("ellipse").count(), 2, "Undo restored the erased circle");

    // Immediate Review after a wheel burst flushes and exports the resized circle without waiting for quiet.
    await viewport.scrollIntoViewIfNeeded();
    const restored = await readCircle();
    const circleStroke = await surface.locator("ellipse").nth(1).evaluate(el => Number(el.getAttribute("stroke-width")));
    const restoredCenter = await screenPoint(restored.cx, restored.cy);
    await page.mouse.move(restoredCenter.x, restoredCenter.y);
    for (let i = 0; i < 2; i++) await page.mouse.wheel(0, -100);
    await waitForWidth(restored.width + 40, "larger");
    const flushed = await readCircle();
    assert.ok(flushed.width > restored.width + 40);
    await control(labels.review).click();
    const preview = dialog.getByRole("img", { name: labels.reviewTitle });
    await preview.waitFor();
    const redExtent = await preview.evaluate(async element => {
      const img = element as HTMLImageElement;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      let count = 0, minX = c.width, maxX = -1;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 140 && data[i + 1] < 100 && data[i + 2] < 100) {
          count++;
          const x = (i / 4) % c.width;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
      return { count, spanX: maxX >= minX ? maxX - minX + 1 : 0, naturalWidth: c.width };
    });
    const scaleX = redExtent.naturalWidth / 1080;
    const expectedWidth = flushed.width * scaleX;
    const tolerance = Math.max(6, circleStroke * scaleX + 6);
    assert.ok(redExtent.count > 50, `reviewed image contains exported circle pixels (${redExtent.count})`);
    assert.ok(
      Math.abs(redExtent.spanX - expectedWidth) <= tolerance,
      `exported red span ${redExtent.spanX} px matches resized circle ${expectedWidth.toFixed(1)} px (±${tolerance.toFixed(1)} px)`,
    );
    assert.ok(
      redExtent.spanX > restored.width * scaleX + 6,
      `exported red span ${redExtent.spanX} px exceeds pre-burst width ${(restored.width * scaleX).toFixed(1)} px`,
    );
    assert.equal(uploads(), 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("narrow touch screenshot markup keeps primary tools, Circle size slider and Fine-tune within 320 px", async () => {
  const { context, page, errors, uploads } = await openWith(await browsers.get(), "customer", "en", undefined, {
    viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true,
  });
  try {
    const labels = markupLabels("en");
    await files(page);
    await page.getByRole("button", { name: copy("en", "editImageNamed", { name: "draft.png" }), exact: true }).tap();
    const dialog = page.getByRole("dialog", { name: copy("en", "editDraftImage"), exact: true });
    const control = (label: string) => dialog.getByRole("button", { name: label, exact: true });
    const surface = dialog.getByRole("application", { name: labels.canvasLabel });
    const assertNoOverflow = async (stage: string) => {
      const overflow = await dialog.evaluate(el => ({
        doc: document.documentElement.scrollWidth - window.innerWidth,
        dialog: el.scrollWidth - el.clientWidth,
      }));
      assert.ok(overflow.doc <= 0, `${stage}: document overflow ${overflow.doc}`);
      assert.ok(overflow.dialog <= 0, `${stage}: dialog overflow ${overflow.dialog}`);
    };

    await surface.waitFor();
    await assertNoOverflow("initial 320px editor");
    for (const label of [labels.circle, labels.mask, labels.moreTools, labels.undo, labels.redo]) {
      const box = await control(label).boundingBox();
      assert.ok(box && box.height >= 44, `${label} has a 44 px touch target height`);
    }
    const circleBoxBefore = (await control(labels.circle).boundingBox())!;
    await selectMarkupMenu(page, labels.moreTools, labels.pan);
    const circleBoxAfterPan = (await control(labels.circle).boundingBox())!;
    assert.ok(Math.abs(circleBoxAfterPan.x - circleBoxBefore.x) <= 1 && Math.abs(circleBoxAfterPan.y - circleBoxBefore.y) <= 1, "mode switch kept toolbar buttons stationary");
    await control(labels.circle).tap();
    assert.equal(await control(labels.circle).getAttribute("aria-pressed"), "true");

    const surfaceBox = (await surface.boundingBox())!;
    await surface.tap({ position: { x: surfaceBox.width * 0.5, y: surfaceBox.height * 0.5 } });
    const slider = dialog.getByRole("slider", { name: labels.circleSize, exact: true });
    await slider.waitFor();
    assert.equal(await control(labels.fineTune).getAttribute("aria-expanded"), "false");
    await assertNoOverflow("selected circle at 320px");
    await dialog.getByText(labels.hintTouchSize, { exact: true }).waitFor();

    for (const label of [labels.smaller, labels.larger]) {
      const box = await control(label).boundingBox();
      assert.ok(box && box.width >= 44 && box.height >= 44, `${label} has a 44 px touch target`);
    }
    const beforeSize = Number(await slider.inputValue());
    await control(labels.larger).tap();
    const largerSize = Number(await slider.inputValue());
    assert.ok(largerSize > beforeSize);
    await control(labels.smaller).tap();
    assert.ok(Number(await slider.inputValue()) < largerSize);

    await control(labels.fineTune).tap();
    assert.equal(await control(labels.fineTune).getAttribute("aria-expanded"), "true");
    await dialog.getByRole("spinbutton", { name: `${labels.width} (px)`, exact: true }).waitFor();
    await dialog.getByRole("group", { name: labels.outline, exact: true }).waitFor();
    await assertNoOverflow("expanded fine-tune");

    // Model a software keyboard shrinking the visual viewport independently of CSS layout.
    await page.evaluate(() => {
      const viewport = window.visualViewport!;
      Object.defineProperty(viewport, "height", { configurable: true, value: 320 });
      viewport.dispatchEvent(new Event("resize"));
    });
    const widthField = dialog.getByRole("spinbutton", { name: `${labels.width} (px)`, exact: true });
    await widthField.scrollIntoViewIfNeeded();
    const previousWidth = Number(await widthField.inputValue());
    await widthField.fill(String(previousWidth + 5));
    await widthField.press("Enter");
    assert.equal(Number(await widthField.inputValue()), previousWidth + 5);
    const reviewAction = (await control(labels.review).boundingBox())!;
    assert.ok(reviewAction.y + reviewAction.height <= 320);
    await page.evaluate(() => {
      const viewport = window.visualViewport!;
      Reflect.deleteProperty(viewport, "height");
      viewport.dispatchEvent(new Event("resize"));
    });
    await control(labels.fineTune).tap();
    await selectMarkupMenu(page, labels.moreTools, labels.eraser);
    const boxNow = (await surface.boundingBox())!;
    await surface.tap({ position: { x: boxNow.width * 0.5, y: boxNow.height * 0.5 } });
    assert.equal(await surface.locator("ellipse").count(), 0);
    await control(labels.undo).tap();
    assert.equal(await surface.locator("ellipse").count(), 2);
    assert.equal(uploads(), 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

for (const [language, viewport] of [
  ["en", { width: 320, height: 568 }],
  ["th", { width: 390, height: 664 }],
] as const) {
  test(`mobile photo workspace keeps marking, review, and two notes reachable (${language})`, async () => {
    const { context, page, errors, uploads } = await openWith(await browsers.get(), "customer", language, undefined, {
      viewport, hasTouch: true, isMobile: true,
    });
    const t = (key: Parameters<typeof copy>[1], values?: Parameters<typeof copy>[2]) => copy(language, key, values);
    const labels = markupLabels(language);
    const control = (name: string) => page.getByRole("button", { name, exact: true }).last();
    async function tapHere(name: string) {
      const button = control(name);
      await button.waitFor();
      await page.waitForFunction(label => {
        const button = [...document.querySelectorAll("button")].reverse().find(el =>
          el.getClientRects().length && (el.getAttribute("aria-label") ?? el.textContent?.trim()) === label);
        if (!button) return false;
        const box = button.getBoundingClientRect();
        return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight &&
          button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      }, name);
      await button.tap();
    }
    const place = (selector: string, x: number, y: number) => placeOnSurface(page.locator(selector).last(), x, y);
    try {
      await files(page, "checkout.png");
      await control(t("editImageNamed", { name: "checkout.png" })).tap();
      await place('[role="application"]', .3, .35);
      await tapHere(labels.mask);
      await place('[role="application"]', .56, .5);
      await place('[role="application"]', .86, .68);
      await tapHere(t("closeDialog"));
      const imageDiscard = page.getByRole("alertdialog", { name: t("discardImageTitle") });
      await imageDiscard.getByRole("button", { name: t("cancel"), exact: true }).tap();
      await imageDiscard.waitFor({ state: "hidden" });
      await tapHere(labels.review);
      await page.getByRole("heading", { name: labels.reviewTitle }).waitFor();
      await tapHere(labels.apply);
      const photo = page.getByRole("dialog", { name: t("attachmentPhoto", { number: 1 }), exact: true });
      await photo.waitFor();
      await tapHere(t("addPin"));
      await place("img[data-pin-surface]", .4, .38);
      const draftNote = photo.getByRole("textbox", { name: t("describeIssue") });
      await draftNote.fill("Payment error");
      await tapHere(t("repositionPin"));
      await place("img[data-pin-surface]", .45, .4);
      assert.equal(await draftNote.inputValue(), "Payment error");
      await tapHere(t("closeDialog"));
      const noteDiscard = page.getByRole("alertdialog", { name: t("discardNoteTitle") });
      await noteDiscard.getByRole("button", { name: t("cancel"), exact: true }).tap();
      await noteDiscard.waitFor({ state: "hidden" });
      assert.equal(await draftNote.inputValue(), "Payment error");

      // Exercise the layout with the space a software keyboard would leave.
      await page.setViewportSize({ width: viewport.width, height: 320 });
      await tapHere(t("savePin"));
      await page.setViewportSize(viewport);
      await place("img[data-pin-surface]", .45, .4);
      await draftNote.fill("Same spot on the edited photo");
      await tapHere(t("savePin"));
      await tapHere(t("placementDone"));
      await tapHere(t("noteListCount", { count: 2 }));
      await tapHere(t("noteLabel", { number: 1 }));
      await photo.getByText("Payment error", { exact: true }).waitFor();
      await tapHere(t("noteLabel", { number: 2 }));
      await photo.getByText("Same spot on the edited photo", { exact: true }).waitFor();

      const notes = await photo.locator("button[data-pin-id]").count();
      assert.equal(notes, 2);
      assert.equal(await photo.evaluate(el => el.scrollTop), 0);
      assert.equal(uploads(), 0);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test("mobile video fits the placement surface and time controls in the photo workspace", async () => {
  const { context, page, errors } = await openWith(await browsers.get(), "customer", "en", undefined, {
    viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true,
  });
  const t = (key: Parameters<typeof copy>[1], values?: Parameters<typeof copy>[2]) => copy("en", key, values);
  try {
    const name = "pin-video.webm";
    await page.locator('[data-slot="ticket-draft-files"]').setInputFiles(`tests/browser/${name}`);
    await page.getByRole("button", { name: t("openMedia", { name }), exact: true }).tap();
    const viewer = page.getByRole("dialog", { name, exact: true });
    await viewer.getByRole("button", { name: t("addPin"), exact: true }).tap();
    const slider = viewer.getByRole("slider");
    await slider.waitFor();
    const surface = viewer.getByRole("button", { name: t("markPoint"), exact: true });
    const viewport = viewer.locator('[aria-roledescription="carousel"]');
    async function assertFits() {
      const rangeBox = (await slider.boundingBox())!;
      const hitBox = (await surface.boundingBox())!;
      const bounds = (await viewport.boundingBox())!;
      assert.ok(rangeBox.y >= bounds.y && hitBox.y + hitBox.height <= bounds.y + bounds.height);
      await surface.tap({ position: { x: hitBox.width * .7, y: hitBox.height * .9 } });
    }
    await assertFits();
    await viewer.getByRole("textbox", { name: t("describeIssue") }).fill("Check this frame");
    await viewer.getByRole("button", { name: t("savePin"), exact: true }).tap();
    await assertFits();
    await viewer.getByRole("textbox", { name: t("describeIssue") }).fill("Second frame note");
    await viewer.getByRole("button", { name: t("savePin"), exact: true }).tap();
    await viewer.getByRole("button", { name: t("placementDone"), exact: true }).tap();
    await viewer.getByRole("button", { name: t("noteListCount", { count: 2 }), exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("mobile receipt note stays readable and editable outside the image", async () => {
  const { context, page, errors } = await openWith(await browsers.get(), "customer", "en", undefined, {
    viewport: { width: 390, height: 664 }, hasTouch: true, isMobile: true,
  });
  try {
    const text = "The receipt shows the error near the top. The amount was not charged and the order stayed open.";
    await attachLongReceipt(page, "receipt.png");
    await files(page, "other-attachment.png");
    await page.getByRole("button", { name: copy("en", "openMedia", { name: "receipt.png" }), exact: true }).tap();
    const photo = page.getByRole("dialog", { name: "receipt.png" });
    await photo.getByRole("button", { name: copy("en", "addPin"), exact: true }).tap();
    const image = photo.locator("img[data-pin-surface]");
    const box = (await image.boundingBox())!;
    await image.tap({ position: { x: box.width / 2, y: box.height * .57 } });
    await photo.getByRole("textbox", { name: copy("en", "describeIssue") }).fill(text);
    await photo.getByRole("button", { name: copy("en", "savePin"), exact: true }).tap();
    await photo.getByRole("button", { name: copy("en", "placementDone"), exact: true }).tap();
    await photo.getByRole("button", { name: copy("en", "noteListCount", { count: 1 }), exact: true }).tap();
    await photo.getByRole("button", { name: copy("en", "noteLabel", { number: 1 }), exact: true }).tap();
    const displayed = photo.getByText(text, { exact: true });
    assert.ok((await displayed.boundingBox())!.width > box.width * 3);
    const editLabel = copy("en", "editComment", { label: 1 });
    await photo.getByRole("button", { name: editLabel, exact: true }).tap();
    await photo.getByRole("textbox", { name: editLabel }).fill("Corrected receipt note");
    await photo.locator("button[data-pin-id]").press("ArrowRight");
    assert.equal(await photo.getByRole("textbox", { name: editLabel }).inputValue(), "Corrected receipt note");
    assert.equal(await photo.locator('img[alt="receipt.png"]').count(), 1);
    await photo.getByRole("button", { name: copy("en", "save"), exact: true }).tap();
    await photo.getByText("Corrected receipt note", { exact: true }).waitFor();
    const deleteLabel = copy("en", "deleteComment", { label: 1 });
    const deleteNote = photo.getByRole("button", { name: deleteLabel, exact: true });
    const confirmation = page.getByRole("alertdialog", { name: deleteLabel });
    await deleteNote.tap();
    await confirmation.waitFor();
    await page.keyboard.press("Escape");
    await confirmation.waitFor({ state: "hidden" });
    assert.ok(await photo.getByText("Corrected receipt note", { exact: true }).isVisible());
    await deleteNote.tap();
    await confirmation.getByRole("button", { name: deleteLabel, exact: true }).tap();
    await photo.getByText("Corrected receipt note", { exact: true }).waitFor({ state: "hidden" });
    const add = photo.getByRole("button", { name: copy("en", "addPin"), exact: true });
    await page.waitForFunction(button => document.activeElement === button, await add.elementHandle());
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

for (const [role, language] of [["customer", "en"], ["staff", "th"]] as const) {
  test(`${role} ${language}: screenshot markup reviews and applies the exact edited attachment`, async () => {
    const device = role === "customer" ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : {};
    const { context, page, errors, uploads } = await openWith(await browsers.get(), role, language, undefined, device);
    try {
      const labels = markupLabels(language);
      await files(page, "private-receipt.png");
      const original = page.getByRole("button", { name: copy(language, "openMedia", { name: "private-receipt.png" }), exact: true });
      await original.click();
      const viewer = page.getByRole("dialog", { name: "private-receipt.png", exact: true });
      await viewer.getByRole("button", { name: copy(language, "addPin"), exact: true }).click();
      await viewer.locator("img").first().click();
      await viewer.getByPlaceholder(copy(language, "describeIssue")).fill("Check this amount");
      await viewer.getByRole("button", { name: copy(language, "savePin"), exact: true }).click();
      if (role === "customer") {
        await viewer.getByRole("button", { name: copy(language, "placementDone"), exact: true }).tap();
        await viewer.getByRole("button", { name: copy(language, "editDraftImage"), exact: true }).click();
      } else {
        await viewer.getByRole("button", { name: copy(language, "closeDialog"), exact: true }).click();
        await page.getByRole("button", { name: copy(language, "editImageNamed", { name: "private-receipt.png" }), exact: true }).click();
      }
      const dialog = page.getByRole("dialog", { name: copy(language, "editDraftImage"), exact: true });
      const control = (name: string) => dialog.getByRole("button", { name, exact: true });
      const surface = dialog.getByRole("application", { name: labels.canvasLabel });
      const place = (x: number, y: number) => placeOnSurface(surface, x, y, role === "customer" ? "tap" : "click");
      await control(labels.circle).click();
      await place(0.72, 0.66);
      if (role === "staff") assert.equal(await control(labels.select).getAttribute("aria-pressed"), "true");
      await dialog.getByRole("slider", { name: labels.circleSize, exact: true }).waitFor();
      const fineTune = control(labels.fineTune);
      assert.equal(await fineTune.getAttribute("aria-expanded"), "false");
      const width = dialog.getByRole("spinbutton", { name: `${labels.width} (px)`, exact: true });
      const height = dialog.getByRole("spinbutton", { name: `${labels.height} (px)`, exact: true });
      assert.equal(await width.count(), 0);
      assert.equal(await dialog.getByRole("group", { name: labels.outline, exact: true }).count(), 0);
      await fineTune.click();
      assert.equal(await fineTune.getAttribute("aria-expanded"), "true");
      await dialog.getByRole("group", { name: labels.outline, exact: true }).waitFor();
      const originalWidth = Number(await width.inputValue()), originalHeight = Number(await height.inputValue());
      await control(labels.fineSteps).click();
      await control(`${labels.width}: ${labels.wider}`).click();
      assert.equal(Number(await width.inputValue()), originalWidth + 1);
      assert.equal(Number(await height.inputValue()), originalHeight);
      await height.fill(String(originalHeight + 7));
      await height.press("Enter");
      assert.equal(Number(await height.inputValue()), originalHeight + 7);
      await control(`${labels.height}: ${labels.taller}`).click();
      assert.equal(Number(await height.inputValue()), originalHeight + 8);
      await control(labels.circle).click();
      await place(0.25, 0.68);
      await control(labels.mask).click();
      await place(0.3, 0.25);
      await place(0.52, 0.42);
      if (role === "customer") await selectMarkupMenu(page, labels.moreTools, labels.eraser);
      else await control(labels.eraser).click();
      await place(0.25, 0.68);
      await control(labels.undo).click();
      await control(labels.redo).click();
      if (role === "customer") await selectMarkupMenu(page, labels.moreTools, labels.crop);
      else await control(labels.crop).click();
      await place(0.02, 0.02);
      await place(0.20, 0.20);
      assert.ok(await control(labels.review).isDisabled());
      await control(labels.expandCrop).click();
      assert.equal(await control(labels.review).isDisabled(), false);
      if (role === "customer") await selectMarkupMenu(page, labels.moreTools, labels.crop);
      else await control(labels.crop).click();
      await place(0.12, 0.12);
      await place(0.94, 0.94);
      await control(labels.review).click();
      const reviewed = await dialog.locator("img").evaluate(async element => {
        const img = element as HTMLImageElement;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        const pixels = ctx.getImageData(0, 0, c.width, c.height).data;
        let redLeft = 0, redRight = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i] > 140 && pixels[i + 1] < 100 && pixels[i + 2] < 100) {
            if ((i / 4) % c.width < c.width / 2) redLeft++;
            else redRight++;
          }
        }
        const mask = Array.from(ctx.getImageData(Math.round(c.width * 0.36), Math.round(c.height * 0.25), 1, 1).data);
        return { width: c.width, height: c.height, redLeft, redRight, mask,
          bytes: Array.from(new Uint8Array(await (await fetch(img.src)).arrayBuffer())) };
      });
      assert.ok(reviewed.width < 320 && reviewed.height < 240);
      assert.equal(reviewed.redLeft, 0);
      assert.ok(reviewed.redRight > 10);
      assert.deepEqual(reviewed.mask, [24, 35, 48, 255]);
      await control(labels.apply).click();
      await dialog.waitFor({ state: "hidden" });
      if (role === "customer") {
        const updatedViewer = page.getByRole("dialog", { name: copy(language, "attachmentPhoto", { number: 1 }), exact: true });
        await updatedViewer.getByRole("button", { name: copy(language, "editDraftImage"), exact: true }).waitFor();
        await updatedViewer.getByRole("button", { name: copy(language, "closeDialog"), exact: true }).click();
      }
      const attachment = page.locator('[data-slot="sortable-item"] img').first();
      const applied = await attachment.evaluate(async img => Array.from(
        new Uint8Array(await (await fetch((img as HTMLImageElement).src)).arrayBuffer())));
      assert.deepEqual(applied, reviewed.bytes);
      assert.doesNotMatch(await attachment.getAttribute("alt") ?? "", /private-receipt/);
      assert.equal(await page.getByText(copy(language, "pinSummary", { count: 1 }), { exact: true }).isVisible(), true);
      assert.equal(uploads(), 0);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

for (const role of ["staff", "customer"] as const) for (const language of ["en", "th"] as const) {
  test(`${role} ${language}: focus, pointer pin removal, camera teardown and unmount`, async () => {
    const { context, page, title, errors, refreshToken, uploads } = await open(role, language);
    try {
      await title.fill("Browser draft");
      await files(page);
      const preview = page.getByRole("button", { name: copy(language, "openMedia", { name: "draft.png" }), exact: true });
      await preview.click();
      await page.getByRole("button", { name: copy(language, "addPin"), exact: true }).click();
      const image = page.getByRole("dialog").last().locator('img').first();
      await image.click({ position: { x: 30, y: 30 } });
      const note = page.getByPlaceholder(copy(language, "describeIssue"));
      await note.waitFor({ state: "visible" });
      assert.equal(await note.evaluate(element => element === document.activeElement), true);
      await note.fill("Pointer note");
      await page.getByRole("button", { name: copy(language, "savePin"), exact: true }).last().click();
      await page.getByRole("button", { name: copy(language, "closeDialog"), exact: true }).last().click();
      await page.waitForFunction(label => document.activeElement?.getAttribute("aria-label") === label, copy(language, "openMedia", { name: "draft.png" }));
      assert.equal(await preview.evaluate(element => element === document.activeElement), true);
      // Closing/reopening the real composer remounts DOM consumers in StrictMode.
      await page.getByRole("button", { name: copy(language, "closeDialog"), exact: true }).click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      await page.getByRole("button", { name: copy(language, "resumeTicket"), exact: true }).first().click();
      assert.equal((await stats(page)).revoked.length, 0);
      await page.getByRole("button", { name: copy(language, "removeFile", { name: "draft.png" }), exact: true }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: copy(language, "removeMedia"), exact: true }).click();
      await page.waitForFunction(() => window.draftStats.revoked.length === 1);
      assert.equal(await page.getByText(copy(language, "pinSummary", { count: 1 }), { exact: true }).count(), 0);
      await page.getByRole("button", { name: copy(language, "takePhoto"), exact: true }).click();
      const camera = page.getByRole("dialog", { name: copy(language, "camera"), exact: true });
      await camera.getByRole("button", { name: copy(language, "takePhoto"), exact: true }).waitFor({ state: "visible" });
      await page.waitForFunction(() => window.draftStats.streams.length > 0);
      if (language === "en") {
        await camera.getByRole("button", { name: copy(language, "takePhoto"), exact: true }).click();
      } else {
        await camera.getByRole("button", { name: copy(language, "cancel"), exact: true }).click();
        await files(page);
      }
      await camera.waitFor({ state: "hidden" });
      await page.waitForFunction(() => window.draftStats.stops.length === window.draftStats.streams.length);
      await page.getByRole("button", { name: copy(language, "takePhoto"), exact: true }).click();
      await page.waitForFunction(() => window.draftStats.streams.length === 2);
      // Expiry while a camera is open unmounts the whole role experience.
      // The document stays loaded so instrumentation observes React teardown.
      // Server-side sign-out: the session watcher clears the local session.
      await convex.mutation(api.auth.signOut, { refreshToken });
      await page.waitForFunction(() => window.draftStats.revoked.length === 2 && window.draftStats.stops.length === 2);
      await (role === "staff" ? page.getByRole("button", { name: copy(language, "continueWithGoogle"), exact: true }) : page.locator("#customer-password")).waitFor({ state: "visible" });
      const observed = await stats(page);
      assert.deepEqual(observed.revoked, observed.created);
      assert.equal(new Set(observed.stops).size, observed.stops.length);
      assert.equal(uploads(), 0);
      assert.deepEqual(errors, []);
    } catch (error) { console.error("Browser state", await stats(page), (await page.locator("body").innerText()).slice(-3000)); throw error; } finally { await context.close(); }
  });
}

for (const role of ["staff", "customer"] as const) for (const language of ["en", "th"] as const) {
  test(`${role} ${language}: text-only creation submits directly without optional media or review navigation`, async () => {
    const { context, page, title, token, errors, uploads } = await open(role, language);
    try {
      const name = `Single form ${role} ${language} ${crypto.randomUUID()}`;
      const composer = page.getByRole("dialog", { name: copy(language, "newTicket"), exact: true });
      assert.equal(await composer.getByRole("button", { name: copy(language, "next"), exact: true }).count(), 0);
      await title.fill(name);
      await composer.getByRole("button", { name: copy(language, "submitTicket"), exact: true }).click();
      await composer.waitFor({ state: "hidden" });
      await page.waitForFunction(() => new URL(location.href).searchParams.has("ticket"));
      const id = new URL(page.url()).searchParams.get("ticket") as Id<"tickets">;
      const created = await convex.query(api.tickets.getTicket, { token, id });
      assert.equal(created?.title, name);
      assert.equal(created?.description, "");
      assert.deepEqual(created?.media, []);
      assert.equal(uploads(), 0);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

for (const role of ["staff", "customer"] as const) test(`${role}: Project switch keeps saved draft in its captured Project; text success and edit undo`, async () => {
  const { context, page, title, errors, uploads } = await open(role);
  try {
    const name = `P6 ${role} ${crypto.randomUUID()}`;
    // Exercise inline Queue details and restore that view on returning to POS.
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    if (role === "staff") await page.getByRole("button", { name: "Queue", exact: true }).click();
    await chooseProject(page, "APP");
    await page.getByRole("button", { name: "New Ticket", exact: true }).first().click();
    await page.getByRole("dialog").getByText("Customer App (APP)", { exact: true }).waitFor();
    assert.equal(await title.inputValue(), "");
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await chooseProject(page, "POS");
    await page.getByRole("button", { name: "New Ticket", exact: true }).first().click();
    await title.fill(name);
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await chooseProject(page, "APP");
    await page.getByRole("button", { name: copy("en", "resumeTicket"), exact: true }).first().click();
    assert.equal(await title.inputValue(), name);
    await page.getByRole("dialog").getByText("Point of Sale (POS)", { exact: true }).waitFor();
    await page.getByRole("button", { name: copy("en", "submitTicket"), exact: true }).click();
    await page.getByRole("dialog", { name: copy("en", "newTicket"), exact: true }).waitFor({ state: "hidden" });
    const matches = await convex.query(api.tickets.searchTickets, { token: seed.sessions[role === "staff" ? 0 : 1], projectId: seed.projects.find(p => p.key === "POS")!.id, search: name, lifecycle: "active" });
    const created = matches.matches.find(item => item.title === name);
    assert.ok(created, "Draft committed to POS after switching to APP");
    assert.equal(created.projectKey, "POS");
    assert.equal(new URL(page.url()).searchParams.get("project"), "POS");
    await page.getByRole("heading", { name, exact: true }).waitFor();
    // The successful submit selects its created Ticket. Back restores its list.
    await page.getByRole("button", { name: copy("en", "detailBack"), exact: true }).click();
    if (role === "staff") await page.getByPlaceholder("Search", { exact: true }).fill(name);
    await page.locator(`button[data-ticket-id="${created._id}"]`).click();
    await page.waitForURL(url => url.searchParams.get("ticket") === created._id);
    const detail = page.getByRole("region", { name, exact: true });
    await detail.waitFor();
    await page.reload();
    await detail.waitFor();
    assert.equal(new URL(page.url()).searchParams.get("project"), "POS");
    assert.equal(new URL(page.url()).searchParams.get("ticket"), created._id);
    if (role === "staff") assert.equal(await page.getByPlaceholder("Search", { exact: true }).inputValue(), name);
    await page.goBack();
    await detail.waitFor({ state: "hidden" });
    assert.equal(new URL(page.url()).searchParams.has("ticket"), false);
    await page.goForward();
    await page.waitForURL(url => url.searchParams.get("ticket") === created._id);
    await detail.waitFor();
    await page.getByRole("button", { name: copy("en", role === "staff" ? "edit" : "editTicket"), exact: true }).click();
    await page.locator(role === "staff" ? "#edit-ticket-title" : "#customer-edit-title").fill(`${name} edited`);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("button", { name: "Undo", exact: true }).last().click();
    await page.getByRole("heading", { name, exact: true }).waitFor();
    assert.equal((await convex.query(api.tickets.getTicket, { token: seed.sessions[role === "staff" ? 0 : 1], id: created._id }))?.title, name);
    // A subscription received while editing must not silently rebase the intent.
    await page.getByRole("button", { name: copy("en", role === "staff" ? "edit" : "editTicket"), exact: true }).click();
    await page.locator(role === "staff" ? "#edit-ticket-title" : "#customer-edit-title").fill("Unsaved stale edit");
    const current = (await convex.query(api.tickets.getTicket, { token: seed.sessions[0], id: created._id }))!;
    await convex.mutation(api.tickets.editTicket, { token: seed.sessions[0], id: created._id, expectedVersion: current.version, title: `${name} externally`, description: "" });
    await page.getByRole("heading", { name: `${name} externally`, exact: true }).waitFor();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: copy("en", "versionConflict") }).waitFor();
    assert.equal((await convex.query(api.tickets.getTicket, { token: seed.sessions[0], id: created._id }))?.title, `${name} externally`);
    await page.getByRole("button", { name: copy("en", "detailBack"), exact: true }).click();
    await page.getByRole("heading", { name: `${name} externally`, exact: true }).waitFor({ state: "hidden" });
    await page.locator(`button[data-ticket-id="${created._id}"]`).click();
    await page.getByRole("heading", { name: `${name} externally`, exact: true }).waitFor();
    assert.equal(await page.locator(role === "staff" ? "#edit-ticket-title" : "#customer-edit-title").count(), 0);
    assert.equal(await page.getByRole("alert").filter({ hasText: copy("en", "versionConflict") }).count(), 0);
    assert.equal(uploads(), 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

for (const role of ["staff", "customer"] as const) for (const language of ["en", "th"] as const) {
  test(`${role} ${language}: real Cancel preserves content and receipt after create; retry creates once; Discard releases previews`, async () => {
    let release!: () => void;
    let arrived!: () => void;
    const held = new Promise<void>(resolve => { arrived = resolve; });
    let loseResponses = true;
    const requests: Array<{ requestId: string; title: string; description: string; annotations: unknown[] }> = [];
    const { context, page, title, token, errors, uploads } = await open(role, language, async context => {
      await context.routeWebSocket(url => url.hostname === "127.0.0.1" && url.pathname.endsWith("/sync"), socket => {
        const server = socket.connectToServer();
        const mutations = new Map<number, { udfPath: string; args: Array<{ files?: Array<{ name: string; size: number; type: string }> }> }>();
        socket.onMessage(raw => {
          const message = JSON.parse(String(raw));
          if (message.type === "Mutation") {
            mutations.set(message.requestId, message);
            if (message.udfPath === "tickets:createTicket") requests.push(message.args[0]);
          }
          server.send(raw);
        });
        let incoming = Promise.resolve();
        server.onMessage(raw => { incoming = incoming.then(async () => {
          const message = JSON.parse(String(raw));
          const mutation = mutations.get(message.requestId);
          if (message.type === "MutationResponse" && message.success && mutation?.udfPath === "uploads:createUploadIntent" && !message.result.ticketId) {
            // Fake provider receipts stay on the disposable backend; no upload API.
            const uploadedFiles = [];
            for (const file of mutation.args[0].files ?? []) {
              const recorded = { ...file, key: `browser-${crypto.randomUUID()}`, url: "https://fixture.invalid/draft.png" };
              await convex.mutation(api.uploads.recordUploadedFile, { callbackToken: "local-only-callback-fixture", intentId: message.result.intentId, secret: message.result.secret, file: recorded });
              uploadedFiles.push(recorded);
            }
            socket.send(JSON.stringify({ ...message, result: { ...message.result, uploadedFiles } }));
            return;
          }
          if (message.type === "MutationResponse" && mutation?.udfPath === "tickets:createTicket" && loseResponses) {
            const fail = () => socket.send(JSON.stringify({ type: "MutationResponse", requestId: message.requestId, success: false, result: "Fixture response lost", logLines: [] }));
            if (requests.length === 1) { release = fail; arrived(); }
            else fail();
            return;
          }
          socket.send(raw);
        }); });
      });
    });
    try {
      const name = `Cancel ${role} ${language} ${crypto.randomUUID()}`;
      await title.fill(name);
      const description = page.locator(role === "staff" ? "#description" : "#customer-ticket-description");
      await description.fill("Keep this description");
      await files(page);
      await page.getByRole("button", { name: copy(language, "openMedia", { name: "draft.png" }), exact: true }).click();
      await page.getByRole("button", { name: copy(language, "addPin"), exact: true }).click();
      await page.getByRole("dialog").last().locator("img").first().click({ position: { x: 30, y: 30 } });
      await page.getByPlaceholder(copy(language, "describeIssue")).fill("Keep this pin");
      await page.getByRole("button", { name: copy(language, "savePin"), exact: true }).click();
      await page.getByRole("button", { name: copy(language, "closeDialog"), exact: true }).last().click();
      let attachmentName = "draft.png";
      if (language === "en") {
        const labels = markupLabels(language);
        await page.getByRole("button", { name: copy(language, "editImageNamed", { name: attachmentName }), exact: true }).click();
        const editor = page.getByRole("dialog", { name: copy(language, "editDraftImage"), exact: true });
        const surface = editor.getByRole("application");
        await surface.click();
        await editor.getByRole("button", { name: labels.review, exact: true }).click();
        await editor.getByRole("button", { name: labels.apply, exact: true }).click();
        await editor.waitFor({ state: "hidden" });
        attachmentName = (await page.locator('[data-slot="sortable-item"] img').first().getAttribute("alt"))!;
        assert.notEqual(attachmentName, "draft.png");
      }
      const releasedBeforeSubmit = (await stats(page)).revoked.length;
      const submit = page.getByRole("button", { name: copy(language, "submitTicket"), exact: true });
      await submit.click();
      await Promise.race([held, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Create response was not intercepted")), 8000))]);
      assert.equal(await page.getByRole("button", { name: copy(language, "discardDraft"), exact: true }).isDisabled(), true);
      if (role === "staff") {
        assert.equal(await title.isDisabled(), true);
        assert.equal(await description.isDisabled(), true);
        assert.equal(await page.locator('[data-slot="ticket-draft-files"]').isDisabled(), true);
        assert.equal(await page.getByRole("button", { name: copy(language, "openMedia", { name: attachmentName }), exact: true }).isDisabled(), true);
      }
      await page.getByRole("button", { name: copy(language, "cancelUpload"), exact: true }).click();
      assert.equal((await stats(page)).revoked.length, releasedBeforeSubmit);
      release();
      await submit.waitFor({ state: "visible" });
      loseResponses = false;
      await page.getByText(copy(language, "pinSummary", { count: 1 }), { exact: true }).waitFor();
      assert.equal(await title.inputValue(), name);
      assert.equal(await description.inputValue(), "Keep this description");
      await submit.click();
      await page.getByRole("dialog", { name: copy(language, "newTicket"), exact: true }).waitFor({ state: "hidden" });
      if (role === "staff") await page.getByRole("dialog").getByRole("button", { name: copy(language, "closeDialog"), exact: true }).click();
      assert.equal(requests.length, 3);
      assert.deepEqual(requests[0], requests[1]);
      assert.deepEqual(requests[0], requests[2]);
      const matches = await convex.query(api.tickets.searchTickets, { token, projectId: seed.projects.find(p => p.key === "POS")!.id, search: name, lifecycle: "active" });
      assert.equal(matches.matches.filter(item => item.title === name).length, 1);
      if (language === "en") {
        const saved = await convex.query(api.tickets.getTicket, { token, id: matches.matches.find(item => item.title === name)!._id });
        assert.equal(saved?.media[0]?.name, attachmentName);
        assert.equal(saved?.annotations?.[0]?.text, "Keep this pin");
      }
      assert.deepEqual((await stats(page)).revoked, (await stats(page)).created);
      // A separate Discard action is the only UI action here that drops content.
      await page.getByRole("button", { name: copy(language, "newTicket"), exact: true }).first().click();
      await title.fill("Discard this draft");
      await files(page);
      await page.getByRole("button", { name: copy(language, "discardDraft"), exact: true }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: copy(language, "cancel"), exact: true }).click();
      await page.getByRole("alertdialog").waitFor({ state: "hidden" });
      assert.equal(await title.inputValue(), "Discard this draft");
      await page.getByRole("dialog").getByRole("button", { name: copy(language, "discardDraft"), exact: true }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: copy(language, "discardDraft"), exact: true }).click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      assert.deepEqual((await stats(page)).revoked, (await stats(page)).created);
      await page.getByRole("button", { name: copy(language, "newTicket"), exact: true }).first().click();
      assert.equal(await title.inputValue(), "");
      assert.equal(uploads(), 0);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test("losing captured Project access leaves the customer draft discardable", async () => {
  const { context, page, title } = await open("customer");
  const projectId = seed.projects.find(project => project.key === "POS")!.id;
  const members = await convex.query(api.projects.listProjectMembers, { token: seed.sessions[0], projectId });
  const customerId = members.find(member => member.username === "alice")!.customerId;
  try {
    await title.fill("Captured POS draft");
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    // Before revocation both named choices are present in the Project menu.
    await projectSwitcher(page).click();
    await page.getByRole("menuitemradio").nth(1).waitFor();
    assert.deepEqual((await page.getByRole("menuitemradio").allInnerTexts()).sort(), ["Customer App (APP)", "Point of Sale (POS)"]);
    await page.keyboard.press("Escape");
    await page.getByRole("menu").waitFor({ state: "hidden" });
    await convex.mutation(api.projects.removeProjectMember, { token: seed.sessions[0], projectId, customerId });
    // One Project left: a plain label replaces the menu and the URL follows it.
    await page.locator("header").getByText("Customer App (APP)", { exact: true }).waitFor();
    await page.waitForURL(url => url.searchParams.get("project") === "APP");
    assert.equal(await projectSwitcher(page).count(), 0);
    await page.getByRole("button", { name: copy("en", "resumeTicket"), exact: true }).first().click();
    assert.equal(await title.inputValue(), "Captured POS draft");
    await page.getByRole("dialog").getByText("Point of Sale (POS)", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Discard draft", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Discard draft", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "New Ticket", exact: true }).first().click();
    await page.getByRole("dialog").getByText("Customer App (APP)", { exact: true }).waitFor();
    assert.equal(await title.inputValue(), "");
  } finally {
    // Access returns through the Owner's invitation and the customer's own join.
    const invitation = await convex.mutation(api.identity.createCustomerInvitation, { eligibilityConfirmed: true, token: seed.sessions[0], projectId });
    await convex.mutation(api.identity.joinWithInvitation, { token: seed.sessions[1], invitation: invitation.secret });
    await context.close();
  }
});


for (const language of ["en", "th"] as const) {
  test(`staff ${language}: operations health shows safe configuration, counts and diagnostic views`, async () => {
    const f = await open("staff", language);
    try {
      await f.page.getByRole("button", { name: copy(language, "closeDialog"), exact: true }).click();
      await openHeaderMenu(f.page, copy(language, "queueMore"));
      await f.page.getByRole("menuitem", { name: copy(language, "healthTitle"), exact: true }).click();
      const dialog = f.page.getByRole("dialog", { name: copy(language, "healthTitle"), exact: true });
      await dialog.getByText(copy(language, "healthStorage"), { exact: true }).waitFor();
      assert.equal(await dialog.getByRole("table", { name: copy(language, "healthCounts") }).count(), 1);
      await f.page.setViewportSize({ width: 360, height: 740 });
      const trigger = dialog.locator('[data-slot="ticket-filter-trigger"]');
      for (const key of ["healthFailed", "healthPending", "healthExpired"] as const) {
        await trigger.click();
        const choice = filterPanel(f.page).getByRole("radio", { name: copy(language, key), exact: true });
        await choice.click();
        assert.equal(await choice.isChecked(), true);
        await closeFilters(f.page);
        assert.equal(await trigger.evaluate(el => document.activeElement === el), true);
        await dialog.getByRole("heading", { name: copy(language, key), exact: true }).waitFor();
        assert.equal(await trigger.getAttribute("aria-label"), key === "healthFailed" ? copy(language, "ticketFilters") : copy(language, "ticketFiltersApplied", { count: 1 }));
        await dialog.getByText(copy(language, "healthPageHint"), { exact: true }).waitFor();
      }
      await trigger.click();
      await filterPanel(f.page).getByRole("button", { name: copy(language, "ticketFiltersClear") }).click();
      await closeFilters(f.page);
      await dialog.getByRole("heading", { name: copy(language, "healthFailed"), exact: true }).waitFor();
      assert.equal(await trigger.getAttribute("aria-label"), copy(language, "ticketFilters"));
      assert.doesNotMatch(await dialog.innerText(), /local-only-callback-fixture|https?:|UPLOADTHING_TOKEN|UPLOAD_CALLBACK_SECRET/);
      assert.deepEqual(f.errors, []);
      assert.equal(f.uploads(), 0);
    } finally { await f.context.close(); }
  });
}

test("customer navigation does not expose staff health", async () => {
  const f = await open("customer");
  try {
    await f.page.getByRole("button", { name: copy("en", "closeDialog"), exact: true }).click();
    assert.equal(await f.page.getByRole("button", { name: copy("en", "healthTitle"), exact: true }).count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

for (const language of ["en", "th"] as const) test(`customer ${language}: Ticket header fits in one phone row`, async () => {
  const { page, context } = await open("customer", language);
  try {
    await page.goto(`${baseURL}/customer?project=POS&ticket=${seed.tickets[1]}`);
    await page.getByRole("button", { name: copy(language, "detailBack"), exact: true }).waitFor();
    const header = page.locator("main > header");
    const wordmark = header.getByText(copy(language, "appName"), { exact: true });
    const project = projectSwitcher(page, language);
    const inbox = header.getByRole("button", { name: copy(language, "ticketInbox"), exact: true });
    const account = header.getByRole("button", { name: copy(language, "customerQueueMore"), exact: true });
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await wordmark.isVisible(), false);
      await project.getByText("POS", { exact: true }).waitFor();
      assert.equal(await project.innerText(), "POS");
      const toolbar = await header.boundingBox();
      assert.ok(toolbar && toolbar.height <= 64, `Header height at ${width}px: ${toolbar?.height}`);
      for (const control of [project, inbox, account]) {
        const box = await control.boundingBox();
        assert.ok(box && box.height >= 44 && box.x >= 0 && box.x + box.width <= width);
        assert.ok(Math.abs(box.y + box.height / 2 - (toolbar.y + toolbar.height / 2)) <= 1);
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await wordmark.waitFor();
    await project.getByText(/\(POS\)/).waitFor();
    assert.match(await project.innerText(), /\(POS\)/);
  } finally { await context.close(); }
});

for (const language of ["en", "th"] as const) test(`customer ${language}: phone filters preserve search and restore the linked status on Back`, async () => {
  const { page, context } = await open("customer", language);
  try {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto(`${baseURL}/customer?project=POS&filter=waiting&q=Printer`);
    const trigger = filterTrigger(page);
    await page.getByRole("button", { name: copy(language, "ticketFiltersApplied", { count: 1 }), exact: true }).waitFor();
    const indicator = trigger.locator('[data-slot="ticket-filter-indicator"]');
    assert.equal(await indicator.isVisible(), true);
    assert.equal(await indicator.innerText(), "");
    await trigger.press("Enter");
    const waiting = filterPanel(page).getByRole("radio", { name: copy(language, "customerQueueWaiting"), exact: true });
    assert.equal(await waiting.isChecked(), true);
    await waiting.press("ArrowDown");
    await page.waitForURL(url => url.searchParams.get("filter") === "done");
    const bounds = await filterPanel(page).boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 360);
    await filterPanel(page).getByRole("button", { name: copy(language, "ticketFiltersClear"), exact: true }).click();
    await page.waitForURL(url => !url.searchParams.has("filter") && url.searchParams.get("q") === "Printer");
    await closeFilters(page);
    assert.equal(await trigger.evaluate(el => document.activeElement === el), true);
    assert.equal(await trigger.getAttribute("aria-label"), copy(language, "ticketFilters"));
    await page.goBack();
    await page.waitForURL(url => url.searchParams.get("filter") === "done" && url.searchParams.get("q") === "Printer");
    await page.getByRole("button", { name: copy(language, "ticketFiltersApplied", { count: 1 }), exact: true }).waitFor();
  } finally { await context.close(); }
});

test("customer filter panel closes when resizing hides the list beside an open Ticket", async () => {
  const { page, context } = await open("customer");
  try {
    await page.getByRole("button", { name: copy("en", "closeDialog"), exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.locator("button[data-ticket-id]").first().click();
    await page.waitForURL(url => url.searchParams.has("ticket"));
    await openFilters(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await filterPanel(page).waitFor({ state: "hidden" });
    await page.setViewportSize({ width: 1280, height: 800 });
    assert.equal(await filterTrigger(page).getAttribute("aria-expanded"), "false");
  } finally { await context.close(); }
});

test("customer search finds older Tickets and can include resolved Tickets", async () => {
  const { page, context, token, errors } = await open("customer");
  try {
    await page.getByRole("button", { name: copy("en", "closeDialog"), exact: true }).click();
    const query = page.getByLabel(copy("en", "customerQueueSearch"), { exact: true });
    const setStatus = async (key: "allTickets" | "customerQueueAllActive") => {
      await openFilters(page);
      await filterPanel(page).getByRole("radio", { name: new RegExp("^" + copy("en", key) + "(?:$|\\s)") }).click();
      await closeFilters(page);
    };
    const older = page.getByRole("button", { name: copy("en", "loadOlder"), exact: true });
    const rows = page.locator("button[data-ticket-id]");
    const projectId = seed.projects.find(project => project.key === "POS")!.id;
    const scope = { projectId, lifecycle: "active" as const };
    const resolved = await convex.query(api.tickets.searchTickets, { ...scope, token, status: "done", search: "Printer queue fixture" });
    const target = resolved.matches.find(ticket => ticket.title === "Printer queue fixture 4");
    assert.ok(target, "seeded older resolved Ticket");
    const reference = formatTicketNumber(target.ticketNumber, target.projectKey);
    const targetRow = page.locator(`button[data-ticket-id="${target._id}"]`);
    const noMatches = page.getByText(copy("en", "customerQueueSearchEmpty"), { exact: true });

    await setStatus("allTickets");
    await older.waitFor();
    assert.equal(await targetRow.count(), 0, "the resolved Ticket lies beyond the first page");
    await setStatus("customerQueueAllActive");
    await query.fill("quartz");
    await rows.filter({ hasText: "Printer calibration" }).waitFor();
    assert.equal(await rows.filter({ hasText: "quartz calibration" }).count(), 0, "the other customer's Ticket stays hidden");
    assert.equal(await older.count(), 0, "search has its own result cap");
    await query.fill("Printer queue fixture");
    await rows.nth(1).waitFor();
    const nextId = await rows.nth(1).getAttribute("data-ticket-id");
    await rows.first().click();
    await page.getByRole("button", { name: copy("en", "detailNext"), exact: true }).click();
    await page.waitForFunction(id => new URL(location.href).searchParams.get("ticket") === id, nextId);
    await page.getByRole("button", { name: copy("en", "detailBack"), exact: true }).click();

    await query.fill(reference);
    await noMatches.waitFor();
    await page.getByRole("button", { name: copy("en", "customerQueueSearchAllStatuses"), exact: true }).click();
    await targetRow.waitFor();
    assert.equal(await filterTrigger(page).getAttribute("aria-label"), "Filters, 1 applied");
    assert.equal(await filterTrigger(page).evaluate(el => document.activeElement === el), true);
    assert.equal(new URL(page.url()).searchParams.get("filter"), "all");
    assert.equal(await query.inputValue(), reference);
    await targetRow.click();
    await page.getByRole("heading", { name: target.title, exact: true }).waitFor();
    await page.goBack();
    await page.waitForFunction(id => document.activeElement?.getAttribute("data-ticket-id") === id, target._id);
    assert.equal(await query.inputValue(), reference);

    const clear = page.getByRole("button", { name: copy("en", "clearSearch"), exact: true });
    const clearSize = await clear.boundingBox();
    assert.ok(clearSize && clearSize.width >= 44 && clearSize.height >= 44);
    await clear.press("Enter");
    await page.waitForURL(url => !url.searchParams.has("q"));
    assert.equal(await query.inputValue(), "");
    assert.equal(new URL(page.url()).searchParams.get("filter"), "all");
    assert.equal(await query.evaluate(input => input === document.activeElement), true);
    await clear.waitFor({ state: "hidden" });
    await older.waitFor();
    assert.equal(await rows.count(), 20, "clearing search restores the first browse page");
    await older.click();
    await page.waitForFunction(() => document.querySelectorAll("button[data-ticket-id]").length === 40);
    assert.equal(await targetRow.count(), 0, "the resolved Ticket lies beyond the first 40 rows");

    await query.fill(reference);
    await targetRow.waitFor();
    await clear.click();
    await older.waitFor();
    assert.equal(await rows.count(), 40, "clearing search restores the loaded browse pages");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

for (const language of ["en", "th"] as const) test(`${language}: customer Ticket thread supports hosted pages and two-way replies`, async () => {
  const customer = await openWith(await browsers.get(), "customer", language, undefined, {
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
  });
  let staff: Awaited<ReturnType<typeof open>> | undefined;
  const name = `Conversation ${language} ${crypto.randomUUID()}`;
  const description = "The receipt printer disconnects after its first print.";
  const question = `Which connection does your printer use? ${language}`;
  const reply = `It uses Bluetooth. ${language}`;
  const replyBox = customer.page.getByLabel(copy(language, "replyLabel"), { exact: true });
  const customerSend = customer.page.getByRole("button", { name: copy(language, "sendReply"), exact: true });
  try {
    await customer.title.fill(name);
    await customer.page.locator("#customer-ticket-description").fill(description);
    await customer.page.getByRole("button", { name: copy(language, "submitTicket"), exact: true }).click();
    await customer.page.getByRole("dialog").waitFor({ state: "hidden" });
    await customer.page.getByRole("heading", { name, exact: true }).waitFor();
    const id = new URL(customer.page.url()).searchParams.get("ticket") as Id<"tickets">;
    assert.ok(id);

    await customer.page.getByRole("button", { name: copy(language, "detailBack"), exact: true }).click();
    const customerRow = customer.page.locator(`button[data-ticket-id="${id}"]`);
    assert.ok((await customerRow.getAttribute("aria-label"))?.includes(name));
    await customerRow.click();
    await customer.page.getByRole("heading", { name, exact: true }).waitFor();
    await customer.page.goBack();
    await customer.page.waitForFunction(ticket => !new URL(location.href).searchParams.has("ticket") && document.activeElement?.getAttribute("data-ticket-id") === ticket, id);
    await customerRow.click();
    await customer.page.getByText(copy(language, "noTicketMessages"), { exact: true }).waitFor();
    assert.equal(await customer.page.getByRole("button", { name: copy(language, "threadAttachPage"), exact: true }).count(), 0);
    const picker = customer.page.locator('[data-slot="ticket-reply-files"]');
    assert.equal(await picker.getAttribute("accept"), "image/*,video/*");
    await picker.setInputFiles({ name: "page.html", mimeType: "text/html", buffer: Buffer.from("<p>Page</p>") });
    await customer.page.getByRole("alert").filter({ hasText: copy(language, "imageVideoOnly") }).waitFor();
    await files(customer.page, "reply-photo.png", picker);
    const removePhoto = customer.page.getByRole("button", { name: copy(language, "removeFile", { name: "reply-photo.png" }), exact: true });
    await removePhoto.waitFor();
    await replyBox.fill("It also happens on our second register.");
    await customer.page.getByRole("button", { name: copy(language, "detailBack"), exact: true }).click();
    await customerRow.click();
    assert.equal(await replyBox.inputValue(), "It also happens on our second register.");
    await removePhoto.click();
    await customerSend.click();
    await customer.page.getByText(copy(language, "replySent"), { exact: true }).waitFor();

    staff = await open("staff", language);
    await staff.page.getByRole("button", { name: copy(language, "closeDialog"), exact: true }).click();
    await staff.page.getByPlaceholder(copy(language, "search"), { exact: true }).fill(name);
    await staff.page.locator(`button[data-ticket-id="${id}"]`).click();
    const staffPanel = staff.page.getByRole("heading", { name, exact: true });
    await staffPanel.waitFor();
    const file = path.join(pageFixture, "reports/details.html");
    const publishName = copy(language, "publishPage");
    if (language === "th") {
      const pagesButton = staff.page.getByRole("button", { name: copy(language, "pagesTitle"), exact: true });
      await pagesButton.click();
      await publishFrom(staff.page.locator("body"), language, "chooseHtmlFile", file);
      await pagesButton.click();
    }
    const conversation = staff.page.getByRole("button", { name: copy(language, "ticketConversation"), exact: true });
    if (await conversation.getAttribute("aria-expanded") === "false") await conversation.click();
    await staff.page.getByText("It also happens on our second register.", { exact: true }).waitFor();
    const staffReply = staff.page.getByLabel(copy(language, "replyLabel"), { exact: true });
    const attach = staff.page.getByRole("button", { name: copy(language, "threadAttachPage"), exact: true });
    await staffReply.fill(question);
    await attach.click();
    if (language === "en") {
      await staff.page.getByRole("button", { name: publishName, exact: true }).click();
      const publisher = staff.page.getByRole("dialog", { name: publishName, exact: true });
      await publisher.getByLabel(copy(language, "chooseHtmlFile"), { exact: true }).setInputFiles(file);
      await publisher.getByRole("button", { name: publishName, exact: true }).click();
      await publisher.waitFor({ state: "hidden" });
      await staff.page.getByRole("button", { name: copy(language, "threadRemoveLink"), exact: true }).waitFor();
    }
    const [published] = await convex.query(api.pages.listTicketPages, { token: staff.token, id });
    assert.ok(published?.url.includes("/p/"));
    const hostedUrl = published.url;
    if (language === "th") {
      await staff.page.getByRole("combobox", { name: copy(language, "threadAttachPage"), exact: true }).selectOption(published._id);
    }
    await staff.page.getByLabel(copy(language, "threadRequestReply"), { exact: true }).check();
    await staff.page.getByRole("button", { name: copy(language, "sendQuestion"), exact: true }).click();
    await staff.page.getByText(copy(language, "questionSent"), { exact: true }).waitFor();
    assert.equal((await convex.query(api.tickets.getTicket, { token: staff.token, id }))?.status, "waiting");

    await customer.page.locator("[data-message-id]").getByText(question, { exact: true }).waitFor();
    await customer.page.getByRole("button", { name: copy(language, "detailBack"), exact: true }).click();
    await customerRow.getByText(copy(language, "feedNeedsReply"), { exact: true }).waitFor();
    assert.ok((await customerRow.locator("[data-ticket-excerpt]").innerText()).includes(question));
    if (language === "en") {
      for (let index = 0; index < 12; index++) {
        await convex.mutation(api.conversations.send, {
          token: staff.token, id, body: `Staff update ${index + 1}`, requestId: crypto.randomUUID(), expectedVersion: 0, requestReply: false,
        });
      }
    }
    await customerRow.click();
    if (language === "en") {
      await customer.page.locator("[data-message-id]").getByText("Staff update 12", { exact: true }).waitFor();
      await customer.page.locator("[data-message-id]").getByText(question, { exact: true }).waitFor({ state: "hidden" });
      await customer.page.getByRole("button", { name: copy(language, "threadAnswerQuestion"), exact: true }).click();
      await customer.page.getByText(copy(language, "threadQuoting", { quote: "details.html" }), { exact: true }).waitFor();
      await customer.page.getByRole("button", { name: copy(language, "loadOlderMessages"), exact: true }).click();
      await customer.page.locator("[data-message-id]").getByText(question, { exact: true }).waitFor();
    }
    const descriptionBox = await customer.page.getByRole("article").getByText(description, { exact: true }).boundingBox();
    const questionBox = await customer.page.locator("[data-message-id]").getByText(question, { exact: true }).boundingBox();
    const composerBox = await replyBox.boundingBox();
    assert.ok(questionBox && composerBox && descriptionBox && descriptionBox.y < questionBox.y && questionBox.y < composerBox.y);
    await customer.page.getByRole("button", { name: copy(language, "threadAnswerQuestion"), exact: true }).click();
    assert.equal(await replyBox.evaluate(input => input === document.activeElement), true);
    const sharedPage = customer.page.getByRole("link", { name: copy(language, "openPageNamed", { name: "details.html" }), exact: true });
    assert.equal(await sharedPage.getAttribute("href"), hostedUrl);
    if (language === "en") await expectAccessible(customer.page, "Customer Ticket thread");
    const [popup] = await Promise.all([customer.context.waitForEvent("page"), sharedPage.click()]);
    await popup.getByRole("heading", { name: "Fixture details", exact: true }).waitFor();
    await popup.close();

    await customer.page.getByRole("button", { name: copy(language, "threadQuoteLinkNamed", { name: "details.html" }), exact: true }).click();
    await customer.page.getByText(copy(language, "threadQuoting", { quote: "details.html" }), { exact: true }).waitFor();
    assert.equal(await replyBox.evaluate(input => input === document.activeElement), true);
    await replyBox.fill(reply);
    await customer.page.getByRole("button", { name: copy(language, "threadLink"), exact: true }).click();
    const address = customer.page.getByLabel(copy(language, "threadLinkAddress"), { exact: true });
    await address.press("Escape");
    assert.equal(await replyBox.inputValue(), reply, "Escape closes link entry and keeps the current reply");
    await customer.page.getByRole("button", { name: copy(language, "threadLink"), exact: true }).click();
    await address.fill("http://example.com/device");
    await customer.page.getByRole("button", { name: copy(language, "threadAddLink"), exact: true }).click();
    await customer.page.getByRole("alert").filter({ hasText: copy(language, "threadInvalidLink") }).waitFor();
    await address.fill("https://example.com/device");
    await customer.page.getByRole("button", { name: copy(language, "threadAddLink"), exact: true }).click();
    await customer.page.getByRole("button", { name: copy(language, "detailBack"), exact: true }).click();
    await customerRow.click();
    assert.equal(await replyBox.inputValue(), reply);
    await customer.page.getByText(copy(language, "threadQuoting", { quote: "details.html" }), { exact: true }).waitFor();
    await customer.page.getByRole("button", { name: copy(language, "threadRemoveLink"), exact: true }).waitFor();
    await customerSend.click();
    await customer.page.getByText(copy(language, "replySent"), { exact: true }).waitFor();
    await customer.page.getByRole("button", { name: copy(language, "threadAnswerQuestion"), exact: true }).waitFor({ state: "hidden" });
    await customer.page.getByRole("button", { name: copy(language, "detailBack"), exact: true }).click();
    await customerRow.getByText(copy(language, "customerQueueYouReplied"), { exact: true }).waitFor();
    assert.equal(await customerRow.getByText(copy(language, "feedNeedsReply"), { exact: true }).count(), 0);
    await customerRow.click();
    await staff.page.getByText(reply, { exact: true }).waitFor();
    await staff.page.getByText(copy(language, "threadCustomerReplied"), { exact: true }).first().waitFor();
    const external = staff.page.getByRole("link", { name: copy(language, "threadOpenLinkNamed", { name: "example.com" }), exact: true });
    assert.equal(await external.getAttribute("href"), "https://example.com/device");
    assert.equal(await external.getAttribute("rel"), "noopener noreferrer");

    await staff.page.locator("[data-message-id]").filter({ hasText: reply }).getByRole("button").last().click();
    await staff.page.getByText(copy(language, "threadQuoting", { quote: reply }), { exact: true }).waitFor();
    await staffReply.fill("Thanks. I can reproduce this now.");
    await staff.page.getByRole("button", { name: copy(language, "sendReply"), exact: true }).click();
    await customer.page.getByText("Thanks. I can reproduce this now.", { exact: true }).waitFor();
    await customer.page.getByRole("button", { name: copy(language, "detailBack"), exact: true }).click();
    await customerRow.getByText(copy(language, "customerQueueYouReplied"), { exact: true }).waitFor();
    await customerRow.click();
    await replyBox.fill("I can test another version.");
    await customerSend.click();
    await staff.page.getByText("I can test another version.", { exact: true }).waitFor();

    if (language === "en") {
      const receipt = { name: "reply-photo.png", size: 128, type: "image/png", key: `fixture-${crypto.randomUUID()}`, url: "https://fixture.invalid/reply-photo.png" };
      const intent = await convex.mutation(api.uploads.createUploadIntent, {
        token: customer.token, idempotencyKey: crypto.randomUUID(), files: [{ name: receipt.name, size: receipt.size, type: receipt.type }],
      });
      await convex.mutation(api.uploads.recordUploadedFile, {
        callbackToken: "local-only-callback-fixture", intentId: intent.intentId, secret: intent.secret, file: receipt,
      });
      const writable = await convex.query(api.tickets.getTicket, { token: customer.token, id });
      assert.ok(writable);
      await convex.mutation(api.conversations.send, {
        token: customer.token, id, body: "", media: [receipt], requestId: crypto.randomUUID(),
        uploadIntentId: intent.intentId, uploadIntentSecret: intent.secret, expectedVersion: writable.version,
      });
      const media = customer.page.getByRole("button", { name: copy(language, "threadOpenAttachment", { name: receipt.name }), exact: true });
      await media.waitFor();
      assert.equal(await customer.page.getByRole("article").getByRole("button").count(), 0, "Reply media is not attributed to the opening post");
      await media.click();
      await customer.page.getByRole("button", { name: copy(language, "detailMedia", { count: 1 }), exact: true, expanded: true }).waitFor();
      await staff.page.getByRole("button", { name: copy(language, "threadOpenAttachment", { name: receipt.name }), exact: true }).waitFor();
    }

    if (language === "en") {
      await customer.page.getByRole("button", { name: copy(language, "loadOlderMessages"), exact: true }).click();
      await sharedPage.waitFor();
    }
    await convex.mutation(api.pages.revokeTicketPage, { token: staff.token, pageId: published._id });
    await customer.page.getByText(copy(language, "threadPageUnavailable"), { exact: true }).waitFor();
    assert.equal(await sharedPage.count(), 0);
    const current = await convex.query(api.tickets.getTicket, { token: staff.token, id });
    assert.ok(current);
    assert.equal(current.status, "waiting");
    await convex.mutation(api.tickets.updateTicketStatus, { token: staff.token, id, status: "done", expectedVersion: current.version });
    await customer.page.getByText(copy(language, "threadResolved"), { exact: true }).waitFor();
    assert.equal(await customerSend.count(), 0);
    assert.equal(customer.uploads() + staff.uploads(), 0);
    assert.deepEqual(customer.errors, []);
    assert.deepEqual(staff.errors, []);
  } finally { await staff?.context.close(); await customer.context.close(); }
});

test("customer thread quotes exact files, notes and saved video moments via keyboard and viewer, and hides internal urgency", async () => {
  const { readFileSync } = await import("node:fs");
  const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2dIAAAAASUVORK5CYII=", "base64");
  const webmBytes = readFileSync(path.resolve(import.meta.dirname, "pin-video.webm"));
  const customer = await open("customer", "en", async context => {
    await context.route("https://fixture.invalid/**", route => {
      const url = route.request().url();
      if (url.endsWith(".webm")) return route.fulfill({ status: 200, contentType: "video/webm", body: webmBytes });
      return route.fulfill({ status: 200, contentType: "image/png", body: pngBytes });
    });
  });
  const staffToken = seed.sessions[0];
  const projectId = seed.projects.find(p => p.key === "POS")!.id;
  const title = `Evidence quotes ${crypto.randomUUID()}`;
  const photo = {
    key: `fixture-ev-img-${crypto.randomUUID()}`,
    name: "checkout-receipt.png",
    size: pngBytes.length,
    type: "image/png",
    url: "https://fixture.invalid/checkout-receipt.png",
  };
  const video = {
    key: `fixture-ev-vid-${crypto.randomUUID()}`,
    name: "till-print.webm",
    size: webmBytes.length,
    type: "video/webm",
    url: "https://fixture.invalid/till-print.webm",
  };
  try {
    const intent = await convex.mutation(api.uploads.createUploadIntent, {
      token: customer.token,
      idempotencyKey: crypto.randomUUID(),
      files: [photo, video].map(({ name, size, type }) => ({ name, size, type })),
    });
    for (const file of [photo, video]) {
      await convex.mutation(api.uploads.recordUploadedFile, {
        callbackToken: "local-only-callback-fixture",
        intentId: intent.intentId,
        secret: intent.secret,
        file,
      });
    }
    const id = await convex.mutation(api.tickets.createTicket, {
      token: customer.token,
      projectId,
      title,
      description: "Receipt total is short by 100.",
      requestId: crypto.randomUUID(),
      media: [photo, video],
      annotations: [
        { mediaIndex: 0, kind: "point", x: 0.7, y: 0.4, text: "MEMBER -100 printed twice" },
        { mediaIndex: 1, kind: "time", x: 0.5, y: 0.5, time: 4, text: "Printer pauses before second line" },
      ],
      uploadIntentId: intent.intentId,
      uploadIntentSecret: intent.secret,
    });
    const detail = await convex.query(api.tickets.getTicket, { token: customer.token, id });
    assert.ok(detail);
    const pointNote = detail.annotations.find(note => note.kind === "point")!;
    const momentNote = detail.annotations.find(note => note.kind === "time")!;
    // Staff updates internal urgency; customer history must not expose it.
    await convex.mutation(api.tickets.updateUrgencyScore, {
      token: staffToken, id, urgencyScore: 85, expectedVersion: detail.version,
    });

    await customer.page.goto(`${baseURL}/customer?project=POS&ticket=${id}`);
    await customer.page.getByRole("heading", { name: title, exact: true }).waitFor();
    const replyBox = customer.page.getByLabel(copy("en", "replyLabel"), { exact: true });
    const sendButton = customer.page.getByRole("button", { name: copy("en", "sendReply"), exact: true });

    // 1. Keyboard picker flow: Escape closes picker cleanly, selecting a note populates composer and returns focus.
    const citeButton = customer.page.getByRole("button", { name: copy("en", "threadCiteEvidence"), exact: true });
    await citeButton.click();
    const selector = customer.page.getByRole("combobox", { name: copy("en", "threadCiteEvidence"), exact: true });
    await selector.waitFor();
    await selector.press("Escape");
    await selector.waitFor({ state: "hidden" });
    assert.equal(await replyBox.evaluate(el => el === document.activeElement), true);

    await citeButton.click();
    await selector.selectOption(`annotation:${pointNote.id}`);
    await customer.page.getByText(copy("en", "threadAboutNote", { file: photo.name, label: pointNote.label }), { exact: true }).waitFor();
    assert.equal(await replyBox.evaluate(el => el === document.activeElement), true);
    await replyBox.fill("Look at the duplicate discount line here.");
    await customer.page.getByRole("button", { name: copy("en", "detailBack"), exact: true }).click();
    await customer.page.locator(`button[data-ticket-id="${id}"]`).click();
    await customer.page.getByText(copy("en", "threadAboutNote", { file: photo.name, label: pointNote.label }), { exact: true }).waitFor();
    assert.equal(await replyBox.inputValue(), "Look at the duplicate discount line here.");
    await sendButton.click();
    await customer.page.getByText("Look at the duplicate discount line here.", { exact: true }).waitFor();

    // Clicking the sent note quote opens MediaViewer and focuses the exact pin.
    const noteQuoteButton = customer.page.locator("[data-message-id]")
      .filter({ hasText: "Look at the duplicate discount line here." })
      .getByRole("button", { name: new RegExp(photo.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
    await noteQuoteButton.click();
    await customer.page.getByRole("button", { name: copy("en", "detailMedia", { count: 2 }), exact: true, expanded: true }).waitFor();
    await customer.page.getByRole("heading", { name: copy("en", "noteLabel", { number: pointNote.label }), exact: true }).waitFor();
    await customer.page.waitForFunction(pinId => document.activeElement?.getAttribute("data-pin-id") === pinId, pointNote.id);

    // 2. Quote a saved video moment directly from the annotation list, send, and jump back to it.
    await customer.page.getByRole("button", { name: copy("en", "threadQuoteMoment", { time: "0:04" }), exact: true }).first().click();
    await customer.page.getByText(copy("en", "threadAboutMoment", { file: video.name, time: "0:04" }), { exact: true }).waitFor();
    assert.equal(await replyBox.evaluate(el => el === document.activeElement), true);
    await replyBox.fill("The pause happens right at four seconds.");
    await sendButton.click();
    await customer.page.getByText("The pause happens right at four seconds.", { exact: true }).waitFor();

    const momentQuoteButton = customer.page.locator("[data-message-id]")
      .filter({ hasText: "The pause happens right at four seconds." })
      .getByRole("button", { name: new RegExp(video.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
    await momentQuoteButton.click();
    await customer.page.locator(`video[aria-label="${video.name}"]`).waitFor();
    await customer.page.getByRole("heading", {
      name: `${copy("en", "noteLabel", { number: momentNote.label })} · ${copy("en", "pinAtTime", { time: "0:04" })}`,
      exact: true,
    }).waitFor();

    // 3. Quote the exact file from MediaViewer toolbar and verify sent file quote focuses it.
    await customer.page.getByRole("button", { name: copy("en", "threadQuoteFile"), exact: true }).click();
    assert.equal(await replyBox.evaluate(el => el === document.activeElement), true);
    await replyBox.fill("Sharing this video file directly.");
    await sendButton.click();
    const fileQuoteButton = customer.page.locator("[data-message-id]")
      .filter({ hasText: "Sharing this video file directly." })
      .getByRole("button", { name: new RegExp(video.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
    await fileQuoteButton.waitFor();
    await fileQuoteButton.click();
    await customer.page.locator(`video[aria-label="${video.name}"]`).waitFor();

    // 4. Soft-deleting the photo note switches the sent quote safely to unavailable without leaking deleted text.
    const latest = (await convex.query(api.tickets.getTicket, { token: customer.token, id }))!;
    await convex.mutation(api.annotations.removeAnnotation, {
      token: customer.token, id, expectedVersion: latest.version, annotationId: pointNote.id,
    });
    await customer.page.getByText(copy("en", "threadQuotedNoteUnavailable"), { exact: true }).waitFor();
    assert.equal(await noteQuoteButton.count(), 0);

    // 5. Customer Recent history excludes internal urgency changes.
    await customer.page.getByRole("button", { name: copy("en", "detailHistory"), exact: true }).click();
    await customer.page.getByText(copy("en", "actionCreated"), { exact: true }).waitFor();
    assert.equal(await customer.page.getByText(copy("en", "actionUrgencyChanged"), { exact: true }).count(), 0);
    assert.equal(customer.uploads(), 0);
    assert.deepEqual(customer.errors, []);
  } finally {
    await customer.context.close();
  }
});

for (const language of ["en", "th"] as const) {
  test(`staff ${language}: purge requeue requires confirmation and cancellation sends no mutation`, async () => {
    // Exercise the real health UI with a failed-job transport fixture; never schedule deletion.
    const f = await open("staff", language, async context => {
      await context.route("**/src/features/operations/adapters/health.ts", route => route.fulfill({
        contentType: "application/javascript",
        body: `window.healthRequeues = [];
          export const useHealth = () => ({ counts: {}, oldestPendingAt: null,
            configuration: { uploadThingToken: false, callbackSecret: true, mediaCleanupEnabled: false } });
          export const useJobDiagnostics = () => ({ status: "Exhausted", loadMore() {},
            results: [{ jobId: "fake-purge", kind: "ticket_purge", state: "failed", attempt: 0, maxAttempts: 8,
              availableAt: 1794614400000, lastOutcome: "ownership_conflict", purgeBlocked: true }],
            requeue: async args => { window.healthRequeues.push(args); return true; } });`,
      }));
    });
    try {
      await f.page.getByRole("button", { name: copy(language, "closeDialog"), exact: true }).click();
      await openHeaderMenu(f.page, copy(language, "queueMore"));
      await f.page.getByRole("menuitem", { name: copy(language, "healthTitle"), exact: true }).click();
      const dialog = f.page.getByRole("dialog", { name: copy(language, "healthTitle"), exact: true });
      const requeue = dialog.getByRole("button", { name: copy(language, "healthRequeue"), exact: true });
      const prompts: string[] = [];
      f.page.once("dialog", async prompt => { prompts.push(prompt.message()); await prompt.dismiss(); });
      await requeue.click();
      const calls = () => f.page.evaluate(() => (window as unknown as { healthRequeues: unknown[] }).healthRequeues);
      assert.deepEqual(await calls(), []);
      f.page.once("dialog", async prompt => { prompts.push(prompt.message()); await prompt.accept(); });
      await requeue.click();
      await f.page.getByText(copy(language, "healthRequeued"), { exact: true }).waitFor();
      assert.deepEqual(await calls(), [{ jobId: "fake-purge" }]);
      assert.deepEqual(prompts, [copy(language, "healthPurgeConfirm"), copy(language, "healthPurgeConfirm")]);
      assert.deepEqual(f.errors, []);
      assert.equal(f.uploads(), 0);
    } finally { await f.context.close(); }
  });
}

for (const language of ["en", "th"] as const) {
  test(`staff ${language}: operations health stays compact and unclipped across phone, sm and desktop viewports`, async () => {
    // Exercise populated counts, diagnostic states and paging with a transport fixture; never schedule deletion.
    const f = await open("staff", language, async context => {
      await context.route("**/src/features/operations/adapters/health.ts", route => route.fulfill({
        contentType: "application/javascript",
        body: `window.healthLoadMore = [];
          const counts = {
            "cancellation:pending": 4, "cancellation:running": 2, "cancellation:completed": 12, "cancellation:failed": 1, "cancellation:superseded": 0,
            "intent_expiry:pending": 3, "intent_expiry:running": 1, "intent_expiry:completed": 8, "intent_expiry:failed": 0, "intent_expiry:superseded": 0,
            "rejected_upload:pending": 2, "rejected_upload:running": 0, "rejected_upload:completed": 5, "rejected_upload:failed": 1, "rejected_upload:superseded": 0,
            "ticket_purge:pending": 1, "ticket_purge:running": 1, "ticket_purge:completed": 3, "ticket_purge:failed": 1, "ticket_purge:superseded": 2,
          };
          const byView = {
            failed: [
              { jobId: "f-cancel", kind: "cancellation", state: "failed", attempt: 3, maxAttempts: 8, availableAt: 1795700400000, lastOutcome: "failed_permanent", exhausted: false, purgeBlocked: false },
              { jobId: "f-purge", kind: "ticket_purge", state: "failed", attempt: 8, maxAttempts: 8, availableAt: 1795700400000, lastOutcome: "ownership_conflict", exhausted: true, purgeBlocked: true },
            ],
            pending: [
              { jobId: "p-expiry", kind: "intent_expiry", state: "pending", attempt: 1, maxAttempts: 8, availableAt: 1795700460000, lastOutcome: "failed_retryable", exhausted: false, purgeBlocked: false },
            ],
            expired: [
              { jobId: "e-cancel", kind: "cancellation", state: "running", attempt: 2, maxAttempts: 8, availableAt: 1795700400000, leaseExpiresAt: 1795701180000, exhausted: false, purgeBlocked: false },
            ],
          };
          export const useHealth = () => ({ counts, oldestPendingAt: 1795698180000,
            configuration: { uploadThingToken: false, callbackSecret: true, mediaCleanupEnabled: false } });
          export const useJobDiagnostics = view => ({ status: "CanLoadMore",
            loadMore(count) { window.healthLoadMore.push({ view, count }); },
            results: byView[view] ?? [],
            requeue: async () => true });`,
      }));
    });
    try {
      await f.page.getByRole("button", { name: copy(language, "closeDialog"), exact: true }).click();
      await openHeaderMenu(f.page, copy(language, "queueMore"));
      await f.page.getByRole("menuitem", { name: copy(language, "healthTitle"), exact: true }).click();
      const dialog = f.page.getByRole("dialog", { name: copy(language, "healthTitle"), exact: true });
      const table = dialog.getByRole("table", { name: copy(language, "healthCounts") });
      await table.waitFor();

      for (const viewport of [
        { width: 320, height: 568 },
        { width: 360, height: 740 },
        { width: 390, height: 844 },
        { width: 640, height: 800 },
        { width: 768, height: 800 },
        { width: 1280, height: 900 },
      ]) {
        await f.page.setViewportSize(viewport);
        const layout = await dialog.evaluate(el => {
          const tableEl = el.querySelector("table")!;
          const wrap = tableEl.parentElement!;
          const dialogRect = el.getBoundingClientRect();
          const cells = [...tableEl.querySelectorAll("td")];
          const maxCellRight = Math.max(...cells.map(cell => cell.getBoundingClientRect().right));
          return {
            tableDisplay: getComputedStyle(tableEl).display,
            docOverflow: document.documentElement.scrollWidth - window.innerWidth,
            dialogOverflow: el.scrollWidth - el.clientWidth,
            tableOverflow: wrap.scrollWidth - wrap.clientWidth,
            cellsBeyondDialog: maxCellRight - dialogRect.right,
            columnHeaders: tableEl.querySelectorAll('[role="columnheader"]').length,
            rowHeaders: tableEl.querySelectorAll('[role="rowheader"]').length,
            cells: cells.length,
          };
        });
        assert.equal(layout.tableDisplay, viewport.width >= 768 ? "table" : "block");
        assert.ok(layout.docOverflow <= 0, `${language} ${viewport.width}px: document overflow ${layout.docOverflow}`);
        assert.ok(layout.dialogOverflow <= 0, `${language} ${viewport.width}px: dialog overflow ${layout.dialogOverflow}`);
        assert.ok(layout.tableOverflow <= 0, `${language} ${viewport.width}px: table wrapper overflow ${layout.tableOverflow}`);
        assert.ok(layout.cellsBeyondDialog <= 1, `${language} ${viewport.width}px: cell extends past dialog by ${layout.cellsBeyondDialog}`);
        assert.equal(layout.columnHeaders, 6);
        assert.equal(layout.rowHeaders, 4);
        assert.equal(layout.cells, 20);
      }

      // Phone compactness: on a 390x844 phone, the Diagnostics heading and filter stay above the fold.
      await f.page.setViewportSize({ width: 390, height: 844 });
      const failedHeading = dialog.getByRole("heading", { name: copy(language, "healthFailed"), exact: true });
      const trigger = dialog.locator('[data-slot="ticket-filter-trigger"]');
      const headingBox = (await failedHeading.boundingBox())!;
      const triggerBox = (await trigger.boundingBox())!;
      assert.ok(headingBox.y + headingBox.height <= 844, `${language} 390x844: diagnostics heading sits above the fold`);
      assert.ok(triggerBox.y + triggerBox.height <= 844 && triggerBox.height >= 44 && triggerBox.width >= 44, `${language} 390x844: filter button is touch-sized above the fold`);

      // Narrow phone failed card: Requeue stacks below full-width text without crushing metadata/warnings.
      await f.page.setViewportSize({ width: 320, height: 568 });
      const blockedItem = dialog.locator("ul > li").nth(1);
      await blockedItem.scrollIntoViewIfNeeded();
      await blockedItem.getByText(copy(language, "healthPurgeBlocked"), { exact: true }).waitFor();
      await blockedItem.getByText(copy(language, "healthExhausted"), { exact: true }).waitFor();
      const cardMetrics = await blockedItem.evaluate(el => {
        const textBlock = el.firstElementChild!.getBoundingClientRect();
        const button = el.querySelector("button")!.getBoundingClientRect();
        const style = getComputedStyle(el);
        const innerWidth = el.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        return { textWidthRatio: textBlock.width / innerWidth, buttonBelowText: button.top >= textBlock.bottom - 1, buttonHeight: button.height };
      });
      assert.ok(cardMetrics.textWidthRatio >= 0.9, `${language} 320px: job text spans full card width (${cardMetrics.textWidthRatio.toFixed(2)})`);
      assert.equal(cardMetrics.buttonBelowText, true, `${language} 320px: Requeue stacks below text`);
      assert.ok(cardMetrics.buttonHeight >= 44, `${language} 320px: Requeue keeps 44px touch height`);

      // Filter popover fits within 320px and switches to populated Pending and Expired views; paging fires loadMore(25).
      const loadMore = dialog.getByRole("button", { name: copy(language, "loadOlder"), exact: true });
      await loadMore.scrollIntoViewIfNeeded();
      assert.ok((await loadMore.boundingBox())!.height >= 44);
      await loadMore.click();
      await trigger.scrollIntoViewIfNeeded();
      await trigger.click();
      const panel = filterPanel(f.page);
      await panel.waitFor();
      const panelBox = (await panel.boundingBox())!;
      assert.ok(panelBox.x >= 0 && panelBox.x + panelBox.width <= 320.5, `${language} 320px: filter popover fits viewport`);
      await panel.getByRole("radio", { name: copy(language, "healthPending"), exact: true }).click();
      await closeFilters(f.page);
      await dialog.getByText(copy(language, "healthRetry"), { exact: true }).waitFor();
      await trigger.click();
      await panel.getByRole("radio", { name: copy(language, "healthExpired"), exact: true }).click();
      await closeFilters(f.page);
      await dialog.getByRole("heading", { name: copy(language, "healthExpired"), exact: true }).waitFor();
      const loadCalls = await f.page.evaluate(() => (window as unknown as { healthLoadMore: unknown[] }).healthLoadMore);
      assert.deepEqual(loadCalls, [{ view: "failed", count: 25 }]);
      assert.deepEqual(f.errors, []);
      assert.equal(f.uploads(), 0);
    } finally { await f.context.close(); }
  });
}

test("customer sign-in masks a wrong password, then admits the named customer through the real form", async () => {
  const context = await newContext(await browsers.get());
  try {
    await context.addInitScript(() => localStorage.setItem("ease-pos-tracking-language", "en"));
    const page = await context.newPage();
    const search = new URLSearchParams({ project: "POS", q: "007", ticket: seed.tickets[1] });
    await page.goto(`${baseURL}/customer?${search}`);
    await page.waitForURL(url => url.pathname === "/customer/login" && !!url.searchParams.get("redirect"));
    await page.locator("#customer-username").fill("alice");
    await page.locator("#customer-password").fill("wrong customer passphrase");
    await page.getByRole("button", { name: copy("en", "signIn"), exact: true }).click();
    await page.getByRole("alert").waitFor();
    await page.locator("#customer-password").fill(LOCAL_CUSTOMER_PASSWORD);
    await page.getByRole("button", { name: copy("en", "signIn"), exact: true }).click();
    await page.getByRole("button", { name: "New Ticket", exact: true }).first().waitFor();
    await page.getByRole("region", { name: "Ticket from Alice", exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get("project"), "POS");
    assert.equal(new URL(page.url()).searchParams.get("ticket"), seed.tickets[1]);
    assert.equal(await page.getByPlaceholder("Search", { exact: true }).inputValue(), "007");
    await page.goto(`${baseURL}/customer/login?redirect=${encodeURIComponent("/staff?project=POS")}`);
    await page.waitForURL(url => url.pathname === "/customer" && !!url.searchParams.get("project"));
    assert.equal(new URL(page.url()).searchParams.has("redirect"), false);
    assert.equal(await page.locator("#customer-password").count(), 0);
  } finally { await context.close(); }
});

test("staff invitation survives a same-tab Google redirect without entering its return URL", async () => {
  const context = await newContext(await browsers.get());
  const secret = "synthetic-invitation-return-fixture";
  try {
    let observe!: (url: string) => void;
    const started = new Promise<string>(resolve => { observe = resolve; });
    await context.routeWebSocket(url => url.pathname.endsWith("/sync"), socket => {
      const server = socket.connectToServer();
      socket.onMessage(raw => {
        const message = JSON.parse(String(raw));
        if (message.udfPath === "auth:startSignInWithClerk") {
          observe(message.args[0].redirectTo);
          return;
        }
        server.send(raw);
      });
      server.onMessage(raw => socket.send(raw));
    });
    const page = await context.newPage();
    await page.goto(baseURL + "/staff/invite#invite=" + secret);
    const google = page.getByRole("button", { name: /Clerk/ }).first();
    const [returnURL] = await Promise.all([started, google.click()]);
    assert.equal(returnURL, new URL("/staff/invite", baseURL).href);
    await page.goto(returnURL);
    await google.waitFor();
    assert.equal(new URL(page.url()).hash, "");
  } finally { await context.close(); }
});

test("staff sign-in offers Google, and the local test provider admits a seeded Owner", async () => {
  const context = await newContext(await browsers.get());
  try {
    await context.addInitScript(() => localStorage.setItem("ease-pos-tracking-language", "en"));
    const page = await context.newPage();
    const search = new URLSearchParams({ project: "POS", q: "007", ticket: seed.tickets[0] });
    await page.goto(`${baseURL}/staff?${search}`);
    await page.waitForURL(url => url.pathname === "/staff/login" && !!url.searchParams.get("redirect"));
    await page.getByRole("button", { name: copy("en", "continueWithGoogle"), exact: true }).waitFor();
    await page.getByRole("button", { name: "owner@local.test", exact: true }).click();
    await page.getByRole("dialog").getByRole("heading", { name: "Printer needs review", exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get("project"), "POS");
    assert.equal(new URL(page.url()).searchParams.get("ticket"), seed.tickets[0]);
    assert.equal(await page.getByPlaceholder("Search", { exact: true }).inputValue(), "007");
    await page.goto(`${baseURL}/staff/login?redirect=${encodeURIComponent("/customer?project=APP")}`);
    await page.waitForURL(url => url.pathname === "/staff" && !!url.searchParams.get("project"));
    assert.equal(new URL(page.url()).searchParams.has("redirect"), false);
    assert.equal(await page.getByRole("button", { name: copy("en", "continueWithGoogle"), exact: true }).count(), 0);
  } finally { await context.close(); }
});

test("staff filter badge counts URL scopes and clears them together while preserving search", async () => {
  const { page, context } = await open("staff");
  try {
    await page.goto(`${baseURL}/staff?project=POS&view=queue&filter=new&assignment=mine&q=Printer`);
    const trigger = filterTrigger(page);
    await page.getByRole("button", { name: "Filters, 2 applied", exact: true }).waitFor();
    assert.equal(await trigger.innerText(), "2");
    await openFilters(page);
    await filterPanel(page).getByRole("button", { name: "Clear filters", exact: true }).click();
    await page.waitForURL(url => !url.searchParams.has("assignment") && !url.searchParams.has("filter") && url.searchParams.get("q") === "Printer");
    await closeFilters(page);
    assert.equal(await trigger.getAttribute("aria-label"), "Filters");
    assert.equal(await page.getByPlaceholder("Search", { exact: true }).inputValue(), "Printer");
    await page.goBack();
    await page.getByRole("button", { name: "Filters, 2 applied", exact: true }).waitFor();
    const restored = new URL(page.url()).searchParams;
    assert.equal(restored.get("q"), "Printer");
    assert.equal(restored.get("assignment"), "mine");
    assert.equal(restored.get("filter"), "new");
  } finally { await context.close(); }
});

test("staff restores each Project’s view and returns to the Ticket trigger", async () => {
  const { page, context } = await open("staff");
  const views = page.getByRole("group", { name: "Ticket view" });
  try {
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    assert.equal(await views.getByRole("button", { name: "Board", exact: true }).getAttribute("aria-pressed"), "true");
    const statusFilter = page.getByRole("combobox", { name: copy("en", "ticketStatus"), exact: true });
    const expectStatus = async (value: string) => {
      await openFilters(page);
      assert.equal(await statusFilter.inputValue(), value);
      await closeFilters(page);
    };
    await expectStatus("all");
    await views.getByRole("button", { name: "Queue", exact: true }).click();
    await expectStatus("active");
    await views.getByRole("button", { name: "Board", exact: true }).click();
    await expectStatus("all");
    await page.waitForFunction(() => document.querySelectorAll('[data-slot="kanban-column"]').length === 5);
    const destinations = page.getByRole("navigation", { name: copy("en", "project"), exact: true });
    await destinations.getByRole("button", { name: "Archive", exact: true }).click();
    await destinations.getByRole("button", { name: "Tickets", exact: true }).click();
    await expectStatus("all");
    await page.waitForFunction(() => document.querySelectorAll('[data-slot="kanban-column"]').length === 5);
    await openFilters(page);
    await statusFilter.selectOption("active");
    await closeFilters(page);
    await views.getByRole("button", { name: "Table", exact: true }).click();
    await expectStatus("active");
    await openFilters(page);
    await filterPanel(page).getByRole("button", { name: "High or critical", exact: true }).click();
    await closeFilters(page);
    await page.getByRole("button", { name: "Filters, 1 applied", exact: true }).waitFor();
    await chooseProject(page, "APP");
    assert.equal(await views.getByRole("button", { name: "Board", exact: true }).getAttribute("aria-pressed"), "true");
    await views.getByRole("button", { name: "Board", exact: true }).click();
    await chooseProject(page, "POS");
    await page.getByRole("button", { name: "Filters", exact: true }).waitFor();
    assert.equal(await views.getByRole("button", { name: "Table", exact: true }).getAttribute("aria-pressed"), "true");
    const row = page.locator("button[data-ticket-id]:visible").first();
    const id = await row.getAttribute("data-ticket-id");
    await row.click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: copy("en", "queueFocus"), exact: true }).click();
    assert.equal(new URL(page.url()).searchParams.get("view"), "focus");
    assert.equal(await dialog.evaluate(el => Math.round(el.getBoundingClientRect().width)), await page.evaluate(() => document.documentElement.clientWidth));
    await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
    await page.waitForFunction(id => document.activeElement?.getAttribute("data-ticket-id") === id, id);
    assert.equal(await views.getByRole("button", { name: "Table", exact: true }).getAttribute("aria-pressed"), "true");
    await openFilters(page);
    await filterPanel(page).getByRole("button", { name: "High or critical", exact: true }).click();
    await closeFilters(page);
    await page.getByRole("button", { name: "Filters, 1 applied", exact: true }).waitFor();
    await chooseProject(page, "APP");
    assert.equal(await views.getByRole("button", { name: "Board", exact: true }).getAttribute("aria-pressed"), "true");
  } finally { await context.close(); }
});

test("an open Ticket announces leaving filtered results in Queue, Board and Table", async () => {
  const { page, context, token, errors } = await open("staff");
  try {
    await page.getByRole("button", { name: copy("en", "closeDialog"), exact: true }).click();
    await openFilters(page);
    await page.getByRole("combobox", { name: copy("en", "ticketStatus"), exact: true }).selectOption("new");
    await closeFilters(page);
    for (const view of ["Queue", "Board", "Table"]) {
      const title = `Result change ${view} ${crypto.randomUUID()}`;
      const { ticket } = await convex.mutation(api.tickets.createTextTicket, {
        token, projectKey: "POS", title, description: "", requestId: crypto.randomUUID(),
      });
      await page.getByPlaceholder(copy("en", "search"), { exact: true }).fill(title);
      await page.getByRole("group", { name: "Ticket view" }).getByRole("button", { name: view }).click();
      await page.locator(`button[data-ticket-id="${ticket._id}"]:visible`).click();
      const detail = view === "Queue" ? page.getByRole("region", { name: title, exact: true }) : page.getByRole("dialog");
      await detail.getByRole("button", { name: new RegExp(`^${copy("en", "queueAcknowledge")} ·`) }).click();
      await detail.getByRole("status").filter({ hasText: copy("en", "detailLeftResults") }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get("ticket"), ticket._id);
      await detail.getByRole("button", { name: copy("en", view === "Queue" ? "detailBack" : "closeDialog"), exact: true }).click();
      await detail.waitFor({ state: "hidden" });
    }
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

for (const [language, view] of [["en", "queue"], ["th", "table"]] as const) test(`staff ${language} ${view}: status menu and move button keep keyboard focus while the move saves`, async () => {
  const intercepted = new EventEmitter();
  let release: (() => void) | undefined;
  let writes = 0;
  const { page, context, token, errors } = await open("staff", language, async context => {
    await context.routeWebSocket(url => url.hostname === "127.0.0.1" && url.pathname.endsWith("/sync"), socket => {
      const server = socket.connectToServer();
      socket.onMessage(raw => {
        const message = JSON.parse(String(raw));
        if (message.type === "Mutation" && message.udfPath === "tickets:updateTicketStatus") {
          writes++;
          release = () => { release = undefined; server.send(raw); };
          intercepted.emit("move");
        } else server.send(raw);
      });
    });
  });
  try {
    const title = `Status focus ${language} ${crypto.randomUUID()}`;
    const { ticket } = await convex.mutation(api.tickets.createTextTicket, { token, projectKey: "POS", title, description: "", requestId: crypto.randomUUID() });
    const number = formatTicketNumber(ticket.ticketNumber, "POS");
    if (view === "table") await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseURL}/staff?project=POS&view=${view}&ticket=${ticket._id}`);
    const detail = view === "queue"
      ? page.getByRole("region", { name: title, exact: true })
      : page.getByRole("dialog", { name: number, exact: true });
    const status = detail.locator('[data-slot="dropdown-menu-trigger"]');
    const label = (key: "new" | "inProgress" | "done") => `${copy(language, "detailStatus")} · ${copy(language, key)} · ${number}`;
    const focused = (control: Locator) => control.evaluate(element => element === document.activeElement);
    const saving = detail.getByRole("status").filter({ hasText: copy(language, "statusWriting") });

    assert.equal(await status.getAttribute("aria-label"), label("new"));
    await status.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("menuitemradio", { name: copy(language, "inProgress"), exact: true }).focus();
    await Promise.all([once(intercepted, "move", { signal: AbortSignal.timeout(5000) }), page.keyboard.press("Enter")]);
    await page.getByRole("menu").waitFor({ state: "detached" });
    await saving.waitFor();
    assert.equal(await status.getAttribute("aria-disabled"), "true");
    assert.equal(await focused(status), true, "Focus stays on the status trigger during the save");
    await page.keyboard.press("Enter");
    assert.equal(await page.getByRole("menu").count(), 0, "A busy trigger does not open");
    assert.ok(release);
    release();
    await saving.waitFor({ state: "detached" });
    await detail.getByRole("button", { name: label("inProgress"), exact: true }).waitFor();
    assert.equal(await status.getAttribute("aria-disabled"), null);
    assert.equal(await focused(status), true, "Focus stays on the status trigger after the save");

    const resolve = detail.getByRole("button", { name: `${copy(language, "queueResolve")} · ${number}`, exact: true });
    await resolve.focus();
    await Promise.all([once(intercepted, "move", { signal: AbortSignal.timeout(5000) }), page.keyboard.press("Enter")]);
    await saving.waitFor();
    assert.equal(await resolve.getAttribute("aria-disabled"), "true");
    assert.equal(await focused(resolve), true, "Focus stays on the move button during the save");
    await page.keyboard.press("Enter");
    assert.ok(release);
    release();
    await detail.getByRole("button", { name: label("done"), exact: true }).waitFor();
    await saving.waitFor({ state: "detached" });
    assert.equal(await focused(detail.getByRole("button", { name: `${copy(language, "queueReopen")} · ${number}`, exact: true })), true, "Focus stays on the move button after the save");
    assert.equal(writes, 2, "Busy controls never send a second move");
    assert.equal((await convex.query(api.tickets.getWorkspaceTicket, { token, projectId: ticket.projectId, ticket: ticket._id }))?.status, "done");
    assert.deepEqual(errors, []);
  } finally { release?.(); await context.close(); }
});

test("a status check finishing in another Project is shown once on return", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let writes = 0;
  const { page, context, token } = await open("staff", "en", async context => {
    await context.routeWebSocket(url => url.hostname === "127.0.0.1" && url.pathname.endsWith("/sync"), socket => {
      const server = socket.connectToServer();
      socket.onMessage(raw => {
        const message = JSON.parse(String(raw));
        if (message.type === "Mutation" && message.udfPath === "tickets:updateTicketStatus") {
          // Force the real local backend's version check, then hold the reconciliation read.
          writes++;
          message.args[0].expectedVersion += 1;
          server.send(JSON.stringify(message));
        } else server.send(raw);
      });
    });
    await context.route("**/api/query", async route => {
      if (route.request().postDataJSON()?.path === "tickets:getWorkspaceTicket") await held;
      await route.continue();
    });
  });
  try {
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    const title = `Deferred status ${crypto.randomUUID()}`;
    const { ticket } = await convex.mutation(api.tickets.createTextTicket, { token, projectKey: "POS", title, description: "", requestId: crypto.randomUUID() });
    const number = formatTicketNumber(ticket.ticketNumber, "POS");
    await page.getByPlaceholder(copy("en", "search"), { exact: true }).fill(title);
    await Promise.all([
      page.waitForRequest(req => req.url().endsWith("/api/query") && req.postDataJSON()?.path === "tickets:getWorkspaceTicket"),
      page.getByRole("button", { name: `Acknowledge · ${number}`, exact: true }).click(),
    ]);
    await chooseProject(page, "APP");
    const finished = page.waitForEvent("requestfinished", req => req.url().endsWith("/api/query"));
    release();
    await finished;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const notice = page.getByText(`${number} · Latest saved version · New`, { exact: true });
    assert.equal(await notice.count(), 0);
    await chooseProject(page, "POS");
    await notice.waitFor();
    await chooseProject(page, "APP");
    await notice.waitFor({ state: "hidden" });
    await chooseProject(page, "POS");
    assert.equal(await notice.count(), 0);
    assert.equal(writes, 1);
  } finally { release(); await context.close(); }
});

test("staff explorer keeps table and filters across indexed search, tag assignment and archive restore", async () => {
  const f = await open("staff");
  const name = `Explorer ${crypto.randomUUID()}`;
  const created = await convex.mutation(api.tickets.createTextTicket, {
    token: f.token, projectKey: "POS", title: name, description: "Integration fixture", requestId: crypto.randomUUID(),
  });
  const id = created.ticket._id;
  const tagName = `Tag ${crypto.randomUUID().slice(0, 8)}`;
  try {
    await f.page.getByRole("button", { name: "Close dialog", exact: true }).click();
    const search = f.page.getByPlaceholder(copy("en", "search"), { exact: true });
    await search.fill(name);
    await f.page.getByRole("group", { name: "Ticket view" }).getByRole("button", { name: "Table", exact: true }).click();
    await f.page.getByRole("button", { name: new RegExp(`Open Ticket .*${name}`) }).click();
    const dialog = f.page.getByRole("dialog").last();
    await dialog.getByRole("button", { name: copy("en", "detailActions"), exact: true }).click();
    await dialog.getByRole("button", { name: copy("en", "ticketTags"), exact: true }).click();
    await dialog.getByLabel(copy("en", "tagName"), { exact: true }).fill(tagName);
    await dialog.getByRole("button", { name: copy("en", "createTag"), exact: true }).click();
    const tag = dialog.getByRole("button", { name: `+ ${tagName}`, exact: true });
    await tag.click();
    await dialog.getByRole("button", { name: `✓ ${tagName}`, exact: true }).waitFor();
    const assigned = await convex.query(api.tickets.getTicket, { token: f.token, id });
    assert.deepEqual(assigned?.tags.map(t => t.name), [tagName]);
    await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
    await openFilters(f.page);
    await f.page.getByRole("button", { name: "Add filter", exact: true }).click();
    await f.page.getByRole("option", { name: "Tags", exact: true }).click();
    await f.page.getByRole("option", { name: "is any of", exact: true }).click();
    await f.page.getByRole("option", { name: tagName, exact: true }).click();
    await f.page.keyboard.press("Escape");
    await closeFilters(f.page);
    await search.fill("unmatchedfixturetext");
    await f.page.waitForURL(url => url.searchParams.get("q") === "unmatchedfixturetext");
    await f.page.getByText("No Tickets match these filters.", { exact: true }).waitFor();
    const clear = f.page.getByRole("button", { name: copy("en", "clearSearch"), exact: true });
    await clear.click();
    await f.page.waitForURL(url => !url.searchParams.has("q"));
    assert.equal(await search.inputValue(), "");
    assert.equal(await search.evaluate(input => input === document.activeElement), true);
    await f.page.getByRole("button", { name: new RegExp(`Open Ticket .*${name}`) }).waitFor();
    assert.equal(await f.page.getByRole("group", { name: "Ticket view" }).getByRole("button", { name: "Table", exact: true }).getAttribute("aria-pressed"), "true");
    await search.fill(name);
    const row = f.page.getByRole("button", { name: new RegExp(`Open Ticket .*${name}`) });
    await row.click();
    await dialog.getByRole("button", { name: copy("en", "detailActions"), exact: true }).click();
    // Staff archive goes through the real confirmation. Cancel and Escape both
    // dismiss it without a write; focus returns to the Archive trigger.
    const archiveTrigger = dialog.getByRole("button", { name: copy("en", "archive"), exact: true });
    const confirm = f.page.getByRole("alertdialog", { name: copy("en", "archive"), exact: true });
    await archiveTrigger.click();
    await confirm.getByText(copy("en", "archiveConfirm"), { exact: true }).waitFor();
    await confirm.getByRole("button", { name: copy("en", "cancel"), exact: true }).click();
    await confirm.waitFor({ state: "hidden" });
    await archiveTrigger.focus();
    await f.page.keyboard.press("Enter");
    await confirm.waitFor();
    await f.page.keyboard.press("Escape");
    await confirm.waitFor({ state: "hidden" });
    await f.page.waitForFunction(trigger => trigger === document.activeElement, await archiveTrigger.elementHandle());
    const dismissed = await convex.query(api.tickets.getTicket, { token: f.token, id });
    assert.equal(dismissed?.lifecycle, "active");
    assert.equal(dismissed?.version, assigned?.version, "Dismissing the confirmation must not write");
    await archiveTrigger.click();
    await confirm.getByRole("button", { name: copy("en", "archive"), exact: true }).click();
    await confirm.waitFor({ state: "hidden" });
    await dialog.waitFor({ state: "hidden" });
    await row.waitFor({ state: "hidden" });
    const archivedTicket = await convex.query(api.tickets.getTicket, { token: f.token, id });
    assert.equal(archivedTicket?.lifecycle, "archived");
    assert.ok(archivedTicket?.archivedAt);
    assert.deepEqual(archivedTicket?.tagIds, assigned?.tagIds);
    await f.page.getByRole("button", { name: copy("en", "archive"), exact: true }).click();
    await f.page.getByRole("button", { name: new RegExp(`Open Ticket .*${name}`) }).click();
    const archived = f.page.getByRole("dialog").last();
    assert.equal(await archived.getByRole("button", { name: copy("en", "edit"), exact: true }).count(), 0);
    await archived.getByRole("button", { name: "Restore", exact: true }).click();
    await archived.waitFor({ state: "hidden" });
    const restored = await convex.query(api.tickets.getTicket, { token: f.token, id });
    assert.equal(restored?.lifecycle, "active");
    assert.deepEqual(restored?.tagIds, assigned?.tagIds);
    assert.deepEqual(f.errors, []);
    assert.equal(f.uploads(), 0);
  } finally { await f.context.close(); }
});

for (const language of ["en", "th"] as const) test(`keyboard pin placement and adjustment (${language})`, async () => {
  const { page, context, uploads } = await open("customer", language);
  try {
    const video = language === "th";
    if (video) await page.locator('[data-slot="ticket-draft-files"]').setInputFiles("tests/browser/pin-video.webm");
    else {
      await files(page);
      await files(page, "second.png");
      const handle = page.getByRole("button", { name: copy(language, "reorderFile", { name: "draft.png" }), exact: true });
      await handle.press("Enter");
      const positions = page.getByRole("group", { name: copy(language, "filePosition", { name: "draft.png" }), exact: true });
      await positions.getByRole("button", { name: "2", exact: true }).press("Enter");
      await page.waitForFunction(() => document.querySelector('[data-slot="sortable-item"] img')?.getAttribute("alt") === "second.png");
    }
    await page.getByRole("button", { name: copy(language, "openMedia", { name: video ? "pin-video.webm" : "draft.png" }), exact: true }).press("Enter");
    const dialog = page.getByRole("dialog").last();
    await dialog.getByRole("button", { name: copy(language, "addPin"), exact: true }).press("Enter");
    const surface = dialog.getByRole("button", { name: copy(language, "markPoint"), exact: true });
    if (video) {
      const scrubber = dialog.getByRole("slider");
      await scrubber.press("End");
      await surface.focus();
    }
    await surface.press("Shift+ArrowRight");
    await surface.press("ArrowUp");
    await dialog.getByText(copy(language, "pinPosition", { x: 60, y: 49 }), { exact: true }).waitFor();
    await surface.press("Enter");
    await dialog.getByPlaceholder(copy(language, "describeIssue")).fill("Keyboard placement");
    await dialog.getByRole("button", { name: copy(language, "savePin"), exact: true }).press("Enter");
    const marker = dialog.getByRole("button", { name: `${copy(language, "comment", { label: 1 })}: Keyboard placement`, exact: true });
    await marker.press("Enter");
    await dialog.getByRole("button", { name: copy(language, "repositionPin"), exact: true }).press("Enter");
    await surface.press("ArrowLeft");
    await surface.press("Space");
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-pin-id]")?.style.left === "59%");
    assert.equal(uploads(), 0);
  } finally { await context.close(); }
});

for (const role of ["staff", "customer"] as const) for (const language of ["en", "th"] as const) {
  test(`${role} ${language}: phone surfaces fit 320 and 390 pixels and three Tickets take three activations`, async () => {
    const { page, context, errors } = await open(role, language);
    const queueHeading = page.getByRole("heading", { level: 1, name: copy(language, role === "staff" ? "queueTitle" : "yourTickets"), exact: true });

    async function checkWidths(surface: ReturnType<Page["locator"]>) {
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 740 });
        await surface.waitFor({ state: "visible" });
        const dimensions = await surface.evaluate(element => ({
          page: document.documentElement.scrollWidth,
          viewport: document.documentElement.clientWidth,
          surface: element.scrollWidth,
          inner: element.clientWidth,
        }));
        assert.ok(dimensions.page <= dimensions.viewport + 1, `Page overflow at ${width}px: ${JSON.stringify(dimensions)}`);
        assert.ok(dimensions.surface <= dimensions.inner + 1, `Surface overflow at ${width}px: ${JSON.stringify(dimensions)}`);
      }
    }

    try {
      await checkWidths(page.getByRole("dialog"));
      assert.equal(await queueHeading.count(), 0, "Modal keeps the queue outside the accessibility tree");
      await page.getByRole("button", { name: copy(language, "closeDialog"), exact: true }).click();
      if (role === "staff") await page.getByRole("button", { name: copy(language, "queueLabel"), exact: true }).click();
      await queueHeading.waitFor();
      await checkWidths(page.getByRole("main"));

      await openHeaderMenu(page, copy(language, role === "staff" ? "queueMore" : "customerQueueMore"));
      const signOut = page.getByRole("menuitem", { name: copy(language, "signOut"), exact: true });
      await signOut.waitFor();
      // A trusted press outside the menu dismisses it (Base UI ignores synthetic events).
      // Menus keep an 8 px viewport inset, so x = 4 is always outside the popup.
      const heading = (await queueHeading.boundingBox())!;
      await page.mouse.click(4, heading.y + heading.height / 2);
      await signOut.waitFor({ state: "hidden" });
      assert.equal(await page.getByRole("menu").count(), 0);

      if (role === "staff") {
        const acknowledge = page.getByRole("button", { name: new RegExp(`^${copy(language, "queueAcknowledge")} ·`) }).first();
        await acknowledge.waitFor();
        const id = await acknowledge.locator("xpath=ancestor::article").locator("[data-ticket-id]").getAttribute("data-ticket-id");
        await acknowledge.click();
        const sameRow = page.locator("article").filter({ has: page.locator(`button[data-ticket-id="${id}"]`) });
        await sameRow.getByRole("button", { name: new RegExp(`^${copy(language, "queueStart")} ·`) }).waitFor();
        assert.equal(new URL(page.url()).searchParams.has("ticket"), false, "A single queue action advanced the Ticket in place");
      }

      const rows = page.locator("button[data-ticket-id]:visible");
      await rows.nth(2).waitFor();
      const ids = await rows.evaluateAll(buttons => buttons.slice(0, 3).map(button => button.getAttribute("data-ticket-id")));
      assert.equal(new Set(ids).size, 3);
      await rows.first().click();
      for (let index = 0; index < ids.length; index++) {
        if (index) await page.getByRole("button", { name: copy(language, "detailNext"), exact: true }).click();
        await page.waitForURL(url => url.searchParams.get("ticket") === ids[index]);
        const detail = page.locator("section[tabindex='-1'][aria-labelledby]");
        await detail.getByRole("heading", { level: 2 }).waitFor();
        await checkWidths(detail);
        assert.equal(await rows.count(), 0, "Only the selected Ticket is visible");
        assert.equal(await queueHeading.count(), 0);
      }
      await page.getByRole("button", { name: copy(language, "detailBack"), exact: true }).click();
      await queueHeading.waitFor();
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test("a customer joins from an invitation link, saves a recovery code, then recovers the account with it", async () => {
  const projectId = seed.projects.find(project => project.key === "POS")!.id;
  const invitation = await convex.mutation(api.identity.createCustomerInvitation, { eligibilityConfirmed: true, token: seed.sessions[0], projectId });
  redact(invitation.secret);
  const username = `joiner${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const context = await newContext(await browsers.get());
  let code = "";
  try {
    await context.addInitScript(() => localStorage.setItem("ease-pos-tracking-language", "en"));
    const page = await context.newPage();
    await page.goto(`${baseURL}/customer/join#invite=${encodeURIComponent(invitation.secret)}`);
    await page.getByText(copy("en", "joinTitle", { project: "Point of Sale" }), { exact: true }).waitFor();
    const notice = page.getByRole("link", { name: copy("en", "pilotPrivacyNotice"), exact: true });
    assert.equal(await notice.getAttribute("href"), "https://privacy.example.test/en");
    assert.equal(await notice.getAttribute("referrerpolicy"), "no-referrer");
    await page.locator("#join-username").fill(` ${username.toUpperCase()} `);
    await page.getByText(copy("en", "usernamePreview", { username }), { exact: true }).waitFor();
    await page.locator("#join-display-name").fill("สมหญิง ใจดี");
    await page.locator("#new-password").fill("browser join passphrase");
    await page.locator("#new-password-confirm").fill("browser join passphrase");
    await page.getByRole("button", { name: copy("en", "createAccount"), exact: true }).click();
    const enrollment = page.getByRole("heading", { name: copy("en", "recoveryEnrollmentTitle"), exact: true });
    await enrollment.waitFor();
    assert.equal(await enrollment.evaluate(element => element === document.activeElement), true);
    await page.getByText(copy("en", "recoveryCodeNeeded"), { exact: true }).waitFor();
    await page.getByRole("button", { name: copy("en", "recoveryCodeCreate"), exact: true }).press("Enter");
    code = (await page.locator("output").innerText()).trim();
    redact(code);
    assert.match(code, /^[0-9A-Z]{5}(-[0-9A-Z]{1,5}){5}$/);
    assert.equal(await page.getByRole("button", { name: "New Ticket", exact: true }).count(), 0);
    await page.getByRole("button", { name: copy("en", "recoveryCodeSaved"), exact: true }).press("Enter");
    await page.getByRole("button", { name: "New Ticket", exact: true }).first().waitFor();
    await openHeaderMenu(page, copy("en", "customerQueueMore"));
    await page.getByRole("menuitem", { name: copy("en", "accountTitle"), exact: true }).click();
    const account = page.getByRole("dialog", { name: copy("en", "accountTitle"), exact: true });
    assert.equal(await account.getByRole("link", { name: copy("en", "pilotPrivacyNotice") }).getAttribute("href"), "https://privacy.example.test/en");
    // The invitation is single use.
    assert.deepEqual(await convex.query(api.identity.previewCustomerInvitation, { invitation: invitation.secret }), { status: "INVITE_USED" });
  } finally { await context.close(); }
  const fresh = await newContext(await browsers.get());
  try {
    await fresh.addInitScript(() => localStorage.setItem("ease-pos-tracking-language", "en"));
    const page = await fresh.newPage();
    await page.goto(`${baseURL}/customer/recover`);
    await page.locator("#recover-username").fill(username);
    await page.locator("#recover-code").fill("0".repeat(26));
    await page.locator("#new-password").fill("recovered browser passphrase");
    await page.locator("#new-password-confirm").fill("recovered browser passphrase");
    await page.getByRole("button", { name: copy("en", "recoverAction"), exact: true }).click();
    await page.getByRole("alert").getByText(copy("en", "recoverFailed"), { exact: true }).waitFor();
    await page.locator("#recover-code").fill(code.toLowerCase());
    await page.getByRole("button", { name: copy("en", "recoverAction"), exact: true }).click();
    await page.getByText(copy("en", "recoverSuccess"), { exact: true }).waitFor();
    await page.goto(`${baseURL}/customer/login`);
    await page.locator("#customer-username").fill(username);
    await page.locator("#customer-password").fill("recovered browser passphrase");
    await page.getByRole("button", { name: copy("en", "signIn"), exact: true }).click();
    await page.getByText(copy("en", "recoveryCodeNeeded"), { exact: true }).waitFor();
    await page.getByRole("button", { name: copy("en", "recoveryCodeCreate"), exact: true }).press("Enter");
    redact((await page.locator("output").innerText()).trim());
    await page.getByRole("button", { name: copy("en", "recoveryCodeSaved"), exact: true }).press("Enter");
    await page.getByRole("button", { name: "New Ticket", exact: true }).first().waitFor();
  } finally { await fresh.close(); }
});

test("Thai keyboard customer recovery returns to sign-in and resumes Join with the invitation held only in memory", async () => {
  const owner = seed.sessions[0];
  const [pos, app] = ["POS", "APP"].map(key => seed.projects.find(project => project.key === key)!.id);
  const createInvitation = (projectId: Id<"projects">) =>
    convex.mutation(api.identity.createCustomerInvitation, { eligibilityConfirmed: true, token: owner, projectId });
  const username = `returning${crypto.randomUUID().slice(0, 8)}`;
  const password = "browser returning passphrase";
  const newPassword = "รหัสผ่านใหม่สำหรับลูกค้าประจำ";
  const first = await createInvitation(pos);
  redact(first.secret);
  const signup = await convex.mutation(api.auth.signUpWithInvitation, { invitation: first.secret, username, displayName: "ลูกค้าประจำ", password });
  assert.equal(signup.status, "complete");
  if (signup.status !== "complete") throw new Error("Customer fixture enrollment failed");
  const token = signup.tokens.accessToken;
  redact(token);
  const saved = await convex.mutation(api.identity.createRecoveryCode, { token });
  if (!saved.ok) throw new Error("Customer fixture recovery setup failed");
  redact(saved.code);
  assert.deepEqual(await convex.mutation(api.identity.confirmRecoveryEnrollment, { token, code: saved.code }), { ok: true });
  const invitation = await createInvitation(app);
  redact(invitation.secret);

  const context = await newContext(await browsers.get(), { locale: "th-TH", viewport: { width: 390, height: 844 } });
  try {
    await context.addInitScript(() => localStorage.setItem("ease-pos-tracking-language", "th"));
    const page = await context.newPage();
    const requestLocations: string[] = [];
    const documentRequests: string[] = [];
    page.on("request", request => {
      requestLocations.push(request.url(), request.headers().referer ?? "");
      if (request.resourceType() === "document") documentRequests.push(request.url());
    });
    const checkInMemoryOnly = async () => {
      assert.equal(requestLocations.some(value => value.includes(invitation.secret)), false);
      assert.equal(await page.evaluate(secret => [history.state, location.href, ...Object.values(localStorage), ...Object.values(sessionStorage)]
        .some(value => JSON.stringify(value)?.includes(secret)), invitation.secret), false);
    };
    await page.goto(`${baseURL}/customer/join#invite=${invitation.secret}`);
    await page.getByRole("heading", { name: copy("th", "joinTitle", { project: "Customer App" }) }).waitFor();
    const joinPath = `${baseURL}/customer/join`;
    await page.waitForURL(joinPath);
    const useExisting = page.getByRole("button", { name: copy("th", "haveAccountQuestion"), exact: true });
    await useExisting.press("Enter");
    await page.waitForURL(`${baseURL}/customer/login`);
    await page.getByRole("button", { name: copy("th", "backToInvitation"), exact: true }).press("Enter");
    await page.waitForURL(joinPath);
    await useExisting.press("Enter");
    const userField = page.getByRole("textbox", { name: copy("th", "username"), exact: true });
    await userField.waitFor();
    assert.equal(await userField.evaluate(element => element === document.activeElement), true);
    await page.keyboard.insertText(username);
    await page.keyboard.press("Tab");
    await page.keyboard.insertText("ใส่รหัสผ่านผิด");
    await page.keyboard.press("Enter");
    const error = page.getByRole("alert").filter({ hasText: copy("th", "invalidCredentials") });
    await error.waitFor();
    assert.equal(await error.evaluate(element => element === document.activeElement), true);
    const forgot = page.getByRole("link", { name: copy("th", "forgotPassword"), exact: true });
    await forgot.press("Enter");
    await page.waitForURL(`${baseURL}/customer/recover`);
    await checkInMemoryOnly();
    await page.getByRole("link", { name: copy("th", "customerSignIn"), exact: true }).press("Enter");
    await page.getByRole("button", { name: copy("th", "backToInvitation"), exact: true }).waitFor();
    await forgot.press("Enter");
    const recoverUsername = page.locator("#recover-username");
    await recoverUsername.waitFor();
    assert.equal(await recoverUsername.evaluate(element => element === document.activeElement), true);
    await page.keyboard.insertText(` ${username.toUpperCase()} `);
    await page.keyboard.press("Tab");
    await page.keyboard.insertText(saved.code.toLowerCase());
    await page.keyboard.press("Tab");
    await page.keyboard.insertText(newPassword);
    await page.keyboard.press("Tab"); // Show password
    await page.keyboard.press("Tab");
    await page.keyboard.insertText(newPassword);
    await page.keyboard.press("Enter");
    const recovered = page.getByRole("status").filter({ hasText: copy("th", "recoverSuccess") });
    await recovered.waitFor();
    assert.equal(await recovered.evaluate(element => element === document.activeElement), true);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await page.waitForURL(`${baseURL}/customer/login`);
    await page.getByRole("button", { name: copy("th", "backToInvitation"), exact: true }).waitFor();
    await checkInMemoryOnly();
    assert.equal(await userField.evaluate(element => element === document.activeElement), true);
    await page.keyboard.insertText(username);
    await page.keyboard.press("Tab");
    await page.keyboard.insertText(newPassword);
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: copy("th", "recoveryCodeCreate"), exact: true }).press("Enter");
    redact((await page.locator("output").innerText()).trim());
    await page.getByRole("button", { name: copy("th", "recoveryCodeSaved"), exact: true }).press("Enter");
    await page.waitForURL(joinPath);
    await page.getByText(copy("th", "joinAsCustomer", { project: "Customer App", username }), { exact: true }).waitFor();
    const join = page.getByRole("button", { name: copy("th", "joinAction"), exact: true });
    assert.equal(await join.evaluate(element => element === document.activeElement), true);
    await page.keyboard.press("Enter");
    // Joining opens the joined Project.
    await page.waitForURL(`${baseURL}/customer?project=APP`);
    assert.deepEqual(await convex.query(api.identity.previewCustomerInvitation, { invitation: invitation.secret }), { status: "INVITE_USED" });
    await checkInMemoryOnly();
    assert.deepEqual(documentRequests, [joinPath]);
  } finally { await context.close(); }
});

test("Owner verifies staff invitation creation and reissue, then replaces and revokes an exact Google account", async () => {
  const admin = localIdentityAdmin();
  const fixture = await admin(internal.seed.installBrowserStaffAccounts, {});
  const owner = await convex.mutation(api.auth.signInLocalFixture, { email: fixture.ownerEmail });
  const former = await convex.mutation(api.auth.signInLocalFixture, { email: fixture.memberEmail });
  if (owner.status !== "complete" || former.status !== "complete") throw new Error("Staff fixtures failed to sign in");
  for (const tokens of [owner.tokens, former.tokens, fixture.candidate]) {
    redact(tokens.accessToken);
    redact(tokens.refreshToken);
  }
  const browser = await browsers.get();
  const keys = authStorageKeys();
  async function openSession(tokens: { accessToken: string; refreshToken: string }, path: string) {
    const context = await newContext(browser);
    await context.addInitScript(({ keys: { jwt, refresh }, accessToken, refreshToken }) => {
      sessionStorage.setItem(jwt, accessToken);
      sessionStorage.setItem(refresh, refreshToken);
      localStorage.setItem("ease-pos-tracking-language", "en");
    }, { keys, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
    const page = await context.newPage();
    await page.goto(baseURL + path);
    return { context, page };
  }
  const candidate = await openSession(fixture.candidate, "/staff/login");
  const authority = await openSession(owner.tokens, "/staff");
  try {
    await candidate.page.getByRole("heading", { name: copy("en", "pendingTitle"), exact: true }).waitFor();
    await candidate.page.getByText(fixture.candidate.subject, { exact: true }).waitFor();
    await candidate.page.getByText(fixture.candidate.email, { exact: true }).waitFor();
    assert.equal(candidate.page.url().includes(fixture.candidate.subject), false);
    const { page } = authority;
    await openHeaderMenu(page, copy("en", "queueMore"), "Enter");
    await page.getByRole("menuitem", { name: copy("en", "teamTitle"), exact: true }).press("Enter");
    const team = page.getByRole("dialog", { name: copy("en", "teamTitle"), exact: true });
    const codeField = team.getByRole("textbox", { name: copy("en", "verificationCode"), exact: true });
    async function confirm(purpose: string, testError = false) {
      await codeField.and(page.locator(":focus")).waitFor();
      const delivery = await admin(internal.identity.readLocalDelivery, { to: fixture.ownerEmail });
      if (!delivery) throw new Error("Local verification delivery missing");
      assert.equal(delivery.purpose, purpose);
      redact(delivery.code);
      if (testError) {
        await codeField.fill(delivery.code === "00000000" ? "11111111" : "00000000");
        await codeField.press("Enter");
        const error = team.getByRole("alert").filter({ hasText: copy("en", "invalidCode") });
        await error.waitFor();
        assert.equal(await error.evaluate(element => element === document.activeElement), true);
      }
      await codeField.fill(delivery.code);
      await codeField.press("Enter");
      await codeField.waitFor({ state: "hidden" });
      assert.equal(page.url().includes(delivery.code), false);
    }

    const inviteEmail = `invite-${crypto.randomUUID()}@local.test`;
    await team.getByRole("textbox", { name: copy("en", "inviteEmail"), exact: true }).fill(inviteEmail);
    await team.locator("#invite-staff-role").selectOption("owner");
    await team.getByRole("button", { name: copy("en", "inviteStaff"), exact: true }).press("Enter");
    await team.getByRole("heading", { name: copy("en", "teamActionReview", { action: copy("en", "inviteStaff"), email: inviteEmail, role: "Owner" }) }).waitFor();
    await confirm("staff-invite-create", true);
    const link = team.locator("output");
    const originalLink = await link.innerText();
    redact(originalLink);
    await team.getByRole("listitem").filter({ hasText: inviteEmail }).getByRole("button", { name: copy("en", "reissue"), exact: true }).press("Enter");
    await confirm("staff-invite-reissue");
    const reissuedLink = await link.innerText();
    redact(reissuedLink);
    assert.ok(reissuedLink !== originalLink);

    const googleButton = (email: string) => team.getByRole("button", { name: copy("en", "staffGoogleAccountFor", { email }), exact: true });
    await googleButton(fixture.memberEmail).press("Enter");
    await team.getByRole("textbox", { name: copy("en", "googleVerifiedEmail"), exact: true }).fill(fixture.candidate.email);
    await team.getByRole("textbox", { name: copy("en", "googleSubject"), exact: true }).fill(fixture.candidate.subject);
    await team.getByRole("textbox", { name: copy("en", "googleEvidenceRef"), exact: true }).fill("fixture/staff-replacement");
    await team.getByRole("button", { name: copy("en", "sendCode"), exact: true }).press("Enter");
    await team.getByText(fixture.candidate.subject, { exact: true }).waitFor();
    await team.getByText(fixture.candidate.email, { exact: true }).waitFor();
    await confirm("staff-google-binding");
    assert.equal(await convex.query(api.identity.viewer, { token: former.tokens.accessToken }), null);
    assert.equal(await convex.query(api.identity.viewer, { token: fixture.candidate.accessToken }), null);
    const replacement = await convex.mutation(api.auth.signInLocalFixture, { email: fixture.candidate.email });
    if (replacement.status !== "complete") throw new Error("Staff replacement did not admit a fresh session");
    redact(replacement.tokens.accessToken);
    redact(replacement.tokens.refreshToken);
    assert.partialDeepStrictEqual(await convex.query(api.identity.viewer, { token: replacement.tokens.accessToken }), {
      staffId: fixture.memberId, email: fixture.candidate.email, role: "staff",
    });

    await googleButton(fixture.candidate.email).press("Enter");
    await team.getByRole("combobox", { name: copy("en", "googleBindingAction"), exact: true }).selectOption("revoke");
    await team.getByText(copy("en", "googleRevokeEffect"), { exact: true }).waitFor();
    await team.getByRole("textbox", { name: copy("en", "googleEvidenceRef"), exact: true }).fill("fixture/staff-revocation");
    await team.getByRole("button", { name: copy("en", "sendCode"), exact: true }).press("Enter");
    await confirm("staff-google-binding");
    await googleButton(fixture.candidate.email).filter({ hasText: copy("en", "googleBindingRevoked") }).waitFor();
    assert.equal(await convex.query(api.identity.viewer, { token: replacement.tokens.accessToken }), null);
  } finally {
    await authority.context.close();
    await candidate.context.close();
  }
});

test("staff deep link survives a query-free Google redirect through tab return storage", async () => {
  const context = await newContext(await browsers.get());
  try {
    await context.addInitScript(() => localStorage.setItem("ease-pos-tracking-language", "en"));
    let observe!: (url: string) => void;
    const started = new Promise<string>(resolve => { observe = resolve; });
    await context.routeWebSocket(url => url.hostname === "127.0.0.1" && url.pathname.endsWith("/sync"), socket => {
      const server = socket.connectToServer();
      socket.onMessage(raw => {
        const message = JSON.parse(String(raw));
        if (message.udfPath === "auth:startSignInWithClerk") {
          observe(message.args[0].redirectTo);
          return;
        }
        server.send(raw);
      });
      server.onMessage(raw => socket.send(raw));
    });
    const page = await context.newPage();
    const search = new URLSearchParams({ project: "POS", q: "007", ticket: seed.tickets[0] });
    await page.goto(`${baseURL}/staff?${search}`);
    await page.waitForURL(url => url.pathname === "/staff/login" && !!url.searchParams.get("redirect"));
    const google = page.getByRole("button", { name: copy("en", "continueWithGoogle"), exact: true });
    const [returnURL] = await Promise.all([started, google.click()]);
    assert.equal(returnURL, new URL("/staff/login", baseURL).href);
    // Returning from Google lands on bare /staff/login; completing sign-in consumes the stashed return target once.
    await page.goto(returnURL);
    await page.getByRole("button", { name: "owner@local.test", exact: true }).click();
    await page.getByRole("dialog").getByRole("heading", { name: "Printer needs review", exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get("project"), "POS");
    assert.equal(new URL(page.url()).searchParams.get("ticket"), seed.tickets[0]);
    assert.equal(await page.getByPlaceholder("Search", { exact: true }).inputValue(), "007");
    await page.goto(`${baseURL}/staff/login`);
    await page.waitForURL(url => url.pathname === "/staff" && !!url.searchParams.get("project"));
    assert.equal(new URL(page.url()).searchParams.has("ticket"), false);
  } finally { await context.close(); }
});

test("authorized, malformed, wrong-Project and cross-customer Ticket deep links enforce the same unavailable state", async () => {
  const staff = await open("staff");
  const customer = await open("customer");
  try {
    // Staff: authorized Queue deep link opens the Ticket and closes cleanly.
    await staff.page.goto(`${baseURL}/staff?project=POS&view=queue&ticket=${seed.tickets[0]}`);
    const staffAuthorized = staff.page.getByRole("region", { name: "Printer needs review", exact: true });
    await staffAuthorized.waitFor();
    await staffAuthorized.getByRole("button", { name: copy("en", "detailBack"), exact: true }).click();
    await staff.page.waitForURL(url => !url.searchParams.has("ticket"));

    // Staff: malformed and wrong-Project links show the same unavailable state in inline Queue view.
    for (const path of ["/staff?project=POS&view=queue&ticket=bad", `/staff?project=APP&view=queue&ticket=${seed.tickets[0]}`]) {
      await staff.page.goto(baseURL + path);
      const panel = staff.page.getByRole("region", { name: copy("en", "ticket"), exact: true });
      await panel.getByRole("alert").filter({ hasText: copy("en", "ticketMissing") }).waitFor();
      assert.equal(await panel.getByText("Printer needs review", { exact: false }).count(), 0);
      await panel.getByRole("button", { name: copy("en", "detailBack"), exact: true }).click();
      await staff.page.waitForURL(url => !url.searchParams.has("ticket"));
    }

    // Staff: malformed and wrong-Project links show the same unavailable state in dialog Table view.
    for (const path of ["/staff?project=POS&view=table&ticket=bad", `/staff?project=APP&view=table&ticket=${seed.tickets[0]}`]) {
      await staff.page.goto(baseURL + path);
      const dialog = staff.page.getByRole("dialog", { name: copy("en", "ticket"), exact: true });
      await dialog.getByRole("alert").filter({ hasText: copy("en", "ticketMissing") }).waitFor();
      assert.equal(await dialog.getByText("Printer needs review", { exact: false }).count(), 0);
      await dialog.getByRole("button", { name: copy("en", "closeDialog"), exact: true }).click();
      await staff.page.waitForURL(url => !url.searchParams.has("ticket"));
    }

    // Disallowed Ticket characters are rejected by search validation without crashing or opening detail.
    await staff.page.goto(`${baseURL}/staff?project=POS&ticket=${encodeURIComponent("bad/id")}`);
    await staff.page.getByRole("button", { name: "New Ticket", exact: true }).first().waitFor();
    assert.equal(await staff.page.getByRole("region", { name: copy("en", "ticket"), exact: true }).count(), 0);

    // Customer (Alice): own Ticket opens; malformed, wrong-Project and Bob's Ticket are indistinguishable.
    await customer.page.goto(`${baseURL}/customer?project=POS&ticket=${seed.tickets[1]}`);
    const customerAuthorized = customer.page.getByRole("region", { name: "Ticket from Alice", exact: true });
    await customerAuthorized.waitFor();
    await customerAuthorized.getByRole("button", { name: copy("en", "detailBack"), exact: true }).click();
    await customer.page.waitForURL(url => !url.searchParams.has("ticket"));

    for (const path of [
      "/customer?project=POS&ticket=bad",
      `/customer?project=APP&ticket=${seed.tickets[1]}`,
      `/customer?project=POS&ticket=${seed.tickets[2]}`,
    ]) {
      await customer.page.goto(baseURL + path);
      const panel = customer.page.getByRole("region", { name: copy("en", "ticket"), exact: true });
      await panel.getByRole("alert").filter({ hasText: copy("en", "ticketMissing") }).waitFor();
      assert.equal(await panel.getByText("Ticket from Alice", { exact: false }).count(), 0);
      assert.equal(await panel.getByText("Ticket from Bob", { exact: false }).count(), 0);
      await panel.getByRole("button", { name: copy("en", "detailBack"), exact: true }).click();
      await customer.page.waitForURL(url => !url.searchParams.has("ticket"));
    }

    assert.deepEqual(staff.errors, []);
    assert.deepEqual(customer.errors, []);
  } finally {
    await customer.context.close();
    await staff.context.close();
  }
});

test("active text draft confirms before sign-out without upload traffic", async () => {
  const { page, context, title, token, errors, uploads } = await open("customer", "en");
  try {
    await title.fill("Active text draft");
    await page.getByRole("button", { name: copy("en", "closeDialog"), exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });

    const menu = page.locator("header").getByRole("button", { name: copy("en", "customerQueueMore"), exact: true });
    const signOut = page.getByRole("menuitem", { name: copy("en", "signOut"), exact: true });
    await menu.click();
    await Promise.all([
      page.waitForEvent("dialog").then(async dialog => {
        assert.equal(dialog.message(), copy("en", "leaveTicketDraft"));
        await dialog.dismiss();
      }),
      signOut.click(),
    ]);
    assert.equal(new URL(page.url()).pathname, "/customer");
    assert.notEqual(await convex.query(api.identity.viewer, { token }), null);
    await page.getByRole("button", { name: copy("en", "resumeTicket"), exact: true }).first().click();
    assert.equal(await title.inputValue(), "Active text draft");

    await page.getByRole("button", { name: copy("en", "closeDialog"), exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await menu.click();
    await Promise.all([
      page.waitForEvent("dialog").then(async dialog => {
        assert.equal(dialog.message(), copy("en", "leaveTicketDraft"));
        await dialog.accept();
      }),
      signOut.click(),
    ]);
    await page.waitForURL(url => url.pathname === "/customer/login");
    await page.locator("#customer-password").waitFor({ state: "visible" });
    assert.equal(await convex.query(api.identity.viewer, { token }), null);
    assert.equal(uploads(), 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("sign-out waits for the active draft to cancel with a live session", { timeout: 30_000 }, async () => {
  let intentRequest: number | undefined;
  let releaseIntent: (() => void) | undefined;
  let received!: (release: () => void) => void;
  const intentResponse = new Promise<() => void>(resolve => { received = resolve; });
  const events: string[] = [];
  const { page, context, title, token, errors, uploads } = await open("staff", "en", async context => {
    await context.routeWebSocket(url => url.hostname === "127.0.0.1" && url.pathname.endsWith("/sync"), socket => {
      const server = socket.connectToServer();
      socket.onMessage(raw => {
        const msg = JSON.parse(String(raw));
        if (msg.udfPath === "uploads:createUploadIntent") intentRequest = msg.requestId;
        if (msg.udfPath === "auth:signOut") events.push("logout");
        server.send(raw);
      });
      let queued: (string | Buffer)[] | undefined;
      server.onMessage(raw => {
        if (queued) { queued.push(raw); return; }
        const msg = JSON.parse(String(raw));
        if (msg.type === "MutationResponse" && intentRequest !== undefined && msg.requestId === intentRequest) {
          // Convex resolves this write when the following Transition arrives.
          // Preserve server message order while holding its acknowledgement.
          queued = [raw];
          received(() => {
            for (const message of queued ?? []) socket.send(message);
            queued = undefined;
          });
        } else socket.send(raw);
      });
    });
    // Convex Auth revokes sessions over its separate HTTP client (/api/mutation).
    await context.route("**/api/mutation", async route => {
      if (route.request().postDataJSON()?.path === "auth:signOut") events.push("logout");
      await route.continue();
    });
    await context.route("**/api/uploads/cancel", async route => {
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      assert.equal((await response.json()).ok, true);
      events.push("canceled");
      await route.fulfill({ response });
    });
  });
  try {
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await chooseProject(page, "APP");
    await page.waitForURL(url => url.searchParams.get("project") === "APP");
    await page.getByRole("button", { name: "New Ticket", exact: true }).first().click();
    await title.fill("Sign-out during upload intent creation");
    await files(page);
    await page.getByRole("button", { name: copy("en", "submitTicket"), exact: true }).click();
    await page.getByRole("button", { name: copy("en", "cancelUpload") }).waitFor();
    releaseIntent = await intentResponse;
    // Back would leave the upload's Project. Declining keeps the draft active.
    await Promise.all([
      page.waitForEvent("dialog").then(async dialog => {
        assert.equal(dialog.message(), copy("en", "switchDuringUpload"));
        await dialog.dismiss();
      }),
      page.evaluate(() => history.back()),
    ]);
    await page.waitForURL(url => url.searchParams.get("project") === "APP");
    assert.equal(await title.inputValue(), "Sign-out during upload intent creation");
    assert.deepEqual(events, []);
    // The modal traps pointer input. Dispatch the workspace action directly to
    // exercise a sign-out arriving while the upload intent response is in flight.
    // The staff overflow menu stays mounted while closed, so the item is wired.
    const signOut = page.locator('[role="menu"] [role="menuitem"]', { hasText: copy("en", "signOut") });
    await Promise.all([
      page.waitForEvent("dialog").then(async dialog => {
        assert.equal(dialog.message(), copy("en", "leaveTicketDraft"));
        await dialog.dismiss();
      }),
      signOut.dispatchEvent("click"),
    ]);
    assert.deepEqual(events, []);
    const abortsBefore = (await stats(page)).aborts;
    await Promise.all([
      page.waitForEvent("dialog").then(async dialog => {
        assert.equal(dialog.message(), copy("en", "leaveTicketDraft"));
        await dialog.accept();
      }),
      signOut.dispatchEvent("click"),
    ]);
    await page.waitForFunction(before => window.draftStats.aborts > before, abortsBefore);
    assert.deepEqual(events, []);
    releaseIntent();
    releaseIntent = undefined;
    await page.waitForURL(url => url.pathname === "/staff/login");
    await page.getByRole("button", { name: copy("en", "continueWithGoogle"), exact: true }).waitFor({ state: "visible" });
    assert.equal(events[0], "canceled", "Upload cancel must complete with a live session before sign-out");
    assert.equal(events[1], "logout", "Sign-out must follow upload cancellation");
    assert.equal(events.filter(event => event === "canceled").length, 1);
    assert.equal(await convex.query(api.identity.viewer, { token }), null);
    assert.equal(uploads(), 0);
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error("Sign-out state", events, page.url(), (await page.locator("body").innerText()).slice(-1500));
    throw error;
  } finally { releaseIntent?.(); await context.close(); }
});

const pageFixture = path.resolve(import.meta.dirname, "../fixtures/ticket-page");
/** Creates a text-only Ticket, deep-links to its detail and expands hosted pages. */
async function openNewTicket(f: Awaited<ReturnType<typeof open>>, role: "staff" | "customer", language: Language) {
  const name = `Pages ${role} ${crypto.randomUUID()}`;
  const created = await convex.mutation(api.tickets.createTextTicket, {
    token: f.token, projectKey: "POS", title: name, description: "Hosted page fixture", requestId: crypto.randomUUID(),
  });
  await f.page.goto(`${baseURL}/${role}?project=POS${role === "staff" ? "&view=table" : ""}&ticket=${created.ticket._id}`);
  await f.page.getByRole("heading", { name, exact: true }).waitFor();
  await f.page.getByRole("button", { name: copy(language, "pagesTitle"), exact: true }).click();
  const dialog = f.page.locator("body");
  await dialog.getByText(copy(language, role === "staff" ? "pagesHint" : "customerPagesHint"), { exact: true }).waitFor();
  return { dialog, ref: created.ticket.ticketNumber };
}
async function publishFrom(dialog: Locator, language: Language, input: "choosePageFolder" | "chooseHtmlFile", source: string, entry?: string, timeout?: number) {
  await dialog.getByLabel(copy(language, input), { exact: true }).setInputFiles(source);
  if (entry) await dialog.getByLabel(copy(language, "pageEntry"), { exact: true }).selectOption(entry);
  await dialog.getByRole("button", { name: copy(language, "publishPage"), exact: true }).click();
  const link = dialog.getByRole("link", { name: copy(language, "openPageNamed", { name: entry ?? path.basename(source) }), exact: true });
  await link.waitFor({ timeout });
  return link;
}

for (const [role, language] of [["staff", "en"], ["staff", "th"]] as const) {
  test(`staff ${language}: publish a folder page with nested assets, open it isolated, copy, revoke; publish a single file`, async () => {
    const f = await open(role, language);
    const responses = new Map<string, { status: number; type: string | null }>();
    f.context.on("response", response => { if (response.url().includes("/p/")) responses.set(new URL(response.url()).pathname, { status: response.status(), type: response.headers()["content-type"] ?? null }); });
    try {
      await f.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL });
      const { dialog } = await openNewTicket(f, role, language);
      await dialog.getByText(copy(language, "pagesEmpty"), { exact: true }).waitFor();
      const link = await publishFrom(dialog, language, "choosePageFolder", pageFixture, "reports/summary.html");
      const url = (await link.getAttribute("href"))!;
      assert.match(url, /\/p\/[A-Za-z0-9_-]{43}\/reports\/summary\.html$/);
      assert.equal(await link.getAttribute("rel"), "noopener noreferrer");

      const [popup] = await Promise.all([f.context.waitForEvent("page"), link.click()]);
      const popupErrors = hostedPageErrors(popup);
      await popup.getByText("Inline script ran", { exact: true }).waitFor();
      await popup.getByText("External script ran", { exact: true }).waitFor();
      await popup.waitForFunction(() => (document.getElementById("shot") as HTMLImageElement).naturalWidth === 8);
      await popup.waitForFunction(() => document.fonts.status === "loaded");
      const prefix = new URL(url).pathname.replace(/reports\/summary\.html$/, "");
      const assets = [["assets/site.css", "text/css"], ["assets/app.js", "text/javascript"], ["assets/img/dot.png", "image/png"], ["assets/img/bg.png", "image/png"], ["assets/fonts/fixture.woff2", "font/woff2"]];
      // CSS backgrounds and fonts load asynchronously after the scripts run.
      for (let waited = 0; assets.some(([file]) => !responses.has(prefix + file)) && waited < 5000; waited += 50) await popup.waitForTimeout(50);
      for (const [file, type] of assets) {
        assert.equal(responses.get(prefix + file)?.status, 200, file);
        assert.match(responses.get(prefix + file)?.type ?? "", new RegExp(`^${type}`), file);
      }
      // The page runs in an opaque-origin sandbox: no app storage and no opener.
      assert.deepEqual(await popup.evaluate(() => {
        let storage = "readable";
        try { void sessionStorage.length; } catch { storage = "blocked"; }
        return { storage, opener: window.opener === null, origin: window.origin };
      }), { storage: "blocked", opener: true, origin: "null" });
      await popup.locator("#details").click();
      await popup.getByRole("heading", { name: "Fixture details", exact: true }).waitFor();
      assert.deepEqual(popupErrors, []);

      await dialog.getByRole("button", { name: copy(language, "copyLinkNamed", { name: "reports/summary.html" }), exact: true }).click();
      await f.page.waitForFunction(async expected => await navigator.clipboard.readText() === expected, url);

      await dialog.getByRole("button", { name: copy(language, "revokeLinkNamed", { name: "reports/summary.html" }), exact: true }).click();
      await f.page.getByRole("alertdialog").getByRole("button", { name: copy(language, "revokeLink"), exact: true }).click();
      await dialog.getByText(copy(language, "pagesEmpty"), { exact: true }).waitFor();
      assert.equal((await popup.goto(url))?.status(), 404);
      assert.equal((await popup.goto(new URL("../assets/img/dot.png", url).href))?.status(), 404);

      const single = await publishFrom(dialog, language, "chooseHtmlFile", path.join(pageFixture, "reports/details.html"));
      assert.match((await single.getAttribute("href"))!, /\/details\.html$/);
      assert.equal(await dialog.getByLabel(copy(language, "pageEntry"), { exact: true }).count(), 0);
      assert.equal(f.uploads(), 0);
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });
}

test("customer cannot choose an HTML file or folder on their Ticket", async () => {
  const f = await open("customer", "th");
  try {
    const { dialog } = await openNewTicket(f, "customer", "th");
    await dialog.getByText(copy("th", "pagesEmpty"), { exact: true }).waitFor();
    assert.equal(await dialog.getByLabel(copy("th", "choosePageFolder"), { exact: true }).count(), 0);
    assert.equal(await dialog.getByLabel(copy("th", "chooseHtmlFile"), { exact: true }).count(), 0);
  } finally { await f.context.close(); }
});

test("publishing an HTML screenshot fits Full HD and preserves transparent pixels", async () => {
  const { default: sharp } = await import("sharp");
  const source = await sharp({ create: { width: 3000, height: 300, channels: 4, background: "#1495ac80" } }).png().toBuffer();
  const html = '<img alt="Ticket screenshot" src="data:image/png;base64,' + source.toString("base64") + '">';
  const f = await open("staff");
  try {
    const { dialog } = await openNewTicket(f, "staff", "en");
    await dialog.getByLabel(copy("en", "chooseHtmlFile"), { exact: true }).setInputFiles({
      name: "screenshot.html", mimeType: "text/html", buffer: Buffer.from(html),
    });
    await dialog.getByRole("button", { name: copy("en", "publishPage"), exact: true }).click();
    const link = dialog.getByRole("link", { name: copy("en", "openPageNamed", { name: "screenshot.html" }), exact: true });
    const [popup] = await Promise.all([f.context.waitForEvent("page"), link.click()]);
    const image = popup.getByAltText("Ticket screenshot");
    await image.evaluate(async element => { await (element as HTMLImageElement).decode(); });
    const data = await image.getAttribute("src");
    assert(data);
    const pixels = await sharp(Buffer.from(data.split(",")[1], "base64")).raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([pixels.info.width, pixels.info.height, pixels.info.channels, pixels.data[3]], [1920, 192, 4, 128]);
  } finally { await f.context.close(); }
});

/**
 * Records each page publish: its image policy header and multipart payload bytes.
 * Chromium hides File-backed parts from Playwright, so the payload is summed in
 * the page from the FormData the app hands to fetch. Applies from the next navigation.
 */
async function trackPublishes(context: BrowserContext) {
  await context.addInitScript(() => {
    const send = window.fetch.bind(window);
    const sizes: number[] = [];
    Object.assign(window, { pageUploadBytes: sizes });
    window.fetch = (input, init) => {
      if (init?.body instanceof FormData && String(input).includes("/pages")) {
        let bytes = 0;
        init.body.forEach(value => { bytes += typeof value === "string" ? new TextEncoder().encode(value).length : value.size; });
        sizes.push(bytes);
      }
      return send(input, init);
    };
  });
  const requests: Request[] = [];
  context.on("request", request => { if (request.method() === "POST" && /\/v1\/tickets\/[^/]+\/pages$/.test(new URL(request.url()).pathname)) requests.push(request); });
  return async (page: Page) => {
    const sizes = await page.evaluate(() => (window as unknown as { pageUploadBytes: number[] }).pageUploadBytes);
    return requests.map((request, index) => ({ bytes: sizes[index], policy: request.headers()["x-ticket-image-policy"] ?? null }));
  };
}

test("originals over the request limit are prepared in the browser and stay within Full HD", { timeout: 120_000 }, async () => {
  const { default: sharp } = await import("sharp");
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const folder = await mkdtemp(path.join(tmpdir(), "ticket-page-large-"));
  // Uncompressed noise: 2200 × 1800 RGBA is about 15.8 MB, over the 10 MiB page limit.
  const photo = await sharp({ create: { width: 2200, height: 1800, channels: 4, background: "#000", noise: { type: "gaussian", mean: 128, sigma: 50 } } }).png({ compressionLevel: 0 }).toBuffer();
  await writeFile(path.join(folder, "index.html"), '<img alt="Large photo" src="photo.png">');
  await writeFile(path.join(folder, "photo.png"), photo);
  const f = await open("staff");
  const publishes = await trackPublishes(f.context);
  try {
    assert.ok(photo.length > 10 * 1024 * 1024);
    const { dialog } = await openNewTicket(f, "staff", "en");
    await dialog.getByLabel(copy("en", "choosePageFolder"), { exact: true }).setInputFiles(folder);
    await dialog.getByRole("button", { name: copy("en", "publishPage"), exact: true }).click();
    const link = dialog.getByRole("link", { name: copy("en", "openPageNamed", { name: "index.html" }), exact: true });
    await link.waitFor({ timeout: 60_000 });
    const posts = await publishes(f.page);
    assert.deepEqual(posts.map(post => post.policy), ["v1"]);
    assert.ok(posts[0].bytes < photo.length / 2, `request ${posts[0].bytes} bytes`);
    const stored = Buffer.from(await (await fetch(new URL("photo.png", (await link.getAttribute("href"))!))).arrayBuffer());
    const meta = await sharp(stored).metadata();
    assert.deepEqual([meta.width, meta.height], [1320, 1080]);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); await rm(folder, { recursive: true, force: true }); }
});

/** Every literal base64 `img src` in served HTML, decoded with its stored format. */
async function embeddedImages(html: string) {
  const { default: sharp } = await import("sharp");
  return await Promise.all([...html.matchAll(/<img\b[^>]*?\ssrc="data:(image\/[a-z]+);base64,([^"]+)"/g)].map(async ([, type, base64]) => {
    const bytes = Buffer.from(base64, "base64");
    const meta = await sharp(bytes).metadata();
    return { type, bytes, size: bytes.length, width: meta.width!, height: meta.height!, alpha: Boolean(meta.hasAlpha) };
  }));
}

// The real Thai report (1.4 MB, nine embedded screenshots, zoom dialog) when present locally.
// PAGE_SAMPLE_EVIDENCE names a JSON file that receives per-image sizes and formats.
const sampleHtml = process.env.PAGE_SAMPLE_HTML;
test("staff: the real sample page publishes, renders every screenshot and opens its zoom dialog", { timeout: 120_000, skip: !sampleHtml && "PAGE_SAMPLE_HTML is not set" }, async () => {
  const { default: sharp } = await import("sharp");
  const { faithfulPixels, fitImage } = await import("../../shared/image-optimization");
  const { readFile, writeFile } = await import("node:fs/promises");
  const f = await open("staff");
  const publishes = await trackPublishes(f.context);
  try {
    const { dialog } = await openNewTicket(f, "staff", "en");
    const started = Date.now();
    const link = await publishFrom(dialog, "en", "chooseHtmlFile", sampleHtml!, undefined, 90_000);
    const publishMs = Date.now() - started;
    const url = (await link.getAttribute("href"))!;
    const [popup] = await Promise.all([f.context.waitForEvent("page"), link.click()]);
    const popupErrors = hostedPageErrors(popup);
    await popup.waitForLoadState("load");
    const shots = popup.locator("button.shot img");
    assert.equal(await shots.count(), 9);
    await popup.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>("button.shot img")].every(image => image.complete && image.naturalWidth > 0));
    await popup.locator("button.shot").first().click();
    await popup.waitForFunction(() => (document.getElementById("zoom") as HTMLDialogElement).open);
    await popup.locator("#zclose").click();
    await popup.waitForFunction(() => !(document.getElementById("zoom") as HTMLDialogElement).open);
    assert.deepEqual(popupErrors, []);
    assert.deepEqual(f.errors, []);

    const source = await readFile(sampleHtml!);
    const served = Buffer.from(await (await fetch(url)).arrayBuffer());
    const before = await embeddedImages(source.toString("utf8"));
    const after = await embeddedImages(served.toString("utf8"));
    assert.equal(after.length, before.length);
    const images = await Promise.all(after.map(async (output, index) => {
      const original = before[index];
      const fitted = fitImage(original.width, original.height);
      // Full HD bounds, aspect and alpha hold; pixels pass the same comparison the encoder used.
      assert.deepEqual([output.width, output.height], [fitted.width, fitted.height], `image ${index} size`);
      assert.equal(output.alpha && !original.alpha ? "alpha added" : "ok", "ok", `image ${index} alpha`);
      const reference = await sharp(original.bytes).rotate().resize(fitted.width, fitted.height, { fit: "fill" }).ensureAlpha().raw().toBuffer();
      const pixels = await sharp(output.bytes).ensureAlpha().raw().toBuffer();
      return { index, from: original.type, to: output.type, beforeBytes: original.size, afterBytes: output.size,
        width: output.width, height: output.height, faithful: faithfulPixels(reference, pixels) };
    }));
    assert.ok(images.every(image => image.faithful), "every stored image passes the pixel comparison");
    const posts = await publishes(f.page);
    assert.equal(posts.length, 1, "one publish request");
    assert.equal(posts[0].policy, null, "originals within the limits go to the server pipeline");
    assert.ok(posts[0].bytes >= source.length, "the original HTML is sent unchanged");
    assert.ok(served.length < source.length, "the server stores a smaller page");
    const evidence = { source: { bytes: source.length }, served: { bytes: served.length, savedPercent: +(100 * (1 - served.length / source.length)).toFixed(1) },
      request: posts[0], publishMs, converted: images.filter(image => image.from !== image.to).length, images };
    console.log("PAGE_SAMPLE_EVIDENCE " + JSON.stringify({ ...evidence, images: undefined }));
    if (process.env.PAGE_SAMPLE_EVIDENCE) await writeFile(process.env.PAGE_SAMPLE_EVIDENCE, JSON.stringify(evidence, null, 2));
  } finally { await f.context.close(); }
});

for (const role of ["staff", "customer"] as const) {
  test(`${role}: thumbnail pencil renames the attachment beside its filename`, async () => {
    const device = role === "customer" ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : {};
    const { context, page, title, errors, uploads } = await openWith(await browsers.get(), role, "en", undefined, device);
    const button = (name: string) => page.getByRole("button", { name, exact: true });
    try {
      await title.fill("Payment screen freezes");
      await files(page, "checkout.png");
      const rename = button("Rename checkout.png");
      assert.equal(await rename.textContent(), "");
      assert.equal(await rename.locator("svg.lucide-pencil").count(), 1);
      assert.equal(await button("Use suggestion").count(), 0);
      await rename.click();
      const field = page.getByRole("textbox", { name: "File name", exact: true });
      await button("Use suggestion").click();
      assert.equal(await field.inputValue(), "Payment screen freezes - Photo 1");
      await field.fill("Checkout error.png");
      await field.press("Enter");
      await button("Rename Checkout error.png").waitFor();
      await button(copy("en", "composerPreview")).click();
      const review = page.getByRole("region", { name: copy("en", "composerPreview") });
      assert.equal(await review.getByText("Checkout error.png", { exact: true }).count(), 1);
      await button("Rename Checkout error.png").click();
      await button("Restore original").click();
      await rename.waitFor();
      assert.equal(uploads(), 0);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}
