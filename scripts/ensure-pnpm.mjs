#!/usr/bin/env node
/**
 * Install-time guard: this project is installed with pnpm only.
 *
 * Wired through the `preinstall` script, so it runs before any dependency is
 * fetched and before any dependency could be imported. That is why it uses only
 * Node builtins: at this point `node_modules` may not exist at all.
 *
 * Every package manager exports `npm_config_user_agent` to lifecycle scripts
 * ("pnpm/11.5.2 npm/? node/v22 …"), so the leading token identifies the real
 * caller. `npm_execpath` is the fallback for wrappers that drop the user agent.
 * Both checks test pnpm before npm because "pnpm" contains "npm".
 */

import { pathToFileURL } from "node:url";

/** Package managers this project refuses to be installed with, and how to name them. */
const REFUSED = { npm: "npm", yarn: "Yarn", bun: "Bun" };

const KNOWN = ["pnpm", ...Object.keys(REFUSED)];

/** The leading token of a lifecycle user agent, e.g. "pnpm/11.5.2 npm/? …" -> "pnpm". */
function fromUserAgent(userAgent) {
  if (typeof userAgent !== "string") return undefined;
  const name = userAgent.trim().split(/\s+/)[0].split("/")[0].toLowerCase();
  return KNOWN.includes(name) ? name : undefined;
}

/** The executable that is running us, e.g. ".../pnpm.cjs" -> "pnpm". Windows-safe. */
function fromExecPath(execPath) {
  if (typeof execPath !== "string" || execPath.trim() === "") return undefined;
  const file = execPath.replace(/\\/g, "/").split("/").pop().toLowerCase();
  return KNOWN.find((name) => file.includes(name));
}

/**
 * Names the package manager driving this install, or undefined when nothing in the
 * environment says. Unknown callers are allowed: the guard blocks what it recognises
 * as wrong rather than guessing that anything unfamiliar is.
 */
export function detectPackageManager(env = process.env) {
  return fromUserAgent(env.npm_config_user_agent) ?? fromExecPath(env.npm_execpath);
}

/** The message a refused install sees, telling it what to run instead. */
export function refusalMessage(detected) {
  return [
    `This project is installed with pnpm, but ${REFUSED[detected] ?? detected} is running the install.`,
    "",
    "  Run:  pnpm install",
    "",
    "No pnpm yet? Use `corepack enable pnpm`, or see https://pnpm.io/installation.",
    "The pnpm version this project expects is the `packageManager` field in package.json.",
  ].join("\n");
}

/** Exit code 1 with the reason on stderr when the caller is refused; silent otherwise. */
export function enforcePnpm(env = process.env) {
  const detected = detectPackageManager(env);
  if (detected === undefined || !(detected in REFUSED)) return 0;
  process.stderr.write(`${refusalMessage(detected)}\n`);
  return 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = enforcePnpm();
}
