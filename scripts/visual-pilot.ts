// Visual pilot: pixel comparison of three Ticket Explorer harness states.
// The harness uses fixed synthetic Tickets and needs only Vite (no backend).
// Rendering is pinned (Chromium from the lockfile, viewport, DPR 1, locale,
// UTC, light scheme, reduced motion, frozen clock), but fonts come from the OS,
// so baselines are per platform and live outside git until promoted.
//
//   pnpm test:visual                 compare with the local baseline (missing baseline: exit 3)
//   pnpm test:visual --update        write the local baseline from this run
//   pnpm test:visual --repeat 5      capture 5 times and require identical pixels (stability; no baseline needed)
//   pnpm test:visual --probe         apply a 4px layout shift and require a reported diff (sensitivity)
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { chromium, type Browser, type Page } from "playwright";
import { resultDirectory } from "./browser-result-paths";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string, fallback: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
const platform = `${process.platform}-${process.arch}`;
const outDir = resultDirectory(option("--out", "test-results/visual"));
const baselineDir = resultDirectory(option("--baseline", path.join("test-results/visual-baseline", platform)));
if (outDir === baselineDir || baselineDir.startsWith(outDir + path.sep) || outDir.startsWith(baselineDir + path.sep)) {
  throw new Error("Visual output and baseline must use separate directories");
}
const repeat = Number(option("--repeat", "1"));
/** Pixels allowed to differ per state; 0 keeps the pilot honest about stability. */
const THRESHOLD = Number(option("--max-diff-pixels", "0"));
if (!Number.isSafeInteger(repeat) || repeat < 1 || !Number.isSafeInteger(THRESHOLD) || THRESHOLD < 0) {
  throw new Error("Use a positive integer for --repeat and a nonnegative integer for --max-diff-pixels");
}
const FROZEN_TIME = new Date("2026-11-01T09:00:00Z");

type State = { name: string; viewport: { width: number; height: number }; act: (page: Page) => Promise<void> };
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const STATES: State[] = [
  { name: "explorer-table-desktop", viewport: { width: 1280, height: 900 }, act: async page => {
    await button(page, "Table").click();
    await page.getByText("Page 1 of 6 · 54 Tickets", { exact: true }).waitFor();
  } },
  { name: "explorer-board-desktop", viewport: { width: 1280, height: 900 }, act: async page => {
    await button(page, "Board").click();
    await page.locator('[data-slot="kanban-board"]').waitFor();
  } },
  { name: "explorer-table-phone", viewport: { width: 390, height: 844 }, act: async page => {
    await button(page, "Table").click();
    await page.getByRole("combobox", { name: "Sort", exact: true }).waitFor();
  } },
];

async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); });
    server.on("error", reject);
  });
}
async function waitFor(url: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch { /* Starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not start: ${url}`);
}
function compare(expectedFile: string, actualFile: string, diffFile: string) {
  const expected = PNG.sync.read(readFileSync(expectedFile));
  const actual = PNG.sync.read(readFileSync(actualFile));
  if (expected.width !== actual.width || expected.height !== actual.height) {
    return { pixels: Math.max(expected.width * expected.height, actual.width * actual.height), size: `${expected.width}x${expected.height} vs ${actual.width}x${actual.height}` };
  }
  const diff = new PNG({ width: expected.width, height: expected.height });
  const pixels = pixelmatch(expected.data, actual.data, diff.data, expected.width, expected.height, { threshold: 0.1 });
  if (pixels) { mkdirSync(path.dirname(diffFile), { recursive: true }); writeFileSync(diffFile, PNG.sync.write(diff)); }
  return { pixels };
}

async function main() {
  rmSync(outDir, { recursive: true, force: true });
  const port = await freePort();
  const vite = spawn("pnpm", ["exec", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { stdio: "ignore", detached: true });
  let browser: Browser | undefined;
  const report: { platform: string; chromium: string; repeat: number; probe: boolean; states: Array<{ name: string; run: number; against: string; pixels: number; size?: string }> } =
    { platform, chromium: "", repeat, probe: flag("--probe"), states: [] };
  let failed = false;
  try {
    browser = await chromium.launch({ headless: true, args: ["--font-render-hinting=none", "--disable-lcd-text", "--force-color-profile=srgb", "--hide-scrollbars"] });
    report.chromium = browser.version();
    const url = `http://127.0.0.1:${port}/tests/browser/explorer.html`;
    await waitFor(url);
    for (let run = 1; run <= repeat; run++) for (const state of STATES) {
      const context = await browser.newContext({ viewport: state.viewport, deviceScaleFactor: 1, locale: "en-US", timezoneId: "UTC", colorScheme: "light", reducedMotion: "reduce", serviceWorkers: "block" });
      await context.route(request => !/^(127\.0\.0\.1|localhost)$/.test(request.hostname), route => route.abort());
      await context.addInitScript(() => localStorage.setItem("ease-pos-tracking-language", "en"));
      const page = await context.newPage();
      await page.clock.setFixedTime(FROZEN_TIME);
      await page.goto(url);
      await state.act(page);
      // Lazy filter controls render a "Syncing" fallback first; wait for the settled UI.
      await button(page, "Add filter").waitFor();
      await page.waitForLoadState("networkidle");
      if (flag("--probe")) await page.addStyleTag({ content: "main { padding-left: calc(1rem + 4px) !important; }" });
      await page.evaluate(() => document.fonts.ready);
      const actual = path.join(outDir, "actual", `${state.name}-${run}.png`);
      mkdirSync(path.dirname(actual), { recursive: true });
      await page.screenshot({ path: actual, animations: "disabled", caret: "hide", fullPage: false });
      await context.close();
      // Repeats compare with run 1; the first run compares with the baseline.
      const against = run > 1 ? path.join(outDir, "actual", `${state.name}-1.png`) : path.join(baselineDir, `${state.name}.png`);
      if (flag("--update") && run === 1) { mkdirSync(baselineDir, { recursive: true }); copyFileSync(actual, against); continue; }
      if (!existsSync(against)) { report.states.push({ name: state.name, run, against: "missing", pixels: -1 }); continue; }
      const result = compare(against, actual, path.join(outDir, "diff", `${state.name}-${run}.png`));
      report.states.push({ name: state.name, run, against: run > 1 ? "run-1" : "baseline", ...result });
    }
  } finally {
    try { await browser?.close(); }
    finally { if (vite.pid) try { process.kill(-vite.pid, "SIGTERM"); } catch { /* Exited. */ } }
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  for (const state of report.states) console.log(`${state.pixels < 0 ? "MISSING" : state.pixels > THRESHOLD ? "DIFF   " : "same   "} ${state.name} run ${state.run} vs ${state.against}: ${state.pixels < 0 ? "no baseline" : `${state.pixels} px`}${state.size ? ` (${state.size})` : ""}`);
  const diffs = report.states.filter(state => state.pixels > THRESHOLD);
  const missing = report.states.filter(state => state.pixels < 0);
  if (flag("--update")) console.log(`Baseline written to ${baselineDir}`);
  if (flag("--probe")) {
    // The probe passes only if every compared state reports the deliberate change.
    const compared = report.states.filter(state => state.pixels >= 0 && state.run === 1);
    failed = compared.length !== STATES.length || compared.some(state => state.pixels <= THRESHOLD);
    console.log(failed ? "Probe NOT detected: the comparison is insensitive." : `Probe detected in ${compared.length} state(s); diffs in ${path.join(outDir, "diff")}.`);
  } else failed = diffs.length > 0;
  console.log(`Report: ${path.join(outDir, "report.json")}`);
  // Without a baseline, --repeat still proves stability; a single run reports exit 3.
  process.exitCode = failed ? 1 : missing.length && repeat === 1 && !flag("--update") ? 3 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
