// All backend CLI operations pass through the local safety wrapper, sequentially.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
function local(args, capture = false) {
  const result = spawnSync("pnpm", ["convex:local", ...args], { stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit", encoding: "utf8", env: process.env });
  if (result.status !== 0) throw new Error(`Local browser command failed (${result.status ?? 1})`, { cause: result.error });
  return result.stdout;
}
local(["env", "set", "MEDIA_CLEANUP_ENABLED", "false"]);
local([]);
for (const [key, value] of Object.entries({ LOCAL_FIXTURES_ENABLED: "true", APP_PASSWORD: "LocalStaff123!", CUSTOMER_PASSWORD_PEPPER: "local-only-fixture-pepper", UPLOAD_CALLBACK_SECRET: "local-only-callback-fixture" })) local(["env", "set", key, value]);
const seed = JSON.parse(local(["run", "seed:run", '{"largeDataset":true}'], true));
process.env.BROWSER_FIXTURE = JSON.stringify(seed);
const directory = mkdtempSync(path.join(tmpdir(), "ticket-browser-"));
process.env.BROWSER_RESULT_FILE = path.join(directory, "result.json");
try {
  local(["dev", "--once", "--typecheck", "disable", "--start", "pnpm exec tsx scripts/browser-tests.ts"]);
  // Convex logs a failed --start command but may itself exit zero.
  const result = JSON.parse(readFileSync(process.env.BROWSER_RESULT_FILE, "utf8"));
  process.exitCode = result.exitCode;
} catch (error) {
  console.error("Browser checks did not complete:", error.message);
  process.exitCode = 1;
} finally { rmSync(directory, { recursive: true, force: true }); }
