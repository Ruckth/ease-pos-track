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
      await page.getByRole("button", { name: copy(language, "archive"), exact: true }).click();
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
      await health.getByText(copy(language, "healthStorage"), { exact: true }).waitFor();
      await expectAccessible(page, `staff ${language} operations health`);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}
