// Shared browser fixtures: local-only sessions, instrumented draft resources
// and blocked provider traffic. Used by the workflow suite and exploration.
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { loadPorts } from "../../scripts/worktree-ports.mjs";
import { translations, translate } from "../../src/lib/i18n";
import { newContext, recordChromium, redact } from "../../scripts/browser-evidence";

export const baseURL = process.env.BROWSER_BASE_URL!;
export const seed = JSON.parse(process.env.BROWSER_FIXTURE!) as { sessions: string[]; projects: { id: Id<"projects">; key: string }[] };
for (const session of seed.sessions) redact(session);
export const convex = new ConvexHttpClient(`http://127.0.0.1:${loadPorts().CONVEX_CLOUD_PORT}`);
export async function launch() {
  const browser = await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  recordChromium(browser.version());
  return browser;
}
/**
 * One lazily launched browser per test file. Node's runner skips `after` hooks
 * when --test-name-pattern filters out every test in a file, so launching in
 * `before` would leave Chromium (and the run) hanging.
 */
export function suiteBrowser() {
  let browser: Promise<Browser> | undefined;
  return { get: () => browser ??= launch(), close: async () => { if (browser) await (await browser).close(); } };
}

export type Language = "en" | "th";
export type DraftStats = { created: string[]; revoked: string[]; streams: string[]; stops: string[]; aborts: number };
declare global { interface Window { draftStats: DraftStats } }
export function copy(language: Language, key: keyof typeof translations.en, values?: Record<string, string | number>) { return translate(language, key, values); }
export async function open(browser: Browser, role: "staff" | "customer", language: Language = "en", configure?: (context: BrowserContext) => Promise<void>) {
  const context = await newContext(browser, { permissions: ["camera"], viewport: { width: 1280, height: 900 } });
  let uploads = 0;
  await context.route(/\/api\/uploadthing|https:\/\/[^/]*(?:uploadthing|ufs\.sh)/, async route => { uploads++; await route.abort(); });
  const credentials = role === "staff"
    ? await convex.action(api.auth.login, { password: "LocalStaff123!", clientId: crypto.randomUUID() })
    : await convex.action(api.customers.login, { email: "alice@local.test", password: "LocalCustomer123!", clientId: crypto.randomUUID() });
  redact(credentials.token);
  // tsx preserves nested function names with this helper when Playwright
  // serializes an evaluate callback; it exists only in the isolated test page.
  await context.addInitScript("globalThis.__name = (fn) => fn;");
  await context.addInitScript(({ token, language }) => {
    sessionStorage.setItem("ease-pos-tracking-session", token);
    localStorage.setItem("ease-pos-tracking-language", language);
    const stats = { created: [] as string[], revoked: [] as string[], stops: [] as string[], streams: [] as string[], aborts: 0 };
    Object.assign(window, { draftStats: stats });
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); stats.created.push(url); return url; };
    URL.revokeObjectURL = url => { stats.revoked.push(url); revoke(url); };
    const getMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await getMedia(constraints);
      for (const track of stream.getTracks()) {
        stats.streams.push(track.id);
        const stop = track.stop.bind(track);
        track.stop = () => { stats.stops.push(track.id); stop(); };
      }
      return stream;
    };
    const abort = AbortController.prototype.abort;
    AbortController.prototype.abort = function (reason) { stats.aborts++; abort.call(this, reason); };
  }, { token: credentials.token, language });
  await configure?.(context);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${baseURL}/${role}?project=POS`);
  try {
    await page.getByRole("button", { name: copy(language, "newTicket"), exact: true }).first().click();
  } catch (error) {
    console.error("App startup failure", page.url(), (await page.locator("body").innerText()).slice(-3000), errors);
    await context.close(); throw error;
  }
  const title = page.locator(role === "staff" ? "#title" : "#customer-ticket-title");
  await title.waitFor({ state: "visible" });
  try {
    await page.waitForFunction(id => document.activeElement?.id === id, role === "staff" ? "title" : "customer-ticket-title", { timeout: 5000 });
  } catch (error) {
    console.error("Focus failure", (await page.locator("body").innerText()).slice(-3000), await page.evaluate(() => document.activeElement?.outerHTML), errors);
    await context.close(); throw error;
  }
  return { context, page, title, errors, token: credentials.token, uploads: () => uploads };
}
export async function stats(page: Page) { return page.evaluate(() => window.draftStats); }
export async function files(page: Page, name = "draft.png") {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 240;
    const ctx = canvas.getContext("2d")!; ctx.fillStyle = "#8ab"; ctx.fillRect(0, 0, 320, 240);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.locator('input[type="file"][multiple]').setInputFiles({ name, mimeType: "image/png", buffer: Buffer.from(base64, "base64") });
}
