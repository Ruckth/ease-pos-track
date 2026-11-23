// Mounted production components with in-memory data (tests/browser/components.html):
// Project switcher choices across a three-to-two change, menu viewport bounds,
// one-dot Ticket rows and independently bound Undo notifications.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { after, test as nodeTest } from "node:test";
import type { Page } from "playwright";
import { capture, EVIDENCE_DIR, newContext } from "../../scripts/browser-evidence";
import { baseURL, copy, suiteBrowser, type Language } from "./harness";

const browsers = suiteBrowser();
after(() => browsers.close());
const test = (name: string, run: () => Promise<void>) => nodeTest(name, () => capture("components", name, run));
const shotDir = path.join(EVIDENCE_DIR, "public", "screenshots");
const shot = async (page: Page, name: string) => { mkdirSync(shotDir, { recursive: true }); await page.screenshot({ path: path.join(shotDir, `components-${name}.png`), animations: "disabled" }); };

async function harness(query: string, viewport = { width: 1280, height: 900 }, language: Language = "en") {
  const context = await newContext(await browsers.get(), { viewport, reducedMotion: "reduce" });
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
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: viewport.width, height: viewport.height, scroll: document.documentElement.scrollWidth };
  });
  assert.ok(box.left >= 7.5 && box.right <= box.width - 7.5, `${label}: menu x ${box.left}–${box.right} outside ${box.width}`);
  assert.ok(box.top >= 0 && box.bottom <= box.height - 7.5, `${label}: menu y ${box.top}–${box.bottom} outside ${box.height}`);
  assert.ok(box.scroll <= box.width, `${label}: page-wide overflow ${box.scroll} > ${box.width}`);
}

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
    await page.getByRole("button", { name: "Revoke POS", exact: true }).click();
    await trigger(page).click();
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
    await page.getByRole("menuitem", { name: `${copy("en", "newProject")}…`, exact: true }).click();
    await page.locator("#created").filter({ hasText: "1" }).waitFor();
    assert.equal(await page.locator("#selected").innerText(), "");
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
        if (width < 640) assert.deepEqual({ dots, label, excerpt }, { dots: 1, label: 0, excerpt: 0 }, `row ${index} at ${width}`);
        else assert.deepEqual({ dots: dots <= 1, label, excerpt }, { dots: true, label: 1, excerpt: 1 }, `row ${index} at ${width}`);
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
  const { context, page, errors } = await harness(`case=notices&theme=${theme}`, { width: 390, height: 800 });
  try {
    await page.getByRole("button", { name: "Update two Tickets", exact: true }).click();
    const undo = page.getByRole("button", { name: copy("en", "undo"), exact: true });
    await page.waitForFunction(() => document.querySelectorAll("[data-sonner-toast]").length === 2);
    // The toast surface is neutral: no rich-colour background for success.
    const surface = await page.locator("[data-sonner-toast]").first().evaluate(element => getComputedStyle(element).backgroundColor);
    assert.doesNotMatch(surface, /rgb\(236, 253, 243\)/);
    await shot(page, `notices-${theme}-390`);
    // The newest toast is first; each Undo calls only its own Ticket's event.
    await undo.first().click();
    await page.locator("#undone").filter({ hasText: /^event-B-\d+$/ }).waitFor();
    await undo.first().click();
    await page.locator("#undone").filter({ hasText: /^event-B-\d+,event-A-\d+$/ }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
