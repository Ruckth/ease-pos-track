import { readFileSync } from "node:fs";
import { join } from "node:path";

// Agent-mode CLIs create anonymous-agent; older checkouts have another name.
// Read only this checkout's local backend configuration, never shared env files.
export function localDeploymentName(directory = process.cwd()) {
  let config;
  try {
    config = JSON.parse(readFileSync(join(directory, ".convex/local/default/config.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("LOCAL_DEPLOYMENT_REFUSED");
  }
  const name = config?.deploymentName;
  if (typeof name !== "string" || !/^anonymous-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error("LOCAL_DEPLOYMENT_REFUSED");
  return name;
}

export function localResetTarget(directory = process.cwd()) {
  const name = localDeploymentName(directory);
  // Reset must never label a manifest with a guessed identity. Setup first.
  if (!name) throw new Error("RESET_LOCAL_TARGET_UNAVAILABLE: run pnpm convex:local first");
  return `anonymous:${name}`;
}

export function validateDevelopmentTarget(actual, expected) {
  if (!actual || !/^dev:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(actual)
    || /prod|production|live/i.test(actual) || actual !== expected) {
    throw new Error("RESET_TARGET_REFUSED");
  }
  return actual;
}
