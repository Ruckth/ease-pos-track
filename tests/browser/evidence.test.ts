// Before/after screenshots of representative real routes on the disposable
// local seed. Runs only when EVIDENCE_LABEL is set (for example `before` on the
// base commit and `after` on the candidate), so the images share data,
// Chromium, viewport and locale. Screens hold synthetic fixture data only.
import { mkdirSync } from "node:fs";
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
      await shot(page, `${role}-${language}-${width}-composer`);
      await page.getByRole("button", { name: copy(language, "closeDialog"), exact: true }).click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      if (role === "staff" && width < 640) await page.getByRole("button", { name: copy(language, "queueLabel"), exact: true }).click();
      await page.locator("button[data-ticket-id]:visible").first().waitFor();
      await shot(page, `${role}-${language}-${width}-queue`);
      await openMenu(page, copy(language, role === "staff" ? "queueMore" : "customerQueueMore"));
      await page.getByText(copy(language, "signOut"), { exact: true }).waitFor();
      await shot(page, `${role}-${language}-${width}-menu`);
      await page.keyboard.press("Escape");
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
      if (role === "staff") {
        await page.getByRole("button", { name: copy(language, "detailBack"), exact: true }).click().catch(() => page.keyboard.press("Escape"));
        const acknowledge = page.getByRole("button", { name: new RegExp(`^${copy(language, "queueAcknowledge")} ·`) }).first();
        if (await acknowledge.count()) {
          await acknowledge.click();
          await page.locator("[data-sonner-toast]").first().waitFor();
          await shot(page, `${role}-${language}-${width}-toast`);
        }
      }
    } finally { await context.close(); }
  });
}
