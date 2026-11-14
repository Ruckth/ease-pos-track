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
      args: ["dev", "--typecheck", "disable", "--local-cloud-port", "3212", "--local-site-port", "3213", "--env-file", ".env.convex-local"],
      mode: "anonymous",
    });
    assert.equal(readFileSync(join(dir, ".env.local"), "utf8"), "SHARED_SETTINGS=preserve\n");
    assert.equal(existsSync(join(dir, ".env.local.shared-backup")), false);
    const scripts = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8")).scripts;
    assert.equal(scripts["dev:convex"], "node scripts/convex-local.mjs dev");
    assert.equal(scripts.dev, "node scripts/dev.mjs");
    assert.ok(readFileSync(resolve(import.meta.dirname, "../scripts/dev.mjs"), "utf8").includes("pnpm run dev:convex"));

    // A worktree's claimed ports pin its own backend.
    writeFileSync(join(dir, ".env.worktree"), "CONVEX_CLOUD_PORT=4010\nCONVEX_SITE_PORT=4011\n");
    assert.equal(spawnSync("pnpm", ["convex:local"], { cwd: dir, encoding: "utf8" }).status, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "args.json"), "utf8")).args, [
      "dev", "--once", "--typecheck", "disable", "--local-cloud-port", "4010", "--local-site-port", "4011", "--env-file", ".env.convex-local",
    ]);
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

test("wrapper refuses deployment overrides and unrecorded reset identities without invoking the CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "ticket-reset-wrapper-"));
  try {
    const wrapper = resolve(import.meta.dirname, "../scripts/convex-local.mjs");
    writeFileSync(join(dir, ".env.local"), "CONVEX_DEPLOYMENT=prod:never\n");
    for (const args of [["deploy"], ["run", "auth:currentSession", "{}", "--prod"], ["export", "--deployment=production"], ["--reset-development"], ["--reset-development", "dev:wrong", "export"], ["--reset-development", "prod:never", "dev"]]) {
      const run = spawnSync(process.execPath, [wrapper, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: "" } });
      assert.equal(run.status, 4, run.stderr);
      assert.equal(existsSync(join(dir, ".env.local.shared-backup")), false);
      assert.equal(readFileSync(join(dir, ".env.local"), "utf8"), "CONVEX_DEPLOYMENT=prod:never\n");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("local wrapper refuses even the recorded development identity and credential overrides in its local file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ticket-recorded-wrapper-"));
  try {
    const wrapper = resolve(import.meta.dirname, "../scripts/convex-local.mjs");
    const { deployment } = JSON.parse(readFileSync(resolve(import.meta.dirname, "../scripts/dev-reset.config.json"), "utf8"));
    const settings = `CONVEX_DEPLOYMENT=${deployment}\n`;
    writeFileSync(join(dir, ".env.local"), settings);
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin/convex"), `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync("invocation.json", JSON.stringify({args:process.argv.slice(2),target:process.env.CONVEX_DEPLOYMENT,key:process.env.CONVEX_DEPLOY_KEY,host:process.env.CONVEX_SELF_HOSTED_URL,mode:process.env.CONVEX_AGENT_MODE}));
fs.writeFileSync(".env.local", "CLI_CHANGED_SETTINGS=true");
`, { mode: 0o755 });
    const result = spawnSync(process.execPath, [wrapper, "--reset-development", deployment, "env", "list"], {
      cwd: dir, encoding: "utf8", env: { ...process.env, PATH: join(dir, "bin"), CONVEX_DEPLOYMENT: "prod:never", CONVEX_DEPLOY_KEY: "fake", CONVEX_SELF_HOSTED_URL: "https://never.invalid", CONVEX_AGENT_MODE: "anonymous" },
    });
    assert.equal(result.status, 4, result.stderr);
    assert.equal(existsSync(join(dir, "invocation.json")), false);
    assert.equal(readFileSync(join(dir, ".env.local"), "utf8"), settings);
    assert.equal(existsSync(join(dir, ".env.local.shared-backup")), false);
    for (const key of ["CONVEX_DEPLOY_KEY", "CONVEX_DEPLOYMENT_TOKEN", "CONVEX_SELF_HOSTED_URL"]) {
      writeFileSync(join(dir, ".env.convex-local"), `CONVEX_DEPLOYMENT=anonymous:anonymous-track-ease-pos\n${key}=never\n`);
      const refused = spawnSync(process.execPath, [wrapper, "dev"], { cwd: dir, encoding: "utf8" });
      assert.equal(refused.status, 4);
      assert.equal(existsSync(join(dir, "invocation.json")), false);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("local wrapper allows only approved commands and help before any CLI or file mutation", () => {
  const dir = mkdtempSync(join(tmpdir(), "ticket-wrapper-allowlist-"));
  try {
    const wrapper = resolve(import.meta.dirname, "../scripts/convex-local.mjs");
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin/convex"), `#!${process.execPath}
require("node:fs").writeFileSync("invoked", "yes");
`, { mode: 0o755 });
    const env = { ...process.env, PATH: join(dir, "bin") };
    for (const args of [["deploy"], ["deploy", "--help"], ["login"], ["logout"], ["dashboard"], ["update"], ["unknown"], ["--version"]]) {
      const result = spawnSync(process.execPath, [wrapper, ...args], { cwd: dir, env, encoding: "utf8" });
      assert.equal(result.status, 4, result.stderr);
      assert.equal(existsSync(join(dir, "invoked")), false);
      assert.equal(existsSync(join(dir, ".env.convex-local")), false);
    }
    for (const command of ["dev", "run", "env", "import", "export", "data", "codegen", "--help"]) {
      const result = spawnSync(process.execPath, [wrapper, command, ...(command === "--help" ? [] : ["--help"])], { cwd: dir, env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(join(dir, "invoked")), true);
      rmSync(join(dir, "invoked"));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
