import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { loadPorts } from "./worktree-ports.mjs";

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
async function main() {
  try {
    start(["vite", "--host", "127.0.0.1"]);
    start(["tsx", "server/index.ts"]);
    await Promise.all([ready(baseURL, 200), ready(`http://127.0.0.1:${ports.UPLOAD_API_PORT}/health`, 200)]);
    const tests = start(["tsx", "--tsconfig", "tsconfig.test.json", "--test", "tests/browser/workflows.test.ts"]);
    process.exitCode = await new Promise<number>(resolve => tests.on("exit", code => resolve(code ?? 1)));
  } finally {
    cleanup();
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, "exit")));
    if (process.env.BROWSER_RESULT_FILE) writeFileSync(process.env.BROWSER_RESULT_FILE, JSON.stringify({ exitCode: process.exitCode ?? 1 }));
  }

}
void main().catch(error => { console.error(error); process.exitCode = 1; });
