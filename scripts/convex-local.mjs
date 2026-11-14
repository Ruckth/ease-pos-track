#!/usr/bin/env node
// Runs the Convex CLI against the disposable local backend only.
// The CLI rewrites .env.local when it selects a deployment, so the shared
// development settings are saved first and always restored afterwards.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const ENV_FILE = ".env.convex-local";
const LOCAL_DEPLOYMENT = "anonymous:anonymous-track-ease-pos";
const SAVED = ".env.local.shared-backup";

if (!existsSync(ENV_FILE)) writeFileSync(ENV_FILE, `CONVEX_DEPLOYMENT=${LOCAL_DEPLOYMENT}\n`);
const target = /^CONVEX_DEPLOYMENT=(.*)$/m.exec(readFileSync(ENV_FILE, "utf8"))?.[1]?.trim();
if (target !== LOCAL_DEPLOYMENT) {
  console.error(`Refusing to run: ${ENV_FILE} must target ${LOCAL_DEPLOYMENT}, found ${target ?? "nothing"}.`);
  process.exit(4);
}
if (existsSync(SAVED)) {
  console.error(`Refusing to run: ${SAVED} exists from an interrupted run. Restore it to .env.local first.`);
  process.exit(4);
}

const args = process.argv.slice(2);
if (args.length === 0) args.push("dev", "--once", "--typecheck", "disable");
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

const env = { ...process.env, CONVEX_AGENT_MODE: "anonymous" };
delete env.CONVEX_DEPLOYMENT;
delete env.CONVEX_DEPLOY_KEY;
const child = spawn("convex", [...args, "--env-file", ENV_FILE], { stdio: "inherit", env, shell: false });
// Signals must not skip the restore: forward them and restore once the CLI exits.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}
process.on("exit", restore);
child.on("error", (error) => {
  console.error(error.message);
  restore();
  process.exit(1);
});
child.on("exit", (code, signal) => {
  restore();
  process.exit(code ?? (signal ? 1 : 0));
});
