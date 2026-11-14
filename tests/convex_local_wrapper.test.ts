import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import test from "node:test";

// Run only the local wrapper, with a fake CLI. No backend or provider calls.
test("local wrapper forwards continuous dev arguments and restores shared environment", () => {
  const dir = mkdtempSync(join(tmpdir(), "ticket-local-wrapper-"));
  try {
    const wrapper = resolve(import.meta.dirname, "../scripts/convex-local.mjs");
    mkdirSync(join(dir, "node_modules/.bin"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { "convex:local": `node ${wrapper}` } }));
    writeFileSync(join(dir, ".env.local"), "SHARED_SETTINGS=preserve\n");
    writeFileSync(join(dir, "node_modules/.bin/convex"), `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync("args.json", JSON.stringify({ args: process.argv.slice(2), deployment: process.env.CONVEX_DEPLOYMENT, key: process.env.CONVEX_DEPLOY_KEY, mode: process.env.CONVEX_AGENT_MODE }));
fs.writeFileSync(".env.local", "CLI_SELECTED_LOCAL=true");
`, { mode: 0o755 });
    const run = spawnSync("pnpm", ["convex:local", "dev", "--typecheck", "disable"], {
      cwd: dir, encoding: "utf8", env: { ...process.env, CONVEX_DEPLOYMENT: "shared", CONVEX_DEPLOY_KEY: "fake-key" },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "args.json"), "utf8")), {
      args: ["dev", "--typecheck", "disable", "--env-file", ".env.convex-local"], mode: "anonymous",
    });
    assert.equal(readFileSync(join(dir, ".env.local"), "utf8"), "SHARED_SETTINGS=preserve\n");
    assert.equal(existsSync(join(dir, ".env.local.shared-backup")), false);
    const scripts = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8")).scripts;
    assert.equal(scripts["dev:convex"], "node scripts/convex-local.mjs dev");
    assert.ok(scripts.dev.includes("pnpm run dev:convex"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("local wrapper restores shared environment when it is terminated mid-run", async () => {
  const { spawn } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "ticket-local-wrapper-signal-"));
  try {
    const wrapper = resolve(import.meta.dirname, "../scripts/convex-local.mjs");
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, ".env.local"), "SHARED_SETTINGS=preserve\n");
    // The fake CLI selects the local deployment, reports readiness, then waits to be killed.
    writeFileSync(join(dir, "bin/convex"), `#!/usr/bin/env node
require("node:fs").writeFileSync(".env.local", "CLI_SELECTED_LOCAL=true");
console.log("ready");
setInterval(() => {}, 1000);
`, { mode: 0o755 });
    const child = spawn(process.execPath, [wrapper, "dev"], {
      cwd: dir, env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` }, stdio: ["ignore", "pipe", "inherit"],
    });
    await new Promise<void>((done) => child.stdout.on("data", (chunk) => String(chunk).includes("ready") && done()));
    const exited = new Promise((done) => child.on("exit", done));
    child.kill("SIGTERM");
    await exited;
    assert.equal(readFileSync(join(dir, ".env.local"), "utf8"), "SHARED_SETTINGS=preserve\n");
    assert.equal(existsSync(join(dir, ".env.local.shared-backup")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
