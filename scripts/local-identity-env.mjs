// The app declares its Google OAuth client as required deployment settings
// (convex/convex.config.ts). The disposable local backend gets inert
// placeholders so pushes succeed; Google sign-in stays unusable there and the
// local test provider (LOCAL_FIXTURES_ENABLED) stands in. Never run against a
// shared deployment: this goes only through the local-only wrapper.
import { spawnSync } from "node:child_process";

export const LOCAL_IDENTITY_PLACEHOLDERS = {
  CLERK_ISSUER_URL: "https://clerk.invalid",
  CLERK_OAUTH_CLIENT_ID: "local-clerk-disabled",
  CLERK_OAUTH_CLIENT_SECRET: "local-clerk-disabled",
};

/**
 * Sets any missing placeholder. A cold checkout has no local deployment until
 * the first push attempt creates it, so callers retry after that attempt; with
 * `strict` a failure to set is an error.
 */
export function ensureLocalIdentityEnv(cwd = process.cwd(), { strict = false } = {}) {
  for (const [name, value] of Object.entries(LOCAL_IDENTITY_PLACEHOLDERS)) {
    const current = spawnSync("pnpm", ["--silent", "convex:local", "env", "get", name], { cwd, encoding: "utf8" });
    if (current.status === 0 && current.stdout.trim() && !/not found/i.test(`${current.stdout}${current.stderr}`)) continue;
    const set = spawnSync("pnpm", ["--silent", "convex:local", "env", "set", name, value], { cwd, stdio: strict ? "inherit" : "ignore" });
    if (set.status !== 0 && strict) throw new Error(`LOCAL_IDENTITY_ENV_FAILED: ${name}`);
  }
}

/** Push to the disposable backend, creating it and its placeholders when cold. */
export function pushLocalWithIdentityEnv(cwd = process.cwd()) {
  ensureLocalIdentityEnv(cwd);
  if (spawnSync("pnpm", ["convex:local"], { cwd, stdio: "inherit" }).status === 0) return 0;
  ensureLocalIdentityEnv(cwd, { strict: true });
  return spawnSync("pnpm", ["convex:local"], { cwd, stdio: "inherit" }).status ?? 1;
}
