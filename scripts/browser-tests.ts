import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { loadPorts } from "./worktree-ports.mjs";
import { updateManifest } from "./browser-evidence";

const ports = loadPorts();
const cloud = `http://127.0.0.1:${ports.CONVEX_CLOUD_PORT}`;
const baseURL = `http://127.0.0.1:${ports.VITE_PORT}`;
const children: ChildProcess[] = [];
const env = { ...process.env, VITE_CONVEX_URL: cloud, CONVEX_URL: cloud,
  VITE_CONVEX_SITE_URL: `http://127.0.0.1:${ports.CONVEX_SITE_PORT}`,
  UPLOADTHING_TOKEN: "", UPLOAD_CALLBACK_SECRET: "local-only-callback-fixture", BROWSER_BASE_URL: baseURL };
function start(args: string[]) {
  const child = spawn("pnpm", ["exec", ...args], { env, stdio: "inherit", detached: true });
  children.push(child);
  return child;
}
function cleanup() {
  for (const child of children) if (child.pid) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already exited. */ }
  }
}
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { cleanup(); process.exit(1); });
async function ready(url: string, expected: number) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (children.some(child => child.exitCode !== null)) throw new Error("Local test server exited before readiness");
    try { if ((await fetch(url)).status === expected) return; } catch { /* Starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Local test server did not become ready: ${url}`);
}
/** Runs one child to completion as a labelled stage and returns its exit code. */
async function run(name: string, args: string[]) {
  const started = Date.now();
  const child = start(args);
  // A hung suite (for example an unclosed browser) fails the stage instead of the whole job timing out.
  const limit = Number(process.env.BROWSER_STAGE_TIMEOUT_MS ?? 20 * 60_000);
  const timer = setTimeout(() => { console.error(`Stage ${name} exceeded ${limit} ms; stopping it.`); if (child.pid) try { process.kill(-child.pid, "SIGTERM"); } catch { /* Exited. */ } }, limit);
  const code = await new Promise<number>(resolve => child.on("exit", (status, signal) => resolve(status ?? (signal ? 124 : 1))));
  clearTimeout(timer);
  updateManifest(manifest => { manifest.stages.push({ name, exitCode: code, durationMs: Date.now() - started }); });
  return code;
}
async function main() {
  const suite = process.env.BROWSER_SUITE ?? "workflows";
  try {
    const started = Date.now();
    start(["vite", "--host", "127.0.0.1"]);
    start(["tsx", "server/index.ts"]);
    let readiness = 1;
    try { await Promise.all([ready(baseURL, 200), ready(`http://127.0.0.1:${ports.UPLOAD_API_PORT}/health`, 200)]); readiness = 0; }
    finally { updateManifest(manifest => { manifest.stages.push({ name: "servers-ready", exitCode: readiness, durationMs: Date.now() - started }); }); }
    if (suite === "explore") process.exitCode = await run("explore", ["tsx", "--tsconfig", "tsconfig.test.json", "tests/browser/explore-draft.ts"]);
    else {
      // Both entry points always run so one failure does not hide the other.
      const grep = process.env.BROWSER_GREP;
      const workflows = await run("workflows", ["tsx", "--tsconfig", "tsconfig.test.json", "--test", "--test-concurrency=1",
        ...(grep ? [`--test-name-pattern=${grep}`] : []), "tests/browser/workflows.test.ts", "tests/browser/accessibility.test.ts"]);
      const explorer = grep ? 0 : await run("explorer", ["tsx", "tests/browser/explorer-check.mjs"]);
      process.exitCode = workflows || explorer;
    }
  } finally {
    cleanup();
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, "exit")));
    if (process.env.BROWSER_RESULT_FILE) writeFileSync(process.env.BROWSER_RESULT_FILE, JSON.stringify({ exitCode: process.exitCode ?? 1 }));
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
