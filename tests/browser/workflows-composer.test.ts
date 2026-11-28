// Ticket creation, draft lifecycle, and attachment editing.
import { markupLabels } from "../../src/lib/markup-labels";
import { mediaUxCopy } from "../../src/lib/media-ux-copy";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { after } from "node:test";
import type { BrowserContext, Locator, Page } from "playwright";
import { api } from "../../convex/_generated/api";
import { EVIDENCE_DIR } from "../../scripts/browser-evidence";
import type { Id } from "../../convex/_generated/dataModel";
import { chooseProject, convex, copy, files, projectSwitcher, suiteBrowser, workflowTest as test, open as openWith, seed, stats, type Language } from "./harness";

const browsers = suiteBrowser();
after(() => browsers.close());
const open = async (role: "staff" | "customer", language?: Language, configure?: (context: BrowserContext) => Promise<void>) => openWith(await browsers.get(), role, language, configure);

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
    await button(labels.fitWidth).tap();
    await button(labels.pan).tap();
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
    await button(labels.fitWidth).tap();
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

test("desktop screenshot markup keeps its zoom center and Fine-tune selection on a short screen", async () => {
  const { context, page } = await openWith(await browsers.get(), "customer", "en", undefined, {
    viewport: { width: 1280, height: 500 },
  });
  try {
    const labels = markupLabels("en");
    const name = "desktop-receipt.png";
    await attachLongReceipt(page, name);
    await page.getByRole("button", { name: copy("en", "editImageNamed", { name }), exact: true }).click();
    const dialog = page.getByRole("dialog", { name: copy("en", "editDraftImage"), exact: true });
    const control = (label: string) => dialog.getByRole("button", { name: label, exact: true });
    const surface = dialog.getByRole("application", { name: labels.canvasLabel });
    const viewport = surface.locator("../..");
    const center = () => surface.evaluate(el => {
      const photo = el.getBoundingClientRect();
      const frame = el.parentElement!.parentElement!;
      const bounds = frame.getBoundingClientRect();
      return {
        x: (bounds.left + frame.clientLeft + frame.clientWidth / 2 - photo.left) / photo.width,
        y: (bounds.top + frame.clientTop + frame.clientHeight / 2 - photo.top) / photo.height,
      };
    });
    await viewport.waitFor();
    for (let step = 0; step < 4; step++) {
      await control(labels.zoomIn).click();
      const point = await center();
      assert.ok(Math.abs(point.x - 0.5) < 0.02 && Math.abs(point.y - 0.5) < 0.02,
        `Zoom step ${step + 1} keeps the receipt centered (${point.x}, ${point.y})`);
    }

    const frame = (await viewport.boundingBox())!;
    await page.mouse.click(frame.x + frame.width / 2, frame.y + frame.height / 2);
    await control(labels.circle).click();
    const tune = control(labels.fineTune);
    await tune.press("Enter");
    const panel = dialog.getByRole("group", { name: labels.fineTune, exact: true });
    await panel.waitFor();
    assert.ok(await panel.evaluate(el => el === document.activeElement && el.matches(":focus-visible")));
    const marks = panel.getByRole("combobox", { name: labels.marks });
    await marks.focus();
    await marks.selectOption({ index: 1 });
    assert.ok(await marks.evaluate(el => el === document.activeElement));
    assert.equal(await control(labels.select).getAttribute("aria-pressed"), "true");
    await panel.getByRole("spinbutton", { name: `${labels.width} (px)`, exact: true }).waitFor();
    await viewport.evaluate(el => { el.scrollLeft = 0; });
    const narrowed = await viewport.evaluate(el => el.clientWidth);
    const surfaceElement = (await surface.elementHandle())!;
    await page.waitForFunction(surface => {
      const frame = surface.parentElement!.parentElement!;
      const canvas = frame.querySelector("canvas")!;
      return canvas.offsetLeft === 0 && Math.abs(canvas.getBoundingClientRect().width - frame.clientWidth) < 1;
    }, surfaceElement);
    await tune.click();
    await page.waitForFunction(({ surface, narrowed }) => {
      const frame = surface.parentElement!.parentElement!;
      const canvas = frame.querySelector("canvas")!;
      return frame.clientWidth > narrowed && Math.abs(canvas.getBoundingClientRect().width - frame.clientWidth) < 1;
    }, { surface: surfaceElement, narrowed });

    await tune.click();
    await control(labels.undo).click();
    await panel.waitFor({ state: "hidden" });
    await control(labels.redo).click();
    assert.equal(await tune.getAttribute("aria-expanded"), "false");
    const review = (await control(labels.review).boundingBox())!;
    assert.ok(review.y + review.height <= 500);
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
    for (const label of [labels.select, labels.pan, labels.circle, labels.crop, labels.mask, labels.eraser, labels.zoomIn, labels.zoomOut, labels.fitWidth, labels.fitImage, labels.undo, labels.redo]) {
      const box = await control(label).boundingBox();
      assert.ok(box && box.width >= 44 && box.height >= 44, `${label} has a 44 × 44 px touch target`);
    }
    const circleBoxBefore = (await control(labels.circle).boundingBox())!;
    await control(labels.pan).tap();
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
    await control(labels.eraser).tap();
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
    async function tapHere(name: string, beforeTap?: () => Promise<void>) {
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
      await beforeTap?.();
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
      await tapHere(t("savePin"), async () => {
        for (const action of [t("repositionPin"), t("cancel"), t("savePin")]) {
          const visible = await photo.getByRole("button", { name: action, exact: true }).evaluate(element => {
            const box = element.getBoundingClientRect();
            const viewport = window.visualViewport!;
            const point = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
            return box.left >= viewport.offsetLeft && box.top >= viewport.offsetTop
              && box.right <= viewport.offsetLeft + viewport.width && box.bottom <= viewport.offsetTop + viewport.height
              && element.contains(point);
          });
          assert.ok(visible, `${language} ${viewport.width}×320: ${action} remains fully visible and touchable`);
        }
        const screenshots = path.join(EVIDENCE_DIR, "public", "screenshots");
        mkdirSync(screenshots, { recursive: true });
        await page.screenshot({ path: path.join(screenshots, `workflows-photo-note-keyboard-${language}-${viewport.width}.png`) });
      });
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
      await control(labels.eraser).click();
      await place(0.25, 0.68);
      await control(labels.undo).click();
      await control(labels.redo).click();
      await control(labels.crop).click();
      await place(0.02, 0.02);
      await place(0.20, 0.20);
      assert.ok(await control(labels.review).isDisabled());
      await control(labels.expandCrop).click();
      assert.equal(await control(labels.review).isDisabled(), false);
      await control(labels.crop).click();
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
        const labels = mediaUxCopy(language);
        const capture = camera.getByRole("button", { name: copy(language, "takePhoto"), exact: true });
        const sheetPreview = camera.getByRole("img", { name: labels.capturedPreview, exact: true });
        const draftFilesBeforeCapture = (await stats(page)).created.length;
        await capture.click();
        await sheetPreview.waitFor();
        assert.equal(await page.locator('[data-slot="sortable-item"]').count(), 0, "review alone does not add a draft file");
        assert.equal((await stats(page)).created.length, draftFilesBeforeCapture + 1, "review preview reuses one blob URL");
        await camera.getByRole("button", { name: labels.retakePhoto, exact: true }).click();
        await sheetPreview.waitFor({ state: "hidden" });
        await page.waitForFunction(before => window.draftStats.revoked.length === before + 1, draftFilesBeforeCapture);
        await capture.click();
        await sheetPreview.waitFor();
        await camera.getByRole("button", { name: labels.usePhoto, exact: true }).click();
        await page.waitForFunction(before => window.draftStats.created.length === before + 3 && window.draftStats.revoked.length === before + 2, draftFilesBeforeCapture);
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
      await page.waitForFunction(() => window.draftStats.revoked.length === window.draftStats.created.length && window.draftStats.revoked.length >= 2 && window.draftStats.stops.length === 2);
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
      await composer.getByRole("heading", { name: /POS-\d+/ }).waitFor();
      await composer.getByRole("button", { name: language === "th" ? "ดู Ticket" : "View Ticket", exact: true }).click();
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
    await page.getByRole("button", { name: "Continue draft", exact: true }).first().click();
    assert.equal(await title.inputValue(), name);
    await page.getByRole("dialog").getByText("Point of Sale (POS)", { exact: true }).waitFor();
    await page.getByRole("button", { name: copy("en", "submitTicket"), exact: true }).click();
    await page.getByRole("heading", { name: /POS-\d+/ }).waitFor();
    await page.getByRole("button", { name: "View Ticket", exact: true }).click();
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
    if (role === "staff") assert.equal(await page.getByPlaceholder("Search", { exact: true }).inputValue(), name);
    await page.reload();
    await detail.waitFor();
    assert.equal(new URL(page.url()).searchParams.get("project"), "POS");
    assert.equal(new URL(page.url()).searchParams.get("ticket"), created._id);
    if (role === "staff") assert.equal(await page.getByPlaceholder("Search", { exact: true }).inputValue(), "");
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
    await Promise.all([
      page.waitForEvent("dialog").then(async dialog => {
        assert.equal(dialog.message(), "Discard unsaved changes to this Ticket?");
        await dialog.accept();
      }),
      page.getByRole("button", { name: copy("en", "detailBack"), exact: true }).click(),
    ]);
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
  test(`${role} ${language}: saving suppresses Cancel; an uncertain response can be retried once; Discard releases previews`, async () => {
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
      assert.equal(await page.getByRole("button", { name: copy(language, "cancelUpload"), exact: true }).count(), 0);
      assert.equal(await page.getByRole("button", { name: copy(language, "closeDialog"), exact: true }).isDisabled(), true);
      await page.getByRole("status").filter({ hasText: language === "th" ? "กำลังบันทึก Ticket" : "Saving Ticket" }).waitFor();
      assert.equal((await stats(page)).revoked.length, releasedBeforeSubmit);
      release();
      const retry = page.getByRole("button", { name: language === "th" ? "ลองส่งอีกครั้ง" : "Retry submission", exact: true });
      await retry.waitFor();
      loseResponses = false;
      await page.getByText(copy(language, "pinSummary", { count: 1 }), { exact: true }).waitFor();
      assert.equal(await title.inputValue(), name);
      assert.equal(await description.inputValue(), "Keep this description");
      await retry.click();
      await page.getByRole("heading", { name: /POS-\d+/ }).waitFor();
      await page.getByRole("button", { name: language === "th" ? "ดู Ticket" : "View Ticket", exact: true }).click();
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
    await page.getByRole("button", { name: "Continue draft", exact: true }).first().click();
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

test("optional customer guide focuses steps, resumes Review and edits the description directly", async () => {
  const { context, page, title } = await open("customer", "en");
  try {
    await page.getByRole("button", { name: "Use step-by-step guide" }).click();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    assert.equal(await title.evaluate(el => el === document.activeElement), true);
    const validation = await title.getAttribute("aria-describedby");
    assert.equal(await page.locator(`#${validation}`).innerText(), "A topic is required.");
    await title.fill("Guided ticket");
    const description = page.locator("#customer-ticket-description");
    await description.fill("The description stays in this draft");
    const guidance = await description.getAttribute("aria-describedby");
    assert.equal(await page.locator(`#${guidance}`).innerText(), copy("en", "descriptionPlaceholder"));
    await page.getByRole("button", { name: "Next", exact: true }).press("Enter");
    const media = page.getByRole("heading", { name: "Step 2 of 3 · Photos & videos" });
    assert.equal(await media.evaluate(el => el === document.activeElement), true);
    await files(page);
    await page.getByRole("button", { name: "Next", exact: true }).click();
    const review = page.getByRole("heading", { name: "Step 3 of 3 · Review and submit" });
    assert.equal(await review.evaluate(el => el === document.activeElement), true);
    await page.getByRole("button", { name: /draft.png.*Photo 1/ }).waitFor();
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await page.getByRole("button", { name: copy("en", "resumeTicket"), exact: true }).first().click();
    await review.waitFor();
    await page.waitForFunction(() => document.activeElement?.matches("[data-composer-step-heading]"));
    await page.getByRole("button", { name: "Edit description", exact: true }).click();
    assert.equal(await description.evaluate(el => el === document.activeElement), true);
    assert.equal(await description.inputValue(), "The description stays in this draft");
  } finally { await context.close(); }
});

test("staff attachment preview fills a 375 px phone viewport and keeps Close visible", async () => {
  const { context, page } = await openWith(await browsers.get(), "staff", "en", undefined, {
    viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true,
  });
  try {
    await files(page);
    await page.getByRole("button", { name: copy("en", "openMedia", { name: "draft.png" }), exact: true }).tap();
    const viewer = page.getByRole("dialog", { name: "draft.png", exact: true });
    await viewer.waitFor();
    const popup = await viewer.elementHandle();
    assert.ok(popup);
    await page.waitForFunction(element => {
      const box = element.getBoundingClientRect();
      return Math.abs(box.height - (window.visualViewport?.height ?? window.innerHeight)) < 2;
    }, popup);
    const close = await viewer.getByRole("button", { name: copy("en", "closeDialog"), exact: true }).boundingBox();
    assert.ok(close && close.y >= 0 && close.y + close.height <= 812);
  } finally { await context.close(); }
});
