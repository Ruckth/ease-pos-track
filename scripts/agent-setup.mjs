#!/usr/bin/env node
// `pnpm agent:setup`: make a fresh git worktree ready for `pnpm dev` and
// `pnpm check` in one step. Idempotent; safe to re-run.
//   1. copy .env.local from the main checkout (it is gitignored)
//   2. claim a free port slot and write .env.worktree
//   3. install dependencies from the shared pnpm store
//   4. start this checkout's own local Convex backend and push the schema
// Node builtins only: this runs before node_modules exists.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { PORTS_FILE, loadPorts, portsForSlot, readPortsFile } from "./worktree-ports.mjs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const here = git("rev-parse", "--show-toplevel");
const main = path.dirname(git("rev-parse", "--path-format=absolute", "--git-common-dir"));
const isMain = path.resolve(here) === path.resolve(main);

function run(command, args) {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit", cwd: here });
  if (result.status !== 0) {
    console.error(`agent:setup failed at: ${command} ${args.join(" ")}`);
    process.exit(result.status ?? 1);
  }
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer().once("error", () => resolve(false));
    server.listen(port, () => server.close(() => resolve(true)));
  });
}

/** Atomic mkdir lock in the shared .git dir, so concurrent setups never pick the same slot. */
async function withLock(fn) {
  const lock = path.join(main, ".git", "agent-setup.lock");
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (Date.now() - statSync(lock, { throwIfNoEntry: false })?.mtimeMs > 60_000) rmSync(lock, { recursive: true, force: true });
      if (attempt > 600) throw new Error(`Timed out waiting for ${lock}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

async function claimPorts() {
  const worktrees = git("worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
  const taken = new Set(worktrees.map((dir) => readPortsFile(dir)?.CONVEX_CLOUD_PORT).filter(Boolean));
  for (let slot = 1; slot < 100; slot++) {
    const ports = portsForSlot(slot);
    if (taken.has(ports.CONVEX_CLOUD_PORT)) continue;
    const free = await Promise.all(Object.values(ports).map(portFree));
    if (free.every(Boolean)) {
      writeFileSync(path.join(here, PORTS_FILE), Object.entries(ports).map(([k, v]) => `${k}=${v}\n`).join(""));
      return;
    }
  }
  throw new Error("No free port slot between 4010 and 4999");
}

if (!isMain && !existsSync(path.join(here, ".env.local")) && existsSync(path.join(main, ".env.local"))) {
  copyFileSync(path.join(main, ".env.local"), path.join(here, ".env.local"));
  console.log("Copied .env.local from the main checkout.");
}

if (!isMain && !readPortsFile(here)) await withLock(claimPorts);

if (!existsSync(path.join(here, "node_modules"))) run("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"]);

run("node", ["scripts/convex-local.mjs"]);

const ports = loadPorts(here);
console.log(`
Ready. This checkout uses:
  web     http://localhost:${ports.VITE_PORT}
  api     http://localhost:${ports.UPLOAD_API_PORT}
  convex  http://127.0.0.1:${ports.CONVEX_CLOUD_PORT} (site ${ports.CONVEX_SITE_PORT})
Next: pnpm dev, or pnpm check before reporting work as done.`);
