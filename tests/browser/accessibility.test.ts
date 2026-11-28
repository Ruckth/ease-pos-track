import { markupLabels } from "../../src/lib/markup-labels";
// Keyboard and axe checks for the Ticket states people use most. Each scan
// runs after the state opens; persisted-state assertions stay with behavior.
import assert from "node:assert/strict";
import { after, test as nodeTest } from "node:test";
import type { Locator, Page } from "playwright";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { axeFindings, expectAccessible } from "./a11y";
import { capture } from "../../scripts/browser-evidence";
import { convex, copy, files, openHeaderMenu, suiteBrowser, open as openWith, type Language } from "./harness";

const browsers = suiteBrowser();
after(() => browsers.close());
const open = async (role: "staff" | "customer", language?: Language) => openWith(await browsers.get(), role, language);
const test = (name: string, run: () => Promise<void>) => nodeTest(name, () => capture("accessibility", name, run));

const isFocused = (locator: Locator) => locator.evaluate(element => element === document.activeElement);
async function focusStaysInside(page: Page, dialog: Locator, key: "Tab" | "Shift+Tab", presses = 25) {
  for (let index = 0; index < presses; index++) {
    await page.keyboard.press(key);
    // Base UI routes Tab through hidden focus guards that redirect on the next frame.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const inside = await dialog.evaluate(element => element.contains(document.activeElement));
    if (!inside) assert.fail(`${key} #${index + 1} left the dialog; focus is on ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 300))}`);
  }
}

test("axe configuration reports a deliberately unnamed control", async () => {
  const { page, context } = await open("staff");
  try {
    await page.getByRole("dialog").evaluate(dialog => {
      const button = document.createElement("button");
      button.setAttribute("data-a11y-canary", "");
      dialog.append(button);
    });
    const { findings } = await axeFindings(page, "canary");
    assert.ok(findings.some(finding => finding.rule === "button-name" && finding.targets.some(target => target.includes("data-a11y-canary"))),
      `button-name not reported: ${JSON.stringify(findings)}`);
  } finally { await context.close(); }
});

for (const [role, language] of [["staff", "en"], ["customer", "th"]] as const) {
  test(`${role} ${language}: Ticket inbox puts updates before keyboard-accessible notification settings`, async () => {
    const { page, context, errors } = await open(role, language);
    try {
      await page.getByRole("dialog").getByRole("button", { name: copy(language, "closeDialog") }).click();
      const trigger = page.getByRole("button", { name: copy(language, "ticketInbox"), exact: true });
      await trigger.press("Enter");
      const inbox = page.getByRole("dialog", { name: copy(language, "ticketInbox"), exact: true });
      const updates = inbox.getByRole("region", { name: copy(language, "inboxUpdates"), exact: true });
      const settings = inbox.locator("summary").filter({ hasText: copy(language, "inboxSettings") });
      await updates.waitFor();
      const summary = await settings.elementHandle();
      assert.ok(await updates.evaluate((element, control) => element.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING, summary));
      assert.equal(await inbox.getByRole("checkbox").count(), 0);
      await settings.press("Enter");
      const firstPreference = inbox.getByRole("checkbox", { name: copy(language, role === "staff" ? "inboxIntake" : "statusInboxPreference"), exact: true });
      await firstPreference.waitFor();
      await page.waitForFunction(element => element instanceof HTMLInputElement && !element.disabled, await firstPreference.elementHandle());
      assert.equal(await inbox.getByRole("checkbox").count(), role === "staff" ? 2 : 1);
      await page.keyboard.press("Tab");
      assert.equal(await isFocused(firstPreference), true);
      await expectAccessible(page, `${role} ${language} Ticket inbox settings`);
      await page.keyboard.press("Escape");
      await inbox.waitFor({ state: "hidden" });
      await page.waitForFunction(element => element === document.activeElement, await trigger.elementHandle());
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

for (const [role, language] of [["staff", "en"], ["customer", "th"]] as const) {
  test(`${role} ${language}: keyboard-only Ticket creation recovers from a validation error with predictable focus`, async () => {
    const { page, context, title, token, errors, uploads } = await open(role, language);
    try {
      const composer = page.getByRole("dialog", { name: copy(language, "newTicket"), exact: true });
      assert.equal(await composer.evaluate(element => getComputedStyle(element).colorScheme), role === "staff" ? "dark" : "light");
      await expectAccessible(page, `${role} ${language} composer`);
      // Escape closes the composer and focus returns to its trigger.
      await page.keyboard.press("Escape");
      await composer.waitFor({ state: "hidden" });
      const trigger = page.getByRole("button", { name: copy(language, "newTicket"), exact: true }).first();
      await page.waitForFunction(element => element === document.activeElement, await trigger.elementHandle());
      await page.keyboard.press("Enter");
      await composer.waitFor();
      await page.waitForFunction(() => document.activeElement?.tagName === "INPUT");
      assert.equal(await isFocused(title), true, "Opening the composer focuses the title");
      // Tab and Shift+Tab stay inside the modal.
      await focusStaysInside(page, composer, "Tab");
      await focusStaysInside(page, composer, "Shift+Tab");
      await title.focus();
      // Implicit submission with an empty title reports the error on the field.
      await page.keyboard.press("Enter");
      await page.waitForFunction(element => element?.getAttribute("aria-invalid") === "true", await title.elementHandle());
      assert.equal(await isFocused(title), true, "Validation keeps focus on the invalid title");
      const describedBy = await title.getAttribute("aria-describedby");
      assert.ok(describedBy, "The invalid title references its error");
      assert.equal(await page.locator(`[id="${describedBy}"]`).innerText(), copy(language, "requiredTitle"));
      await expectAccessible(page, `${role} ${language} composer validation`);
      const name = `Keyboard ${role} ${language} ${crypto.randomUUID()}`;
      await page.keyboard.type(name);
      assert.equal(await title.getAttribute("aria-invalid"), null, "Typing clears the invalid state");
      await page.keyboard.press("Enter");
      const receipt = composer.getByRole("heading", { name: /POS-\d+/ });
      await receipt.waitFor();
      assert.equal(await isFocused(receipt), true, "Confirmation focuses the Ticket receipt");
      await page.keyboard.press("Tab");
      const view = composer.getByRole("button", { name: language === "th" ? "ดู Ticket" : "View Ticket", exact: true });
      assert.equal(await isFocused(view), true);
      await page.keyboard.press("Enter");
      await composer.waitFor({ state: "hidden" });
      await page.waitForFunction(() => new URL(location.href).searchParams.has("ticket"));
      const id = new URL(page.url()).searchParams.get("ticket") as Id<"tickets">;
      assert.equal((await convex.query(api.tickets.getTicket, { token, id }))?.title, name);
      assert.equal(uploads(), 0);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

for (const [role, language] of [["staff", "en"], ["customer", "th"]] as const) {
  test(`${role} ${language}: media dialog passes axe and Escape returns focus to the file`, async () => {
    const { page, context, errors, uploads } = await open(role, language);
    try {
      await files(page);
      const preview = page.getByRole("button", { name: copy(language, "openMedia", { name: "draft.png" }), exact: true });
      await preview.focus();
      await page.keyboard.press("Enter");
      const media = page.getByRole("dialog", { name: "draft.png", exact: true });
      await media.getByRole("button", { name: copy(language, "addPin"), exact: true }).waitFor();
      await expectAccessible(page, `${role} ${language} media dialog`);
      await focusStaysInside(page, media, "Tab", 15);
      const edit = media.getByRole("button", { name: copy(language, "editDraftImage"), exact: true });
      await edit.focus();
      await page.keyboard.press("Enter");
      const editor = page.getByRole("dialog", { name: copy(language, "editDraftImage"), exact: true });
      const labels = markupLabels(language);
      const area = editor.getByRole("application", { name: labels.canvasLabel });
      await area.focus();
      await area.press("Enter");
      const sizeSlider = editor.getByRole("slider", { name: labels.circleSize, exact: true });
      await sizeSlider.waitFor();
      const initialSize = Number(await sizeSlider.inputValue());
      await sizeSlider.focus();
      await sizeSlider.press("ArrowUp");
      const grownSize = Number(await sizeSlider.inputValue());
      assert.ok(grownSize > initialSize, `slider ArrowUp grew circle (${initialSize} -> ${grownSize})`);
      await sizeSlider.press("Control+z");
      assert.equal(Number(await sizeSlider.inputValue()), initialSize);
      await sizeSlider.press("Control+Shift+z");
      assert.equal(Number(await sizeSlider.inputValue()), grownSize);
      await sizeSlider.press("ArrowDown");
      assert.ok(Number(await sizeSlider.inputValue()) < grownSize, "slider ArrowDown shrank circle");
      const fineTune = editor.getByRole("button", { name: labels.fineTune, exact: true });
      assert.equal(await fineTune.getAttribute("aria-expanded"), "false");
      const width = editor.getByRole("spinbutton", { name: `${labels.width} (px)`, exact: true });
      assert.equal(await width.count(), 0);
      assert.equal(await editor.getByRole("group", { name: labels.outline, exact: true }).count(), 0);
      await expectAccessible(page, `${role} ${language} image editor`);
      await fineTune.focus();
      await fineTune.press("Enter");
      assert.equal(await fineTune.getAttribute("aria-expanded"), "true");
      await editor.getByRole("group", { name: labels.outline, exact: true }).waitFor();
      const pixels = Number(await width.inputValue());
      await width.press("ArrowUp");
      assert.equal(Number(await width.inputValue()), pixels + 1);
      await expectAccessible(page, `${role} ${language} image editor fine-tune`);
      await editor.getByRole("button", { name: labels.review, exact: true }).press("Enter");
      await editor.getByRole("img", { name: labels.reviewTitle }).waitFor();
      await expectAccessible(page, `${role} ${language} edited attachment review`);
      await page.keyboard.press("Escape");
      await page.getByRole("alertdialog", { name: copy(language, "discardImageTitle") })
        .getByRole("button", { name: copy(language, "discardChanges"), exact: true }).press("Enter");
      await editor.waitFor({ state: "hidden" });
      await page.waitForFunction(element => element === document.activeElement, await edit.elementHandle());
      await page.keyboard.press("Escape");
      await media.waitFor({ state: "hidden" });
      await page.waitForFunction(element => element === document.activeElement, await preview.elementHandle());
      assert.equal(uploads(), 0);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

for (const language of ["en", "th"] as const) {
  test(`staff ${language}: archived Ticket details and Operations health pass axe`, async () => {
    const { page, context, token, errors } = await open("staff", language);
    try {
      const name = `Archived a11y ${language} ${crypto.randomUUID()}`;
      const { ticket } = await convex.mutation(api.tickets.createTextTicket, { token, projectKey: "POS", title: name, description: "Synthetic", requestId: crypto.randomUUID() });
      await convex.mutation(api.tickets.archiveTicket, { token, id: ticket._id, expectedVersion: ticket.version });
      await page.getByRole("button", { name: copy(language, "closeDialog"), exact: true }).click();
      await page.getByRole("button", { name: copy(language, "queueLabel"), exact: true }).click();
      await page.getByPlaceholder(copy(language, "search"), { exact: true }).fill(name);
      await openHeaderMenu(page, copy(language, "queueMore"));
      await page.getByRole("menuitemradio", { name: copy(language, "archive"), exact: true }).click();
      const row = page.locator(`button[data-ticket-id="${ticket._id}"]:visible`);
      await row.focus();
      await page.keyboard.press("Enter");
      // The Queue view shows details inline as a labelled region.
      const details = page.getByRole("region", { name, exact: true });
      await details.getByRole("button", { name: copy(language, "restore"), exact: true }).waitFor();
      assert.equal(await details.getByRole("button", { name: copy(language, "edit"), exact: true }).count(), 0);
      await expectAccessible(page, `staff ${language} archived details`);
      await details.getByRole("button", { name: copy(language, "detailBack"), exact: true }).press("Enter");
      await details.waitFor({ state: "hidden" });
      await page.waitForFunction(id => document.activeElement?.getAttribute("data-ticket-id") === id, ticket._id);

      await openHeaderMenu(page, copy(language, "queueMore"));
      await page.getByRole("menuitem", { name: copy(language, "healthTitle"), exact: true }).click();
      const health = page.getByRole("dialog", { name: copy(language, "healthTitle"), exact: true });
      await health.locator("summary").filter({ hasText: copy(language, "healthConfiguration") }).waitFor();
      await expectAccessible(page, `staff ${language} operations health`);
      await page.setViewportSize({ width: 360, height: 740 });
      await expectAccessible(page, `staff ${language} operations health mobile`);
      await health.getByRole("group", { name: copy(language, "healthDiagnosticView") })
        .getByRole("button", { name: copy(language, "healthExpired"), exact: true }).press("Enter");
      await expectAccessible(page, "Staff expired diagnostics " + language);
      await health.waitFor();
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test("reduced transparency gives the Ticket form opaque fields and surfaces", async () => {
  const { page, context } = await open("customer");
  try {
    const emulation = await context.newCDPSession(page);
    const dialog = page.getByRole("dialog");
    const canvas = page.locator(".aurora-canvas");
    assert.match(await canvas.evaluate(element => getComputedStyle(element).filter), /blur/);
    await emulation.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-transparency", value: "reduce" }],
    });
    for (const surface of [dialog, dialog.locator("#customer-ticket-title")]) {
      const style = await surface.evaluate(element => {
        const css = getComputedStyle(element);
        return { blur: css.backdropFilter, image: css.backgroundImage, color: css.backgroundColor };
      });
      assert.equal(style.blur, "none");
      assert.equal(style.image, "none");
      assert.match(style.color, /^rgb\(/);
    }
    assert.equal(await canvas.evaluate(element => getComputedStyle(element).filter), "none");
    assert.equal(await canvas.evaluate(element =>
      getComputedStyle(element, "::before").backgroundImage), "none");
  } finally { await context.close(); }
});
