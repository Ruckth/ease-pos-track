// Mounted production components with in-memory data (tests/browser/components.html):
// Project switcher choices across a three-to-two change, menu viewport bounds,
// one-dot Ticket rows and independently bound Undo notifications.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { after, test as nodeTest } from "node:test";
import type { BrowserContextOptions, Page } from "playwright";
import { capture, EVIDENCE_DIR, newContext } from "../../scripts/browser-evidence";
import { baseURL, copy, open as openWith, suiteBrowser, type Language } from "./harness";
import { mediaUxCopy } from "../../src/lib/media-ux-copy";

const browsers = suiteBrowser();
after(() => browsers.close());
const test = (name: string, run: () => Promise<void>) => nodeTest(name, () => capture("components", name, run));
const shotDir = path.join(EVIDENCE_DIR, "public", "screenshots");
const shot = async (page: Page, name: string) => { mkdirSync(shotDir, { recursive: true }); await page.screenshot({ path: path.join(shotDir, `components-${name}.png`), animations: "disabled" }); };

async function harness(query: string, viewport = { width: 1280, height: 900 }, language: Language = "en", options: BrowserContextOptions = {}) {
  const context = await newContext(await browsers.get(), { reducedMotion: "reduce", ...options, viewport });
  await context.addInitScript(value => localStorage.setItem("ease-pos-tracking-language", value), language);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${baseURL}/tests/browser/components.html?${query}`);
  return { context, page, errors };
}
const trigger = (page: Page, language: Language = "en") => page.getByRole("button", { name: new RegExp(`^${copy(language, "chooseProject")}`) });
const choices = (page: Page) => page.getByRole("menuitemradio");

/** Every menu popup stays inside the visual viewport with the 8 px collision inset. */
async function assertInViewport(page: Page, label: string) {
  const box = await page.getByRole("menu").evaluate(element => {
    const rect = element.getBoundingClientRect();
    const viewport = window.visualViewport!;
    return { left: rect.left - viewport.offsetLeft, right: rect.right - viewport.offsetLeft, top: rect.top - viewport.offsetTop,
      bottom: rect.bottom - viewport.offsetTop, width: viewport.width, height: viewport.height, layoutWidth: window.innerWidth, scroll: document.documentElement.scrollWidth };
  });
  assert.ok(box.left >= 7.5 && box.right <= box.width - 7.5, `${label}: menu x ${box.left}–${box.right} outside ${box.width}`);
  assert.ok(box.top >= 7.5 && box.bottom <= box.height - 7.5, `${label}: menu y ${box.top}–${box.bottom} outside ${box.height}`);
  assert.ok(box.scroll <= box.layoutWidth, `${label}: page-wide overflow ${box.scroll} > ${box.layoutWidth}`);
}

for (const change of ["Remove note remotely", "Archive remotely"] as const) {
  test(`${change} preserves unsaved note text and lets the viewer return to attachments`, async () => {
    const { context, page, errors } = await harness("case=removed-note", { width: 390, height: 664 }, "en", { isMobile: true, hasTouch: true });
    try {
      await page.getByRole("button", { name: "Comment 1: Original note", exact: true }).tap();
      const editLabel = copy("en", "editComment", { label: 1 });
      await page.getByRole("button", { name: editLabel, exact: true }).tap();
      await page.getByRole("textbox", { name: editLabel }).fill("My unsaved note text");
      await page.getByRole("button", { name: change }).click();
      const recovered = page.getByRole("textbox", { name: copy("en", "unsavedNoteText") });
      assert.equal(await recovered.inputValue(), "My unsaved note text");
      await page.getByRole("button", { name: copy("en", "closeNote") }).tap();
      await page.getByRole("alertdialog").getByRole("button", { name: copy("en", "discardChanges") }).tap();
      await recovered.waitFor({ state: "hidden" });
      const addNote = page.getByRole("button", { name: copy("en", "addPin"), exact: true });
      await addNote.waitFor({ state: change === "Remove note remotely" ? "visible" : "hidden" });
      await page.getByRole("button", { name: copy("en", "mediaNumber", { number: 2 }), exact: true }).tap();
      await page.getByRole("img", { name: "Attachment 2.png", exact: true }).waitFor();
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test("discarding an unsaved note resets the viewer when a Ticket stays open after archive", async () => {
  const { context, page, errors } = await harness("case=removed-note");
  try {
    await page.getByRole("button", { name: "Comment 1: Original note", exact: true }).click();
    const editLabel = copy("en", "editComment", { label: 1 });
    await page.getByRole("button", { name: editLabel, exact: true }).click();
    const field = page.getByRole("textbox", { name: editLabel });
    await field.fill("Do not keep this change");
    const archive = page.getByRole("button", { name: "Archive in place" });
    const confirm = page.getByRole("alertdialog", { name: copy("en", "discardNoteTitle") });
    await archive.click();
    await confirm.getByRole("button", { name: copy("en", "cancel"), exact: true }).click();
    assert.equal(await field.inputValue(), "Do not keep this change");
    await archive.click();
    await confirm.getByRole("button", { name: copy("en", "discardChanges"), exact: true }).click();
    await page.getByText("Archived", { exact: true }).waitFor();
    await field.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: copy("en", "mediaNumber", { number: 2 }), exact: true }).click();
    await page.getByRole("img", { name: "Attachment 2.png", exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("Project menu supports touch selection and stays visible at 200% pinch zoom", async () => {
  const { context, page } = await harness("case=switcher&long&align=right", { width: 390, height: 700 }, "en", { isMobile: true, hasTouch: true });
  try {
    await trigger(page).tap();
    await choices(page).first().waitFor();
    await page.touchscreen.tap(14, 400);
    await page.getByRole("menu").waitFor({ state: "hidden" });
    await trigger(page).tap();
    await choices(page).nth(1).tap();
    await page.locator("#selected").filter({ hasText: "APP" }).waitFor();
    const session = await context.newCDPSession(page);
    await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
    await trigger(page).focus();
    await page.keyboard.press("Enter");
    await choices(page).first().waitFor();
    await assertInViewport(page, "200% zoom");
  } finally { await context.close(); }
});

test("Project switcher: three Projects to two keeps the mounted menu accurate", async () => {
  const { context, page, errors } = await harness("case=switcher");
  try {
    await trigger(page).click();
    await choices(page).nth(2).waitFor();
    assert.deepEqual(await choices(page).allInnerTexts(), ["Point of Sale (POS)", "Customer App (APP)", "Field Service (FLD)"]);
    assert.equal(await page.getByRole("menuitemradio", { name: "Point of Sale (POS)" }).getAttribute("aria-checked"), "true");
    await page.keyboard.press("Escape");
    await page.getByRole("menu").waitFor({ state: "hidden" });
    assert.equal(await trigger(page).evaluate(element => element === document.activeElement), true, "Escape restores focus to the trigger");
    await trigger(page).click();
    // Simulate a reactive permission update while the popup still owns focus.
    await page.getByRole("button", { name: "Revoke POS", includeHidden: true }).evaluate(element => (element as HTMLButtonElement).click());
    await page.getByRole("menuitemradio", { name: "Point of Sale (POS)" }).waitFor({ state: "detached" });
    await choices(page).nth(1).waitFor();
    assert.deepEqual(await choices(page).allInnerTexts(), ["Customer App (APP)", "Field Service (FLD)"]);
    assert.equal(await page.getByRole("menuitemradio", { name: "Customer App (APP)" }).getAttribute("aria-checked"), "true");
    assert.equal(await page.getByRole("menuitemradio", { name: "Point of Sale (POS)" }).count(), 0);
    // Keyboard selection: ArrowDown moves to the third Project, Enter selects it.
    await page.getByRole("menuitemradio", { name: "Customer App (APP)" }).focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.locator("#selected").filter({ hasText: "FLD" }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("Project switcher: Create Project stays a distinct action", async () => {
  const { context, page } = await harness("case=switcher&create");
  try {
    await trigger(page).click();
    const create = page.getByRole("menuitem", { name: `${copy("en", "newProject")}…`, exact: true });
    await create.focus();
    await page.keyboard.press("Enter");
    await page.locator("#created").filter({ hasText: "1" }).waitFor();
    assert.equal(await page.locator("#selected").innerText(), "");
    await create.waitFor({ state: "hidden" });
    await trigger(page).click();
    await choices(page).last().waitFor();
    assert.equal(await choices(page).count(), 3);
    assert.equal(await choices(page).first().getAttribute("aria-checked"), "true");
  } finally { await context.close(); }
});

for (const width of [320, 375, 390, 768, 1280]) for (const align of ["left", "right"] as const) {
  test(`Project menu stays inside the viewport at ${width} px from the ${align} edge with a long Thai name`, async () => {
    const { context, page } = await harness(`case=switcher&long&align=${align}`, { width, height: 700 }, "th");
    try {
      await trigger(page, "th").click();
      await choices(page).first().waitFor();
      await assertInViewport(page, `${width}/${align}`);
      // Reduced motion: the popup is fully opaque at once (no fade-in).
      assert.equal(await page.getByRole("menu").evaluate(element => getComputedStyle(element).opacity), "1");
      if (width === 320 || width === 1280) await shot(page, `project-menu-${width}-${align}`);
    } finally { await context.close(); }
  });
}

for (const theme of ["light", "dark"] as const) for (const width of [320, 390, 639, 640]) {
  test(`Ticket rows ${theme} ${width} px: one status mark per row below 640 px and a written status from 640 px`, async () => {
    const { context, page, errors } = await harness(`case=rows&theme=${theme}`, { width, height: 900 });
    try {
      const rows = page.locator("button[data-ticket-id]");
      assert.equal(await rows.count(), 5);
      for (const [index, status] of (["new", "acknowledged", "inProgress", "waiting", "done"] as const).entries()) {
        const row = rows.nth(index);
        const name = await row.getAttribute("aria-label");
        const written = status === "waiting" ? copy("en", "customerQueueWaiting") : copy("en", status);
        assert.ok(name?.endsWith(`, ${written}`), `accessible name carries the status: ${name}`);
        const dots = await row.locator("[data-status-dot]").evaluateAll(marks => marks.filter(mark => mark.getClientRects().length > 0).length);
        const label = await row.locator("[data-status-label]").evaluateAll(marks => marks.filter(mark => mark.getClientRects().length > 0).length);
        const excerpt = await row.locator("[data-ticket-excerpt]").evaluateAll(marks => marks.filter(mark => mark.getClientRects().length > 0).length);
        const activity = await row.locator("[data-ticket-activity]").evaluateAll(marks => marks.filter(mark => mark.getClientRects().length > 0).length);
        assert.equal(activity, 1, `row ${index} shows when it last moved at ${width}`);
        const request = await row.getByText(copy("en", "feedNeedsReply"), { exact: true }).count();
        assert.equal(request, status === "waiting" ? 1 : 0, `only the open question asks for a reply (row ${index})`);
        if (width < 640) assert.deepEqual({ dots, label, excerpt }, { dots: 1, label: 0, excerpt: 1 }, `row ${index} at ${width}`);
        else assert.deepEqual({ dots, label, excerpt }, { dots: 0, label: 1, excerpt: 1 }, `row ${index} at ${width}`);
      }
      // Five distinct shapes: each mark's drawing differs from the others.
      const shapes = await page.locator("svg[data-status-dot]").evaluateAll(marks => [...new Set(marks.map(mark => mark.innerHTML))].length);
      assert.equal(shapes, 5);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, `no page-wide overflow (${overflow})`);
      if (width === 390 || width === 640) await shot(page, `rows-${theme}-${width}`);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test("Ticket rows: forced colors and grayscale keep every mark visible and focus returns to the row", async () => {
  const { context, page } = await harness("case=rows", { width: 390, height: 900 });
  try {
    await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
    const marks = page.locator("svg[data-status-dot]");
    for (let index = 0; index < 5; index++) {
      const painted = await marks.nth(index).evaluate(svg => [...svg.querySelectorAll("circle,path")].some(shape => {
        const style = getComputedStyle(shape);
        return (style.stroke !== "none" && style.stroke !== "rgba(0, 0, 0, 0)") || (style.fill !== "none" && style.fill !== "rgba(0, 0, 0, 0)");
      }));
      assert.ok(painted, `mark ${index} paints in forced colors`);
    }
    await shot(page, "rows-forced-colors-390");
    await page.emulateMedia({ forcedColors: "none" });
    await page.addStyleTag({ content: "html{filter:grayscale(1)}" });
    await shot(page, "rows-grayscale-390");
    const row = page.locator("button[data-ticket-id]").nth(3);
    await row.focus();
    await page.keyboard.press("Enter");
    assert.equal(await row.getAttribute("aria-current"), "true");
    assert.equal(await row.evaluate(element => element === document.activeElement), true);
  } finally { await context.close(); }
});

for (const theme of ["light", "dark"] as const) test(`notifications ${theme}: two status updates keep independently bound Undo actions`, async () => {
  const { context, page, errors } = await harness(`case=notices&theme=${theme}`, { width: 390, height: 800 }, "en", {
    hasTouch: true, isMobile: true, reducedMotion: "no-preference",
  });
  try {
    await page.getByRole("button", { name: "Update two Tickets", exact: true }).click();
    const notices = page.locator("[data-sonner-toast]");
    const undoFor = (ticket: string) => notices.filter({ hasText: ticket }).getByRole("button", { name: copy("en", "undo"), exact: true });
    const undo = undoFor("POS-0002");
    await page.waitForFunction(() => document.querySelectorAll("[data-sonner-toast]").length === 2);
    const undoBox = await undo.first().boundingBox();
    assert.ok(undoBox && undoBox.width >= 44 && undoBox.height >= 44, "Undo has a 44 px touch target");
    const transition = await undo.first().evaluate(element => getComputedStyle(element.closest("[data-sonner-toast]")!).transitionProperty);
    assert.doesNotMatch(transition, /opacity|\ball\b/, "Undo stays at full contrast while its notice moves");
    // The toast surface is neutral: no rich-colour background for success.
    const surface = await page.locator("[data-sonner-toast]").first().evaluate(element => getComputedStyle(element).backgroundColor);
    assert.doesNotMatch(surface, /rgb\(236, 253, 243\)/);
    await shot(page, `notices-${theme}-390`);
    // The newest toast is first; each Undo calls only its own Ticket's event.
    await undoFor("POS-0002").click();
    await page.locator("#undone").filter({ hasText: /^event-B-\d+$/ }).waitFor();
    await undoFor("POS-0001").click();
    await page.locator("#undone").filter({ hasText: /^event-B-\d+,event-A-\d+$/ }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("Project menu flips above a trigger near the bottom of a short viewport", async () => {
  const { context, page } = await harness("case=switcher&align=right", { width: 390, height: 300 });
  try {
    await page.getByRole("region", { name: "Switcher harness" }).evaluate(element => {
      Object.assign(element.style, { position: "fixed", bottom: "8px", right: "8px", width: "auto" });
    });
    await trigger(page).click();
    const popup = page.getByRole("menu");
    await popup.waitFor();
    await assertInViewport(page, "bottom edge");
    const anchor = await trigger(page).boundingBox();
    const menu = await popup.boundingBox();
    assert.ok(anchor && menu && menu.y + menu.height <= anchor.y, "menu opens above the trigger");
  } finally { await context.close(); }
});

test("staff phone menu returns focus after Team and detail actions have touch targets", async () => {
  const device = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 700 } };
  const { context, page } = await openWith(await browsers.get(), "staff", "en", undefined, device);
  try {
    const close = page.getByRole("button", { name: copy("en", "closeDialog"), exact: true });
    await close.tap();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    const more = page.getByRole("button", { name: copy("en", "queueMore"), exact: true });
    await more.tap();
    await page.getByRole("menuitem", { name: copy("en", "teamTitle"), exact: true }).tap();
    const team = page.getByRole("dialog", { name: copy("en", "teamTitle"), exact: true });
    await team.waitFor();
    await close.tap();
    await team.waitFor({ state: "hidden" });
    await page.waitForFunction(element => element === document.activeElement, await more.elementHandle());
    await page.getByRole("button", { name: copy("en", "queueLabel"), exact: true }).tap();
    await page.locator("button[data-ticket-id]:visible").first().tap();
    const edit = page.getByRole("button", { name: copy("en", "edit"), exact: true });
    await edit.waitFor();
    const detail = edit.locator("..");
    for (const button of [edit, detail.getByRole("button", { name: / · [A-Z]+-\d+$/ })]) {
      const bounds = await button.boundingBox();
      assert.ok(bounds && bounds.width >= 44 && bounds.height >= 44, "detail action has a 44 px touch target");
    }
  } finally { await context.close(); }
});

test("media upload nested drag/drop cue stays synchronized across nested leaves, null relatedTarget, external exits, and drop", async () => {
  const { context, page, errors } = await harness("case=media-upload-drag");
  try {
    const region = page.getByRole("region", { name: "Media upload drag harness" });
    const dropCue = region.locator('[data-drop-cue="active"]');
    const dispatchDrag = (selector: string, type: string, relatedSelector?: string | null) =>
      page.evaluate(({ selector, type, relatedSelector }) => {
        const target = document.querySelector(selector);
        if (!target) throw new Error("Missing drag target " + selector);
        const relatedTarget = relatedSelector ? document.querySelector(relatedSelector) : null;
        target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, relatedTarget }));
      }, { selector, type, relatedSelector });

    const dropRootSelector = '[aria-label="Media upload drag harness"] [data-slot="media-upload-dropzone"]';
    const nestedBtnSelector = dropRootSelector + ' [data-slot="sortable-item"] button:has(img)';
    const nestedImgSelector = nestedBtnSelector + " img";

    // Enter container -> enter nested child -> leave container to nested child: cue stays active.
    await dispatchDrag(dropRootSelector, "dragenter");
    await dropCue.waitFor({ state: "visible" });
    await dispatchDrag(nestedBtnSelector, "dragenter", dropRootSelector);
    await dispatchDrag(dropRootSelector, "dragleave", nestedBtnSelector);
    assert.equal(await dropCue.isVisible(), true);

    // Nested dragenter + dragleave with relatedTarget=null keeps depth > 0 and cue active.
    await dispatchDrag(nestedImgSelector, "dragenter", null);
    await dispatchDrag(nestedBtnSelector, "dragleave", null);
    assert.equal(await dropCue.isVisible(), true);
    await shot(page, "media-drag-cue-active");

    // Leaving to an external sibling clears the cue immediately without getting stuck.
    await dispatchDrag(nestedImgSelector, "dragleave", "#outside-drop-peer");
    await dropCue.waitFor({ state: "hidden" });

    // Re-enter once and leave with relatedTarget=null clears cleanly when depth reaches 0.
    await dispatchDrag(dropRootSelector, "dragenter", null);
    await dropCue.waitFor({ state: "visible" });
    await dispatchDrag(dropRootSelector, "dragleave", null);
    await dropCue.waitFor({ state: "hidden" });

    // Dropping a valid image clears the cue and adds the file.
    await dispatchDrag(dropRootSelector, "dragenter", null);
    await dropCue.waitFor({ state: "visible" });
    await page.evaluate((selector) => {
      const target = document.querySelector(selector)!;
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], "dropped.png", { type: "image/png" }));
      target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, dropRootSelector);
    await dropCue.waitFor({ state: "hidden" });
    await page.locator("#upload-count").filter({ hasText: "3" }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("camera capture encodes JPEG once per shot, reuses Blob URL preview, and releases on retake, use, and cancel", async () => {
  const context = await newContext(await browsers.get(), {
    reducedMotion: "reduce",
    permissions: ["camera"],
    viewport: { width: 1280, height: 900 },
  });
  await context.addInitScript(() => {
    localStorage.setItem("ease-pos-tracking-language", "en");
    const stats = { toDataURL: 0, toBlob: 0, created: [] as string[], revoked: [] as string[] };
    Object.assign(window, { __cameraStats: stats });
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      stats.toDataURL += 1;
      return origToDataURL.apply(this, args);
    };
    const origToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      stats.toBlob += 1;
      return origToBlob.call(this, callback, type, quality);
    };
    const origCreate = URL.createObjectURL.bind(URL);
    const origRevoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = origCreate(blob);
      stats.created.push(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      stats.revoked.push(url);
      origRevoke(url);
    };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    const labels = mediaUxCopy("en");
    await page.goto(`${baseURL}/tests/browser/components.html?case=camera-capture`);
    const readStats = () => page.evaluate(() => (window as unknown as { __cameraStats: { toDataURL: number; toBlob: number; created: string[]; revoked: string[] } }).__cameraStats);

    await page.getByRole("button", { name: "Open camera", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: copy("en", "camera"), exact: true });
    const takePhoto = dialog.getByRole("button", { name: copy("en", "takePhoto"), exact: true });
    await page.waitForFunction(() => {
      const btn = [...document.querySelectorAll("button")].find(el => el.textContent?.trim() === "Take photo");
      return Boolean(btn && !btn.hasAttribute("disabled"));
    });
    const preview = dialog.getByRole("img", { name: labels.capturedPreview, exact: true });

    // Two activations in the same task must produce one JPEG and one preview.
    await takePhoto.evaluate(element => {
      const button = element as HTMLButtonElement;
      button.click();
      button.click();
    });
    await preview.waitFor();
    await shot(page, "media-camera-review");
    assert.match((await preview.getAttribute("src")) ?? "", /^blob:/);
    const afterShot1 = await readStats();
    assert.equal(afterShot1.toDataURL, 0);
    assert.equal(afterShot1.toBlob, 1);
    assert.equal(afterShot1.created.length, 1);
    assert.equal(afterShot1.revoked.length, 0);
    assert.equal(await page.locator("#captured-files").textContent(), "");

    // Retake releases the first preview URL.
    await dialog.getByRole("button", { name: labels.retakePhoto, exact: true }).click();
    await preview.waitFor({ state: "hidden" });
    const afterRetake = await readStats();
    assert.deepEqual(afterRetake.revoked, afterRetake.created);
    assert.equal(await page.locator("#captured-files").textContent(), "");

    // Shot 2 + Use photo encodes once more and releases preview URL on approval.
    await takePhoto.click();
    await preview.waitFor();
    await dialog.getByRole("button", { name: labels.usePhoto, exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    const afterUse = await readStats();
    assert.equal(afterUse.toDataURL, 0);
    assert.equal(afterUse.toBlob, 2);
    assert.deepEqual(afterUse.revoked, afterUse.created);
    await page.locator("#captured-files").filter({ hasText: "image/jpeg" }).waitFor();
    const approved = await page.locator("#captured-files").textContent();

    // Shot 3 + Cancel releases preview URL on dismiss.
    await page.getByRole("button", { name: "Open camera", exact: true }).click();
    await page.waitForFunction(() => {
      const btn = [...document.querySelectorAll("button")].find(el => el.textContent?.trim() === "Take photo");
      return Boolean(btn && !btn.hasAttribute("disabled"));
    });
    await takePhoto.click();
    await preview.waitFor();
    await dialog.getByRole("button", { name: copy("en", "cancel"), exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    const afterCancel = await readStats();
    assert.equal(afterCancel.toDataURL, 0);
    assert.equal(afterCancel.toBlob, 3);
    assert.deepEqual(afterCancel.revoked, afterCancel.created);
    assert.equal(await page.locator("#captured-files").textContent(), approved);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("grouped timeline note close and Escape restore focus to the originating group trigger even for timestamp-only entries after rerender", async () => {
  const { context, page, errors } = await harness("case=viewer-grouped-video", { width: 320, height: 740 }, "en", { hasTouch: true });
  try {
    const groupTrigger = page.locator("button[data-pin-group]").first();
    await groupTrigger.waitFor();
    await groupTrigger.focus();
    await page.keyboard.press("Enter");

    // Pick timestamp-only entry (no x/y overlay PinMarker) via keyboard.
    const group = page.getByRole("region", { name: /3 notes near/ });
    const timeOnlyBtn = group.getByRole("button", { name: /Timestamp-only grouped note/ });
    await timeOnlyBtn.waitFor();
    assert.equal(await group.getByRole("listitem").count(), 3);
    await shot(page, "media-timeline-expanded-320");
    for (let tab = 0; tab < 10 && !await timeOnlyBtn.evaluate(el => el === document.activeElement); tab++) {
      await page.keyboard.press("Tab");
    }
    assert.equal(await timeOnlyBtn.evaluate(el => el === document.activeElement), true);
    await page.keyboard.press("Enter");

    const details = page.locator("[data-note-details]");
    await details.getByText("Timestamp-only grouped note", { exact: true }).waitFor();
    assert.equal(await page.locator('button[data-pin-id="grp-time-only"]').count(), 0);
    await page.waitForFunction(() => Boolean(document.activeElement?.closest("[data-note-details]")));

    // Force a parent rerender with cloned annotations before closing with Escape.
    await page.evaluate(() => (window as unknown as { __bumpMediaHarness?: () => void }).__bumpMediaHarness?.());
    await page.locator("#harness-revision").filter({ hasText: "1" }).waitFor();
    await page.keyboard.press("Escape");
    await details.waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.hasAttribute("data-pin-group") === true);

    // Repeat with pinned grouped note and explicit Close note button after another rerender.
    await page.keyboard.press("Enter");
    const pinnedBtn = group.getByRole("button", { name: /Pinned video note/ });
    await pinnedBtn.waitFor();
    await pinnedBtn.tap();
    await details.getByText("Pinned video note", { exact: true }).waitFor();
    await page.evaluate(() => (window as unknown as { __bumpMediaHarness?: () => void }).__bumpMediaHarness?.());
    await page.locator("#harness-revision").filter({ hasText: "2" }).waitFor();
    await details.getByRole("button", { name: copy("en", "closeNote"), exact: true }).click();
    await details.waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.hasAttribute("data-pin-group") === true);
    await page.keyboard.press("Enter");
    await group.getByRole("button", { name: /Third grouped note/ }).tap();
    await details.getByText("Third grouped note", { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("offscreen thumbnails are inert and excluded from keyboard while visible thumbnails and main next/prev stay accessible", async () => {
  const { context, page, errors } = await harness("case=viewer-thumbnails", { width: 320, height: 640 });
  try {
    // Wait for Embla IntersectionObserver to mark offscreen slides inert.
    await page.waitForFunction(() => {
      const thumbButtons = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Show media "]')];
      return thumbButtons.length === 8 && thumbButtons.some(btn => btn.closest("[inert]")) && thumbButtons.some(btn => !btn.closest("[inert]"));
    });

    const thumb1 = page.getByRole("button", { name: copy("en", "mediaNumber", { number: 1 }), exact: true });
    const thumb8 = page.locator(`button[aria-label="${copy("en", "mediaNumber", { number: 8 })}"]`);
    assert.equal(await thumb1.evaluate(el => Boolean(el.closest("[inert]"))), false);
    assert.equal(await thumb8.evaluate(el => Boolean(el.closest("[inert]"))), true);
    assert.equal(await thumb8.evaluate(el => el.closest('[aria-roledescription="slide"]')?.getAttribute("aria-hidden")), "true");

    // Visible thumbnail accepts keyboard focus; offscreen thumbnail refuses focus because it is inert.
    await thumb1.focus();
    assert.equal(await thumb1.evaluate(el => document.activeElement === el), true);
    await shot(page, "media-thumbnails-focus-320");
    assert.equal(await thumb8.evaluate(el => { (el as HTMLButtonElement).focus(); return document.activeElement === el; }), false);
    const thumbnailButtons = page.locator('button[aria-label^="Show media "]');
    let thumbnailTabs = 0;
    for (let tab = 0; tab < 8; tab++) {
      const visibleBefore = await thumbnailButtons.evaluateAll(buttons => buttons
        .filter(button => !button.closest("[inert]"))
        .map(button => button.getAttribute("aria-label")));
      await page.keyboard.press("Tab");
      const focusedThumbnail = await page.evaluate(() => document.activeElement?.matches('button[aria-label^="Show media "]')
        ? document.activeElement.getAttribute("aria-label") : null);
      if (focusedThumbnail) {
        thumbnailTabs++;
        assert.ok(visibleBefore.includes(focusedThumbnail), `${focusedThumbnail} was visible before receiving focus`);
      }
    }
    assert.ok(thumbnailTabs > 0);


    // Main carousel Next control remains accessible and advances through slides to reveal offscreen thumbnails.
    const next = page.getByRole("button", { name: copy("en", "nextSlide"), exact: true });
    assert.equal(await next.evaluate(el => Boolean(el.closest("[inert]"))), false);
    await next.focus();
    assert.equal(await next.evaluate(el => document.activeElement === el), true);
    for (let step = 0; step < 7; step++) {
      await next.click();
    }
    await page.getByText("8 / 8", { exact: true }).waitFor();
    await page.waitForFunction((label8) => {
      const el = document.querySelector<HTMLButtonElement>(`button[aria-label="${label8}"]`);
      return Boolean(el && !el.closest("[inert]"));
    }, copy("en", "mediaNumber", { number: 8 }));
    assert.equal(await thumb8.evaluate(el => { (el as HTMLButtonElement).focus(); return document.activeElement === el; }), true);
    assert.equal(await page.locator(`button[aria-label="${copy("en", "mediaNumber", { number: 1 })}"]`).evaluate(el => Boolean(el.closest("[inert]"))), true);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("corner pin overlays stay unclipped inside carousel bounds at 320 px and 200% zoom", async () => {
  const { context, page, errors } = await harness("case=viewer-corner-pins", { width: 320, height: 568 });
  try {
    await page.locator('button[data-pin-id="corner-br"]').waitFor();
    async function assertCornerPinsUnclipped(label: string) {
      const check = await page.evaluate(() => {
        const clip = document.querySelector('[aria-roledescription="carousel"] > div')!.getBoundingClientRect();
        const pins = [...document.querySelectorAll<HTMLElement>("button[data-pin-id]")].map(el => {
          const r = el.getBoundingClientRect();
          return { id: el.dataset.pinId, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        });
        return {
          clip: { left: clip.left, right: clip.right, top: clip.top, bottom: clip.bottom },
          pins,
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        };
      });
      assert.ok(check.scrollWidth <= check.innerWidth, `${label}: horizontal overflow ${check.scrollWidth} > ${check.innerWidth}`);
      assert.equal(check.pins.length, 4);
      for (const pin of check.pins) {
        assert.ok(pin.left >= check.clip.left - 0.5, `${label} ${pin.id}: left ${pin.left} < ${check.clip.left}`);
        assert.ok(pin.right <= check.clip.right + 0.5, `${label} ${pin.id}: right ${pin.right} > ${check.clip.right}`);
        assert.ok(pin.top >= check.clip.top - 0.5, `${label} ${pin.id}: top ${pin.top} < ${check.clip.top}`);
        assert.ok(pin.bottom <= check.clip.bottom + 0.5, `${label} ${pin.id}: bottom ${pin.bottom} > ${check.clip.bottom}`);
      }
    }

    const cornerPins = [
      ["tl", "Top-left"],
      ["tr", "Top-right"],
      ["bl", "Bottom-left"],
      ["br", "Bottom-right"],
    ];
    const session = await context.newCDPSession(page);
    for (const zoom of [1, 2]) {
      await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: zoom });
      await page.waitForFunction(scale => window.visualViewport?.scale === scale, zoom);
      for (const [id, name] of cornerPins) {
        const marker = page.locator(`button[data-pin-id="corner-${id}"]`);
        await marker.press("Enter");
        const details = page.locator("[data-note-details]");
        await details.getByText(`${name} corner note`, { exact: true }).waitFor();
        const label = `320px ${zoom * 100}% ${name}`;
        await assertCornerPinsUnclipped(label);
        const actions = await details.getByRole("button").evaluateAll(buttons => buttons.map(button => {
          const rect = button.getBoundingClientRect();
          return rect.left >= 0 && rect.right <= window.innerWidth + 0.5
            && rect.top >= 0 && rect.bottom <= window.innerHeight + 0.5;
        }));
        assert.equal(actions.length, 4, `${label}: all note actions rendered`);
        assert.ok(actions.every(Boolean), `${label}: every note action lies inside the layout viewport`);
        const close = details.getByRole("button", { name: copy("en", "closeNote"), exact: true });
        if (id === "tl") {
          await close.focus();
          await shot(page, `media-corner-note-320-zoom-${zoom * 100}`);
        }
        await close.press("Enter");
        await details.waitFor({ state: "hidden" });
        // Closing a note returns focus on the next frame. Let that finish before activating another pin.
        await page.waitForFunction(button => document.activeElement === button, await marker.elementHandle());
      }
    }
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("delayed note save prevents duplicate submissions and preserves draft text for inline retry after failure", async () => {
  const { context, page, errors } = await harness("case=viewer-delayed-save");
  try {
    await page.getByRole("button", { name: copy("en", "addPin"), exact: true }).click();
    await page.locator("img[data-pin-surface]").click({ position: { x: 40, y: 40 } });
    const textarea = page.getByPlaceholder(copy("en", "describeIssue"));
    await textarea.fill("Delayed note survives failure");

    const saveBtn = page.getByRole("button", { name: copy("en", "savePin"), exact: true });
    await saveBtn.click();
    // Attempt a rapid second click while in-flight; button must be disabled and only 1 call dispatched.
    assert.equal(await saveBtn.isDisabled(), true);
    await saveBtn.evaluate(el => (el as HTMLButtonElement).click());
    await page.locator("#save-calls").filter({ hasText: "1" }).waitFor();

    // Fail the first attempt: error renders inline and draft text remains intact.
    await page.evaluate(() => (window as unknown as { __mediaSaveControl?: { rejectNext: (m: string) => void } }).__mediaSaveControl?.rejectNext("Temporary save failure"));
    await page.getByRole("alert").filter({ hasText: copy("en", "genericError") }).waitFor();
    assert.equal(await textarea.inputValue(), "Delayed note survives failure");
    assert.equal(await saveBtn.isDisabled(), false);
    await shot(page, "media-note-save-retry");

    // Retry succeeds and creates the pin.
    await saveBtn.click();
    await page.locator("#save-calls").filter({ hasText: "2" }).waitFor();
    await page.evaluate(() => (window as unknown as { __mediaSaveControl?: { resolveNext: () => void } }).__mediaSaveControl?.resolveNext());
    await textarea.waitFor({ state: "hidden" });
    await page.locator('button[data-pin-id="saved-1"]').waitFor();
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
