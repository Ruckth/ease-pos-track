#!/usr/bin/env node
// Strictly targets the disposable local backend.
// The CLI rewrites .env.local when it selects a deployment, so the shared
// development settings are saved first and always restored afterwards.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { loadPorts } from "./worktree-ports.mjs";
import { parse } from "dotenv";

const args = process.argv.slice(2);
const ENV_FILE = ".env.convex-local";
const LOCAL_DEPLOYMENT = "anonymous:anonymous-track-ease-pos";
const SAVED = ".env.local.shared-backup";

if (args.length && !["dev", "run", "env", "import", "export", "data", "codegen", "--help"].includes(args[0])) {
  console.error("Refusing unsupported command; this wrapper targets only the disposable local backend."); process.exit(4);
}

if (args.some(arg => /^--(reset-development|prod|deployment|deployment-name|env-file|url|admin-key|configure|preview|local|cloud|dev-deployment|team|project|force)/.test(arg))) {
  // --force is allowed only for env set, never deployment configuration.
  if (!(args[0] === "env" && args[1] === "set" && args.filter(arg => arg.startsWith("--")).every(arg => ["--force", "--from-file"].includes(arg)))) {
    console.error("Refusing deployment override arguments."); process.exit(4);
  }
}
if (!existsSync(ENV_FILE)) writeFileSync(ENV_FILE, `CONVEX_DEPLOYMENT=${LOCAL_DEPLOYMENT}\n`);
const settings = existsSync(ENV_FILE) ? parse(readFileSync(ENV_FILE)) : {};
const target = settings.CONVEX_DEPLOYMENT;
if (target !== LOCAL_DEPLOYMENT || Object.keys(settings).some(key => key !== "CONVEX_DEPLOYMENT" && key.startsWith("CONVEX_"))) {
  console.error(`Refusing to run: ${ENV_FILE} must target ${LOCAL_DEPLOYMENT}, found ${target ?? "nothing"}.`);
  process.exit(4);
}
if (existsSync(SAVED)) {
  console.error(`Refusing to run: ${SAVED} exists from an interrupted run. Restore it to .env.local first.`);
  process.exit(4);
}

if (args.length === 0) args.push("dev", "--once", "--typecheck", "disable");
// Pin the backend to this checkout's ports: if they are taken the CLI fails
// loudly instead of silently moving, which would strand Vite and the API.
if (args[0] === "dev" && !args.some((arg) => arg.startsWith("--local-cloud-port"))) {
  const ports = loadPorts();
  args.push("--local-cloud-port", String(ports.CONVEX_CLOUD_PORT), "--local-site-port", String(ports.CONVEX_SITE_PORT));
}
const hadEnv = existsSync(".env.local");
if (hadEnv) copyFileSync(".env.local", SAVED);
let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  if (hadEnv) {
    copyFileSync(SAVED, ".env.local");
    rmSync(SAVED);
  } else rmSync(".env.local", { force: true });
}
process.on("exit", restore);
let child;
let keeper;
async function stopKeeper() {
  if (keeper && keeper.exitCode === null && keeper.signalCode === null) {
    await new Promise(done => { keeper.once("exit", done); keeper.kill("SIGINT"); });
  }
}
// Install handlers before startup so interruption cannot strand shared settings.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, async () => {
    if (child) child.kill(signal);
    else { await stopKeeper(); restore(); process.exit(1); }
  });
}

const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("CONVEX_")) delete env[key];
env.CONVEX_AGENT_MODE = "anonymous";
// The installed CLI auto-starts local backends for `run`, but not snapshot/env
// commands. A read-only system query subscription holds the backend open. This
// works with incompatible/empty schemas and never pushes application code.
if (!["dev", "run"].includes(args[0]) && !args.includes("--help")) {
  keeper = spawn("convex", ["run", "_system/cli/tables", '{"paginationOpts":{"numItems":1,"cursor":null}}', "--watch", "--env-file", ENV_FILE], { stdio: ["ignore", "pipe", "pipe"], env, shell: false });
  try {
    await new Promise((ready, reject) => {
      const timeout = setTimeout(() => reject(new Error("Local backend startup timed out.")), 30_000);
      keeper.stdout.once("data", () => { clearTimeout(timeout); ready(); });
      keeper.once("error", reject);
      keeper.once("exit", () => { clearTimeout(timeout); reject(new Error("Local backend startup failed.")); });
    });
  } catch (error) { await stopKeeper(); console.error(error.message); restore(); process.exit(1); }
}
child = spawn("convex", [...args, "--env-file", ENV_FILE], { stdio: "inherit", env, shell: false });
child.on("error", async (error) => {
  console.error(error.message);
  await stopKeeper();
  restore();
  process.exit(1);
});
child.on("exit", async (code, signal) => {
  await stopKeeper();
  restore();
  process.exit(code ?? (signal ? 1 : 0));
});
