import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const GUARD = fileURLToPath(new URL("../scripts/ensure-pnpm.mjs", import.meta.url));

/**
 * Runs the guard the way a lifecycle script would, with only the two variables a
 * package manager exports to say who it is. The npm/yarn/bun strings below are the
 * negative cases the guard exists for.
 */
function runGuard(env: Record<string, string>) {
  const result = spawnSync(process.execPath, [GUARD], {
    encoding: "utf8",
    env: { ...process.env, npm_config_user_agent: "", npm_execpath: "", ...env },
  });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

test("pnpm is allowed to install, silently", () => {
  const byUserAgent = runGuard({ npm_config_user_agent: "pnpm/11.5.2 npm/? node/v22.5.1 darwin arm64" });
  assert.equal(byUserAgent.status, 0);
  assert.equal(byUserAgent.stderr, "");
  assert.equal(byUserAgent.stdout, "");

  const byExecPath = runGuard({ npm_execpath: "/opt/homebrew/lib/node_modules/pnpm/bin/pnpm.cjs" });
  assert.equal(byExecPath.status, 0);
  assert.equal(byExecPath.stderr, "");
});

test("npm, yarn and bun are refused with a nonzero exit and the pnpm command to run", () => {
  const cases = [
    ["npm/10.8.2 node/v22.5.1 darwin arm64", "npm"],
    ["yarn/1.22.22 npm/? node/v22.5.1 darwin arm64", "Yarn"],
    ["bun/1.1.29 npm/? node/v22.5.1 darwin arm64", "Bun"],
  ] as const;

  for (const [userAgent, name] of cases) {
    const result = runGuard({ npm_config_user_agent: userAgent });
    assert.equal(result.status, 1, `${name} should be refused`);
    assert.match(result.stderr, new RegExp(name));
    assert.match(result.stderr, /pnpm install/);
    assert.equal(result.stdout, "");
  }
});

test("a wrapper that drops the user agent is still identified by its executable", () => {
  const npm = runGuard({ npm_execpath: "/usr/local/lib/node_modules/npm/bin/npm-cli.js" });
  assert.equal(npm.status, 1);
  assert.match(npm.stderr, /npm/);

  const yarn = runGuard({ npm_execpath: "C:\\Program Files\\nodejs\\node_modules\\yarn\\bin\\yarn.js" });
  assert.equal(yarn.status, 1);
  assert.match(yarn.stderr, /Yarn/);
});

test("an unrecognised caller is allowed rather than guessed at", () => {
  assert.equal(runGuard({}).status, 0);
  assert.equal(runGuard({ npm_config_user_agent: "deno/2.0.0" }).status, 0);
});
