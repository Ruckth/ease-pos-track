// All backend CLI operations pass through the local safety wrapper, sequentially.
// Each stage is labelled, timed and logged (sanitized) under the evidence
// directory so a bootstrap failure before any page opens is still diagnosable.
// Run with tsx: it imports the TypeScript evidence helpers.
import { LOCAL_IDENTITY_PLACEHOLDERS } from "./local-identity-env.mjs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { localDeploymentName } from "./dev-reset-target.mjs";
import { EVIDENCE_DIR, log, readManifest, reset, sanitize, updateManifest } from "./browser-evidence.ts";

const SUITES = ["workflows", "explore"];
const argv = process.argv.slice(2);
const suiteIndex = argv.indexOf("--suite");
const suite = suiteIndex >= 0 ? argv[suiteIndex + 1] : "workflows";
if (!SUITES.includes(suite)) { console.error(`Unknown --suite ${suite}; expected ${SUITES.join(" or ")}.`); process.exit(2); }
if (argv.includes("--help")) {
  console.log(`Usage: pnpm test:browser [--suite workflows|explore] [--grep <test name pattern>]
  --grep skips the Explorer check and runs only matching workflow/accessibility tests.
Environment: BROWSER_EVIDENCE_DIR (default test-results/browser), BROWSER_TRACE=on|off (default on locally, off in CI).
Exploration: EXPLORE_SEEDS, EXPLORE_ACTIONS, EXPLORE_BUDGET_MS, EXPLORE_REPLAY=<sequence.json>, EXPLORE_PROBE=leak. See docs/browser-verification.md.`);
  process.exit(0);
}
const grepIndex = argv.indexOf("--grep");
if (grepIndex >= 0) {
  const pattern = argv[grepIndex + 1];
  if (suite !== "workflows" || !pattern || pattern.startsWith("--")) {
    console.error("--grep requires a test name pattern and the workflows suite.");
    process.exit(2);
  }
  process.env.BROWSER_GREP = pattern;
} else delete process.env.BROWSER_GREP;
// A replayed sequence usually lives in the evidence directory that is reset below.
const replayCopy = process.env.EXPLORE_REPLAY ? readFileSync(process.env.EXPLORE_REPLAY, "utf8") : undefined;
reset();
process.env.BROWSER_EVIDENCE_DIR = EVIDENCE_DIR;
process.env.BROWSER_SUITE = suite;
// Provider credentials never reach browser children, whatever the caller's shell holds.
for (const key of ["UPLOADTHING_TOKEN", "UPLOADTHING_SECRET", "UPLOADTHING_APP_ID"]) delete process.env[key];

class StageError extends Error {}
/** Runs one wrapper command as a named stage; output is teed line by line, sanitized. */
async function stage(name, args, { capture = false } = {}) {
  const started = Date.now();
  log("runner", `\n### stage ${name}: pnpm convex:local ${args.join(" ")}\n`);
  const child = spawn("pnpm", ["convex:local", ...args], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  let stdout = "";
  const tee = (stream, sink, keep) => {
    let pending = "";
    stream.setEncoding("utf8");
    stream.on("data", chunk => {
      if (keep) { stdout += chunk; return; }
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) { sink.write(sanitize(line) + "\n"); log("runner", line + "\n"); }
    });
    stream.on("end", () => { if (pending) { sink.write(sanitize(pending) + "\n"); log("runner", pending + "\n"); } });
  };
  tee(child.stdout, process.stdout, capture);
  tee(child.stderr, process.stderr, false);
  const code = await new Promise(resolve => { child.on("error", () => resolve(127)); child.on("close", status => resolve(status ?? 1)); });
  if (capture) log("runner", `[stdout withheld: ${stdout.length} bytes of fixture output]\n`);
  updateManifest(manifest => { manifest.stages.push({ name, exitCode: code, durationMs: Date.now() - started }); });
  if (code !== 0) throw new StageError(`stage ${name} failed with exit ${code}`);
  return stdout;
}

const directory = mkdtempSync(path.join(tmpdir(), "ticket-browser-"));
process.env.BROWSER_RESULT_FILE = path.join(directory, "result.json");
if (replayCopy) { process.env.EXPLORE_REPLAY = path.join(directory, "replay.json"); writeFileSync(process.env.EXPLORE_REPLAY, replayCopy); }
try {
  // Cleanup is disabled before the schema push and verified before seeding: fail closed.
  // A cold checkout has no local deployment yet, so env commands cannot start
  // a backend. Its first push creates a backend with no environment variables,
  // where cleanup is off (only the exact value "true" enables it); the flag is
  // then set and verified before any fixture or browser runs.
  // The required Google settings get inert local placeholders (Google sign-in
  // stays unusable locally); a cold push creates the backend first.
  const identityPlaceholders = async () => {
    for (const [key, value] of Object.entries(LOCAL_IDENTITY_PLACEHOLDERS)) await stage(`identity-env-${key.toLowerCase().replaceAll("_", "-")}`, ["env", "set", key, value]);
  };
  if (localDeploymentName()) {
    await stage("cleanup-flag", ["env", "set", "MEDIA_CLEANUP_ENABLED", "false"]);
    await identityPlaceholders();
    await stage("schema-push", []);
  } else {
    try { await stage("schema-push-cold", []); }
    catch { await identityPlaceholders(); await stage("schema-push-cold-retry", []); }
    await stage("cleanup-flag", ["env", "set", "MEDIA_CLEANUP_ENABLED", "false"]);
  }
  const flag = (await stage("cleanup-flag-verify", ["env", "get", "MEDIA_CLEANUP_ENABLED"], { capture: true })).trim();
  if (flag !== "false") throw new StageError(`MEDIA_CLEANUP_ENABLED must be "false" on the local backend, found "${flag}"`);
  // Local-only identity: the test provider stands in for Google, and the local
  // identity sender records codes instead of sending them.
  for (const [key, value] of Object.entries({ LOCAL_FIXTURES_ENABLED: "true", IDENTITY_SENDER: "local", IDENTITY_CODE_KEY: "local-only-identity-code-key-0123456789abcdef", UPLOAD_CALLBACK_SECRET: "local-only-callback-fixture" })) {
    await stage(`fixture-env-${key.toLowerCase().replaceAll("_", "-")}`, ["env", "set", key, value]);
  }
  process.env.BROWSER_FIXTURE = JSON.stringify(JSON.parse(await stage("seed", ["run", "seed:run", JSON.stringify({ largeDataset: true })], { capture: true })));
  await stage(`suite-${suite}`, ["dev", "--once", "--typecheck", "disable", "--start", "pnpm exec tsx scripts/browser-tests.ts"]);
  // Convex logs a failed --start command but may itself exit zero.
  let result;
  try { result = JSON.parse(readFileSync(process.env.BROWSER_RESULT_FILE, "utf8")); }
  catch { throw new StageError(`suite-${suite} ended without a result file`); }
  if (grepIndex >= 0 && result.exitCode === 0 && readManifest().tests.length === 0) {
    throw new StageError("No browser checks matched --grep");
  }
  // The --start stage above reports Convex's status; record the suite's own.
  updateManifest(manifest => { manifest.stages.push({ name: `suite-${suite}-result`, exitCode: result.exitCode, durationMs: 0 }); });
  process.exitCode = result.exitCode;
} catch (error) {
  const message = sanitize(error instanceof Error ? error.message : String(error));
  console.error(`Browser checks did not complete: ${message}`);
  log("runner", `\n!!! ${message}\n`);
  updateManifest(manifest => { manifest.failure = message; });
  process.exitCode = 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
  console.log(`Browser evidence: ${path.relative(process.cwd(), EVIDENCE_DIR) || EVIDENCE_DIR} (public/ is uploadable, local/ holds traces and stays on this machine).`);
}
