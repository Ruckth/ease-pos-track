// Before/after screenshots of representative real routes on the disposable
// local seed. Runs only when EVIDENCE_LABEL is set (for example `before` on the
// base commit and `after` on the candidate), so the images share data,
// Chromium, viewport and locale. Screens hold synthetic fixture data only.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, test as nodeTest } from "node:test";
import type { Page } from "playwright";
import { capture, EVIDENCE_DIR } from "../../scripts/browser-evidence";
import { copy, open as openWith, suiteBrowser, type Language } from "./harness";

const browsers = suiteBrowser();
after(() => browsers.close());
const label = process.env.EVIDENCE_LABEL ?? "after";
const test = (name: string, run: () => Promise<void>) => nodeTest(`evidence ${name}`, () => capture("evidence", name, run));
const dir = path.join(EVIDENCE_DIR, "public", "screenshots");
const settle = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
async function shot(page: Page, name: string) {
  mkdirSync(dir, { recursive: true });
  await settle(page);
  await page.screenshot({ path: path.join(dir, `evidence-${label}-${name}.png`), animations: "disabled" });
}
/** Opens a named header menu in either the old details/summary or the new menu button form. */
async function openMenu(page: Page, name: string) {
  const summary = page.locator("summary").filter({ hasText: name });
  if (await summary.count()) await summary.first().click();
  else await page.getByRole("button", { name, exact: true }).click();
}

for (const [role, language, width] of [["customer", "en", 1280], ["customer", "th", 390], ["staff", "en", 1280], ["staff", "th", 390]] as const) {
  test(`${role} ${language} ${width}`, async () => {
    const { page, context } = await openWith(await browsers.get(), role, language as Language);
    try {
      await page.setViewportSize({ width, height: width < 640 ? 844 : 900 });
      await page.getByRole("button", { name: copy(language, "chooseFiles"), exact: true }).waitFor();
      await shot(page, `${role}-${language}-${width}-composer`);
      await page.getByRole("button", { name: copy(language, "closeDialog"), exact: true }).click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      if (role === "staff" && width < 640) await page.getByRole("button", { name: copy(language, "queueLabel"), exact: true }).click();
      await page.locator("button[data-ticket-id]:visible").first().waitFor();
      await shot(page, `${role}-${language}-${width}-queue`);
      const metrics = [];
      for (const measuredWidth of width === 390 ? [390, 320] : [1280, 390, 320]) {
        await page.setViewportSize({ width: measuredWidth, height: measuredWidth < 640 ? 844 : 900 });
        await settle(page);
        metrics.push(await page.locator("main header").first().evaluate(el => {
          const firstTicket = Array.from(document.querySelectorAll("button[data-ticket-id]"))
            .find(button => button.getClientRects().length);
          return {
            width: innerWidth,
            height: el.getBoundingClientRect().height,
            overflow: document.documentElement.scrollWidth - innerWidth,
            firstTicketY: firstTicket?.getBoundingClientRect().top,
            firstTicketBottom: firstTicket?.getBoundingClientRect().bottom,
            firstTicketText: firstTicket?.textContent?.trim(),
            lanes: document.querySelectorAll('[data-slot="kanban-column"]').length,
            controls: Array.from(el.querySelectorAll("button, summary"))
              .filter(button => button.getClientRects().length && !button.closest('[role="menu"]')).map(button => {
                const { x, width, height } = button.getBoundingClientRect();
                return { label: button.getAttribute("aria-label") || button.textContent?.trim(), x, width, height };
              }),
          };
        }));
        if (measuredWidth === 320 && role === "staff") await shot(page, `staff-${language}-320-queue`);
      }
      writeFileSync(path.join(dir, `toolbar-${role}-${language}-${width}.json`), JSON.stringify(metrics, null, 2));
      await page.setViewportSize({ width, height: width < 640 ? 844 : 900 });
      await openMenu(page, copy(language, role === "staff" ? "queueMore" : "customerQueueMore"));
      await page.getByText(copy(language, "signOut"), { exact: true }).waitFor();
      await shot(page, `${role}-${language}-${width}-menu`);
      await page.keyboard.press("Escape");
      const legacyMenu = page.locator("details[open] > summary").filter({
        hasText: copy(language, role === "staff" ? "queueMore" : "customerQueueMore"),
      });
      if (await legacyMenu.count()) await legacyMenu.click();
      const switcher = page.getByRole("button", { name: new RegExp(`^${copy(language, "chooseProject")}`) });
      if (await switcher.count()) {
        await switcher.click();
        await page.getByRole("menuitemradio").first().waitFor();
        await shot(page, `${role}-${language}-${width}-projects`);
        await page.keyboard.press("Escape");
      }
      const row = page.locator("button[data-ticket-id]:visible").first();
      await row.click();
      await page.waitForURL(url => url.searchParams.has("ticket"));
      await page.getByRole("heading", { level: 2 }).first().waitFor();
      await shot(page, `${role}-${language}-${width}-detail`);
    } finally { await context.close(); }
  });
}

if (label === "after") for (const role of ["staff", "customer"] as const) {
  test(`${role} toolbar measurements`, async () => {
    const { page, context } = await openWith(await browsers.get(), role, "en");
    const metrics = [];
    try {
      await page.getByRole("dialog").getByRole("button", { name: copy("en", "closeDialog"), exact: true }).click();
      const toolbar = page.locator("main header").first();
      for (const width of [320, 360, 390, 430, 1100, 1279, 1280]) {
        await page.setViewportSize({ width, height: 844 });
        const laneCount = width >= 1280 ? 5 : 1;
        if (role === "staff") await page.waitForFunction(expected => document.querySelectorAll('[data-slot="kanban-column"]').length === expected, laneCount);
        await settle(page);
        const geometry = await toolbar.evaluate(el => ({
          height: el.getBoundingClientRect().height,
          overflow: document.documentElement.scrollWidth - innerWidth,
          controls: Array.from(el.querySelectorAll("button")).filter(button => button.getClientRects().length && !button.closest('[role="menu"]')).map(button => {
            const { width, height } = button.getBoundingClientRect();
            return { label: button.getAttribute("aria-label") || button.textContent?.trim(), width, height };
          }),
        }));
        assert.ok(geometry.overflow <= 1, `${role} ${width}px overflow ${geometry.overflow}`);
        assert.equal(await toolbar.getByText(copy("en", "appName"), { exact: true }).count(), 0);
        if (width >= 360 && width <= 430) {
          // One flat 44 px row plus its hairline divider.
          assert.ok(geometry.height >= 44 && geometry.height <= 48, `${role} toolbar height ${geometry.height}px`);
          for (const control of geometry.controls) assert.ok(control.width >= 44 && control.height >= 44, JSON.stringify(control));
        }
        metrics.push({ role, width, ...geometry, ...(role === "staff" ? { lanes: laneCount } : {}) });
        if ((width >= 360 && width <= 430) || width === 1100) await shot(page, `${role}-en-${width}-workspace`);
      }
      writeFileSync(path.join(dir, `toolbar-${role}.json`), JSON.stringify(metrics, null, 2));
    } finally { await context.close(); }
  });
}

if (label === "after") for (const role of ["staff", "customer"] as const) for (const language of ["en", "th"] as const) {
  test(`${role} ${language} compact phone workspace`, async () => {
    const { page, context } = await openWith(await browsers.get(), role, language, undefined, {
      hasTouch: true, isMobile: true, viewport: { width: 360, height: 780 },
    });
    try {
      await page.getByRole("dialog").getByRole("button", { name: copy(language, "closeDialog"), exact: true }).tap();
      const header = page.locator("main header").first();
      const firstTicket = page.locator("button[data-ticket-id]:visible").first();
      await firstTicket.waitFor();
      if (role === "staff") {
        assert.equal(await page.getByRole("button", { name: copy(language, "queueLabel"), exact: true }).getAttribute("aria-pressed"), "true");
      }
      const metrics = [];
      for (const width of [360, 390, 430]) {
        await page.setViewportSize({ width, height: Math.round(width * 19.5 / 9) });
        await settle(page);
        const bounds = (await header.boundingBox())!;
        assert.ok(bounds.height >= 44 && bounds.height <= 48, `${width}px header height is ${bounds.height}px`);
        const minTarget = await header.getByRole("button").evaluateAll(buttons => Math.min(...buttons.flatMap(button => {
          const { height, width } = button.getBoundingClientRect();
          return [height, width];
        })));
        assert.ok(minTarget >= 44, `${width}px header target is ${minTarget}px`);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        if (role === "customer") {
          const filters = page.getByRole("group", { name: copy(language, "filterTickets") }).getByRole("button");
          assert.equal(await filters.count(), 4);
          assert.equal(await filters.evaluateAll(buttons => new Set(buttons.map(button => button.getBoundingClientRect().top)).size), 1);
          for (const filter of await filters.all()) {
            const visibleLabel = await filter.locator("[aria-hidden='true']").first().innerText();
            assert.equal(await filter.and(page.getByRole("button", { name: visibleLabel })).count(), 1, `Accessible name contains ${visibleLabel}`);
          }
        }
        const row = (await firstTicket.boundingBox())!;
        assert.ok(row.y + row.height <= page.viewportSize()!.height, "The first Ticket is fully visible");
        metrics.push({ width, headerHeight: bounds.height, minTarget, firstTicketY: row.y, firstTicketBottom: row.y + row.height });
        await shot(page, `${role}-${language}-${width}-compact-queue`);
      }
      writeFileSync(path.join(dir, `compact-phone-${role}-${language}.json`), JSON.stringify(metrics, null, 2));
    } finally { await context.close(); }
  });
}

test("customer th 390 notification settings", async () => {
  const { page, context } = await openWith(await browsers.get(), "customer", "th");
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("dialog").getByRole("button", { name: copy("th", "closeDialog") }).click();
    await page.getByRole("button", { name: copy("th", "ticketInbox"), exact: true }).click();
    const inbox = page.getByRole("dialog", { name: copy("th", "ticketInbox"), exact: true });
    const settings = inbox.locator("summary").filter({ hasText: copy("th", "inboxSettings") });
    await settings.click();
    const preference = inbox.getByRole("checkbox", { name: copy("th", "statusInboxPreference"), exact: true });
    await preference.waitFor();
    await page.waitForFunction(element => element instanceof HTMLInputElement && !element.disabled, await preference.elementHandle());
    await shot(page, "customer-th-390-settings");
  } finally { await context.close(); }
});

test("staff th 390 Operations health settings", async () => {
  const { page, context } = await openWith(await browsers.get(), "staff", "th");
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("dialog").getByRole("button", { name: copy("th", "closeDialog") }).click();
    await openMenu(page, copy("th", "queueMore"));
    await page.getByRole("menuitem", { name: copy("th", "healthTitle"), exact: true }).click();
    const health = page.getByRole("dialog", { name: copy("th", "healthTitle"), exact: true });
    if (label === "before") await health.getByText(/ข้อมูลรับรองพื้นที่จัดเก็บ/).first().waitFor();
    else await health.locator("summary").filter({ hasText: copy("th", "healthConfiguration") }).waitFor();
    await shot(page, "staff-th-390-health");
  } finally { await context.close(); }
});
