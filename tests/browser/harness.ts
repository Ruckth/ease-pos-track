// Shared browser fixtures: local-only sessions, instrumented draft resources
// and blocked provider traffic. Used by the workflow suite and exploration.
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from "playwright";
import { readFileSync } from "node:fs";
import { test as nodeTest } from "node:test";
import { ConvexHttpClient } from "convex/browser";
import { getFunctionName, type FunctionArgs, type FunctionReference, type FunctionReturnType } from "convex/server";
import { convexToJson, jsonToConvex, type JSONValue } from "convex/values";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { loadPorts } from "../../scripts/worktree-ports.mjs";
import { translations, translate } from "../../src/lib/i18n";
import { capture, newContext, recordChromium, redact } from "../../scripts/browser-evidence";

export const baseURL = process.env.BROWSER_BASE_URL!;
const fixture = JSON.parse(process.env.BROWSER_FIXTURE!) as { accessTokens: string[]; tickets: Id<"tickets">[]; projects: { id: Id<"projects">; key: string }[] };
// Seeded fixture sessions as access tokens (staff, Alice, Bob), for direct API checks.
export const seed = { sessions: fixture.accessTokens, tickets: fixture.tickets, projects: fixture.projects };
for (const session of seed.sessions) redact(session);
const convexUrl = `http://127.0.0.1:${loadPorts().CONVEX_CLOUD_PORT}`;
type WithToken<F extends FunctionReference<"query" | "mutation" | "action">> = FunctionArgs<F> & { token?: string };
/** A per-call client: the `token` field is removed and sent as the Convex Auth JWT. */
function client(token?: string) {
  const result = new ConvexHttpClient(convexUrl);
  if (token) result.setAuth(token);
  return result;
}
export const convex = {
  query: <F extends FunctionReference<"query">>(ref: F, { token, ...args }: WithToken<F>) => client(token).query(ref, args as FunctionArgs<F>),
  mutation: <F extends FunctionReference<"mutation">>(ref: F, { token, ...args }: WithToken<F>) => client(token).mutation(ref, args as FunctionArgs<F>),
  action: <F extends FunctionReference<"action">>(ref: F, { token, ...args }: WithToken<F>) => client(token).action(ref, args as FunctionArgs<F>),
};
/** Only the local evidence runner can read synthetic proof email and prepare Google fixtures. */
export function localIdentityAdmin() {
  const file = new URL("../../.convex/local/default/config.json", import.meta.url);
  const config = JSON.parse(readFileSync(file, "utf8")) as { deploymentName: string; adminKey: string; ports: { cloud: number } };
  if (!/^anonymous-[a-z0-9-]+$/.test(config.deploymentName)
    || convexUrl !== `http://127.0.0.1:${config.ports.cloud}` || !config.adminKey) throw new Error("Local identity fixture required");
  return async <F extends FunctionReference<"query" | "mutation", "internal">>(ref: F, args: FunctionArgs<F>) => {
    const path = getFunctionName(ref);
    const response = await fetch(`${convexUrl}/api/function`, {
      method: "POST", redirect: "error",
      headers: { "Content-Type": "application/json", Authorization: `Convex ${config.adminKey}` },
      body: JSON.stringify({ path, args: convexToJson(args), format: "convex_encoded_json" }),
    });
    if (!response.ok) throw new Error(`Local fixture request failed for ${path}`);
    const result = await response.json() as { status: string; value?: JSONValue };
    if (result.status !== "success" || result.value === undefined) throw new Error(`Local fixture result failed for ${path}`);
    return jsonToConvex(result.value) as FunctionReturnType<F>;
  };
}
export const LOCAL_CUSTOMER_PASSWORD = "local customer passphrase";
/** Convex Auth's browser storage keys, namespaced by the deployment URL. */
export function authStorageKeys(url = convexUrl) {
  const suffix = url.replace(/[^a-zA-Z0-9]/g, "");
  return { jwt: `__convexAuthJWT_${suffix}`, refresh: `__convexAuthRefreshToken_${suffix}` };
}
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
export async function open(browser: Browser, role: "staff" | "customer", language: Language = "en", configure?: (context: BrowserContext) => Promise<void>, device: Pick<BrowserContextOptions, "hasTouch" | "isMobile" | "viewport"> = {}) {
  const context = await newContext(browser, { permissions: ["camera"], viewport: { width: 1280, height: 900 }, ...device });
  let uploads = 0;
  await context.route(/\/api\/uploadthing|https:\/\/[^/]*(?:uploadthing|ufs\.sh)/, async route => { uploads++; await route.abort(); });
  const signedIn = role === "staff"
    ? await convex.mutation(api.auth.signInLocalFixture, { email: "owner@local.test" })
    // Password-free fixture session: the pinned component allows five password
    // verifications per minute per account, which a whole suite would exceed.
    : await convex.mutation(api.auth.signInLocalFixture, { username: "alice" });
  if (signedIn.status !== "complete") throw new Error(`fixture sign-in failed: ${JSON.stringify(signedIn)}`);
  const credentials = { token: signedIn.tokens.accessToken, refreshToken: signedIn.tokens.refreshToken };
  redact(credentials.token);
  redact(credentials.refreshToken);
  const keys = authStorageKeys();
  // tsx preserves nested function names with this helper when Playwright
  // serializes an evaluate callback; it exists only in the isolated test page.
  await context.addInitScript("globalThis.__name = (fn) => fn;");
  await context.addInitScript(({ token, refreshToken, keys, language, appOrigin }) => {
    // Instrument the app only; hosted Ticket pages run sandboxed without storage.
    if (location.origin !== appOrigin) return;
    // Let Convex Auth own rotation and sign-out across document navigations.
    if (!sessionStorage.getItem("browser-fixture-initialized")) {
      sessionStorage.setItem(keys.jwt, token);
      sessionStorage.setItem(keys.refresh, refreshToken);
      sessionStorage.setItem("browser-fixture-initialized", "1");
    }
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
  }, { token: credentials.token, refreshToken: credentials.refreshToken, keys, language, appOrigin: new URL(baseURL).origin });
  await configure?.(context);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${baseURL}/${role}?project=POS`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  try {
    await page.getByRole("button", { name: copy(language, "newTicket"), exact: true }).first().click({ timeout: 30_000 });
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
  return { context, page, title, errors, token: credentials.token, refreshToken: credentials.refreshToken, uploads: () => uploads };
}
/**
 * Page errors from a sandboxed hosted page, without the probe Playwright's
 * `serviceWorkers: "block"` injects (it cannot read `navigator.serviceWorker` there).
 */
export function hostedPageErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", error => { if (!/Service worker is disabled because the context is sandboxed/.test(error.message)) errors.push(error.message); });
  return errors;
}
export async function stats(page: Page) { return page.evaluate(() => window.draftStats); }
export async function files(page: Page, name = "draft.png", input = page.locator('[data-slot="ticket-draft-files"]')) {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 240;
    const ctx = canvas.getContext("2d")!; ctx.fillStyle = "#8ab"; ctx.fillRect(0, 0, 320, 240);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await input.setInputFiles({ name, mimeType: "image/png", buffer: Buffer.from(base64, "base64") });
}
/** The multi-Project switcher trigger: a menu button named for the open Project. */
export function projectSwitcher(page: Page, language: Language = "en") {
  return page.getByRole("button", { name: new RegExp(`^${copy(language, "chooseProject")}:`) });
}
/** Opens the Project menu and selects the Project with this key as a radio choice. */
export async function chooseProject(page: Page, key: string, language: Language = "en") {
  await projectSwitcher(page, language).click();
  await page.getByRole("menuitemradio", { name: new RegExp(`\\(${key}\\)$`) }).click();
  await page.getByRole("menu").waitFor({ state: "hidden" });
}
/** Opens a named header menu (staff "More options", customer "Account and language"). */
export async function openHeaderMenu(page: Page, name: string, method: "click" | "Enter" = "click") {
  const trigger = page.locator("header").getByRole("button", { name, exact: true });
  if (method === "click") await trigger.click(); else await trigger.press("Enter");
  await page.getByRole("menu").waitFor();
}

// Every check runs in an evidence scope: failures keep a screenshot, the
// assertion, and (locally) a Playwright trace taken before teardown.
export function workflowTest(name: string, run: () => Promise<void>): void;
export function workflowTest(name: string, options: { timeout?: number; skip?: string | boolean }, run: () => Promise<void>): void;
export function workflowTest(name: string, optionsOrRun: { timeout?: number; skip?: string | boolean } | (() => Promise<void>), maybeRun?: () => Promise<void>) {
  if (typeof optionsOrRun === "function") nodeTest(name, () => capture("workflows", name, optionsOrRun));
  else nodeTest(name, optionsOrRun, () => capture("workflows", name, maybeRun!));
}
