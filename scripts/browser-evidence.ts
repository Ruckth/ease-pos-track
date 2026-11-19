// Failure evidence for the browser checks. The repository is public, so
// everything under `public/` must be safe to upload: synthetic screenshots,
// sanitized text and a manifest. Playwright traces hold DOM, network and
// storage values and are written only under `local/`, which CI never uploads.
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Browser, BrowserContext, BrowserContextOptions } from "playwright";
import { resultDirectory } from "./browser-result-paths";

export const EVIDENCE_DIR = resultDirectory(process.env.BROWSER_EVIDENCE_DIR ?? "test-results/browser");
/** Files allowed in the uploadable tree. Anything else fails verification. */
export const PUBLIC_FILES = [/^manifest\.json$/, /^logs\/[a-z0-9-]+\.log$/, /^screenshots\/[a-z0-9-]+\.png$/, /^explore\/[a-z0-9-]+\.json$/];
// Local-only fixture values from scripts/test-browser.mjs plus provider names.
const KNOWN_SECRETS = ["LocalStaff123!", "LocalCustomer123!", "local-only-fixture-pepper", "local-only-callback-fixture"];
const extraSecrets = new Set<string>();

/** Registers a runtime value (session token, intent secret) for redaction. */
export function redact(value: string | undefined) { if (value && value.length >= 8) extraSecrets.add(value); }

export function sanitize(text: string) {
  let out = text;
  for (const secret of KNOWN_SECRETS.concat(Array.from(extraSecrets), envSecrets())) out = out.split(secret).join("[redacted]");
  return out
    .replace(/\b[0-9a-f]{44,}\b/gi, "[redacted-hex]")
    .replace(/\b(Bearer|Basic)\s+[^\s"']+/gi, "$1 [redacted]")
    .replace(/\b(eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, "[redacted-jwt]")
    .replace(/(https?:\/\/[^\s"'?#]+)[?#][^\s"']*/g, "$1?[redacted-query]")
    .replace(/((?:token|secret|password|pepper|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1[redacted]");
}
function envSecrets() {
  return Object.entries(process.env)
    .filter(([key, value]) => /TOKEN|SECRET|PASSWORD|PEPPER|ADMIN_KEY|DEPLOY_KEY/.test(key) && value && value.length >= 8)
    .map(([, value]) => value!);
}

export const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "unnamed";

type Entry = { suite: string; test: string; status: "passed" | "failed"; durationMs: number; error?: string; screenshots: string[]; traces: number; viewport?: { width: number; height: number } | null; locale?: string };
type Manifest = { commit: string; node: string; platform: string; chromium?: string; locale: string; timezone: string; trace: boolean; createdAt: string; failure?: string; stages: Array<{ name: string; exitCode: number; durationMs: number }>; tests: Entry[]; blockedHosts: string[] };

function commit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { return "unknown"; }
}
const manifestPath = () => path.join(EVIDENCE_DIR, "public", "manifest.json");
export function readManifest(): Manifest {
  if (existsSync(manifestPath())) return JSON.parse(readFileSync(manifestPath(), "utf8")) as Manifest;
  return { commit: commit(), node: process.version, platform: `${process.platform}-${process.arch}`, locale: Intl.DateTimeFormat().resolvedOptions().locale,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, trace: traceEnabled(), createdAt: new Date().toISOString(), stages: [], tests: [], blockedHosts: [] };
}
export function updateManifest(change: (manifest: Manifest) => void) {
  const manifest = readManifest();
  change(manifest);
  mkdirSync(path.dirname(manifestPath()), { recursive: true });
  writeFileSync(manifestPath(), JSON.stringify(manifest, null, 2) + "\n");
}
/** Appends sanitized text to an allowlisted public log. */
export function log(name: string, text: string) {
  const file = path.join(EVIDENCE_DIR, "public", "logs", `${slug(name)}.log`);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, sanitize(text));
}
// Traces are on locally unless disabled; CI disables them because they are never uploaded.
const traceEnabled = () => !["0", "off", "false"].includes(process.env.BROWSER_TRACE ?? (process.env.CI ? "off" : "on"));

type Scope = { suite: string; test: string; contexts: BrowserContext[]; closers: Map<BrowserContext, () => Promise<void>> };
const scopes = new AsyncLocalStorage<Scope>();
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])$/;
function recordBlockedHost(host: string) {
  updateManifest(manifest => { if (!manifest.blockedHosts.includes(host)) manifest.blockedHosts.push(host); });
}

/**
 * Creates a context that blocks non-loopback traffic, records a trace when
 * enabled and defers `close()` until the surrounding `capture` finishes, so a
 * failing test's pages still exist when evidence is taken.
 */
export async function newContext(browser: Browser, options?: BrowserContextOptions) {
  const context = await browser.newContext({ ...options, serviceWorkers: "block" });
  await context.route(url => !LOOPBACK.test(url.hostname) && !["data:", "blob:"].includes(url.protocol), async route => {
    recordBlockedHost(new URL(route.request().url()).hostname);
    await route.abort("blockedbyclient");
  });
  await context.routeWebSocket(url => !LOOPBACK.test(url.hostname), async socket => {
    recordBlockedHost(new URL(socket.url()).hostname);
    await socket.close();
  });
  if (traceEnabled()) await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const scope = scopes.getStore();
  if (scope) {
    scope.contexts.push(context);
    scope.closers.set(context, context.close.bind(context));
    context.close = async () => { /* Closed by capture() after evidence is taken. */ };
  }
  return context;
}

/** Runs one browser check inside an evidence scope and preserves its failure. */
export async function capture(suite: string, test: string, run: () => Promise<void>) {
  const scope: Scope = { suite, test, contexts: [], closers: new Map() };
  const started = Date.now();
  let failed = false;
  let failure: unknown;
  try { await scopes.run(scope, run); } catch (error) { failed = true; failure = error; }
  const entry: Entry = { suite, test, status: failed ? "failed" : "passed", durationMs: Date.now() - started, screenshots: [], traces: 0 };
  // Evidence capture must never replace the original failure.
  try {
    const name = slug(`${suite}-${test}`);
    for (let index = 0; index < scope.contexts.length; index++) {
      const context = scope.contexts[index];
      if (failed) for (let pageIndex = 0; pageIndex < context.pages().length; pageIndex++) {
        const page = context.pages()[pageIndex];
        if (page.isClosed()) continue;
        const file = `screenshots/${name}-${index}-${pageIndex}.png`;
        mkdirSync(path.join(EVIDENCE_DIR, "public", "screenshots"), { recursive: true });
        await page.screenshot({ path: path.join(EVIDENCE_DIR, "public", file), fullPage: false, timeout: 5000 }).then(() => entry.screenshots.push(file), () => undefined);
        entry.viewport ??= page.viewportSize();
        entry.locale ??= await page.evaluate(() => localStorage.getItem("ease-pos-tracking-language") ?? navigator.language).catch(() => undefined);
      }
      if (traceEnabled()) {
        const trace = failed ? path.join(EVIDENCE_DIR, "local", "traces", `${name}-${index}.zip`) : undefined;
        await context.tracing.stop(trace ? { path: trace } : undefined).then(() => { if (trace) entry.traces++; }, () => undefined);
      }
    }
  } catch (error) { console.error("Evidence capture failed:", sanitize(String(error))); }
  finally {
    for (const context of scope.contexts) await (scope.closers.get(context) ?? (() => context.close()))().catch(() => undefined);
  }
  try {
    if (failed) {
      entry.error = sanitize(failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure)).slice(0, 4000);
      log(`${suite}-failures`, `## ${test}\n${entry.error}\n${sanitize(failure instanceof Error ? failure.stack ?? "" : "")}\n\n`);
    }
    updateManifest(manifest => { manifest.tests.push(entry); });
  } catch (error) {
    if (!failed) throw error;
    console.error("Evidence write failed:", sanitize(String(error)));
  }
  if (failed) throw failure;
}

export function recordChromium(version: string) { updateManifest(manifest => { manifest.chromium = version; }); }

/** Lists public files and refuses any outside the allowlist or containing secret material. */
export function verifyPublic(dir = path.join(EVIDENCE_DIR, "public")) {
  const problems: string[] = [];
  const files: string[] = [];
  function walk(current: string) {
    const entry = lstatSync(current, { throwIfNoEntry: false });
    if (!entry) return;
    if (entry.isDirectory()) {
      for (const name of readdirSync(current)) walk(path.join(current, name));
      return;
    }
    const file = path.relative(dir, current).split(path.sep).join("/") || ".";
    if (entry.isFile()) files.push(file);
    else problems.push(`not a regular file: ${file}`);
  }
  walk(dir);
  for (const file of files) {
    if (!PUBLIC_FILES.some(pattern => pattern.test(file))) { problems.push(`not allowlisted: ${file}`); continue; }
    if (file.endsWith(".png")) {
      const head = readFileSync(path.join(dir, file)).subarray(0, 8);
      if (!head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) problems.push(`not a PNG: ${file}`);
      continue;
    }
    const text = readFileSync(path.join(dir, file), "utf8");
    if (sanitize(text) !== text) problems.push(`unsanitized content: ${file}`);
  }
  return { files, problems };
}

export function reset() { rmSync(EVIDENCE_DIR, { recursive: true, force: true }); }
