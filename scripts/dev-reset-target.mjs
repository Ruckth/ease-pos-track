import { existsSync, readFileSync } from "node:fs";

// Convex agent mode stores its identity per checkout. Never derive a remote
// target from this file, and never include the local admin credential in output.
const localConfig = ".convex/local/default/config.json";
const localName = existsSync(localConfig)
  ? JSON.parse(readFileSync(localConfig, "utf8")).deploymentName
  : "anonymous-agent";
if (typeof localName !== "string" || !/^anonymous-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(localName)) {
  throw new Error("LOCAL_DEPLOYMENT_INVALID");
}
export const LOCAL_RESET_TARGET = `anonymous:${localName}`;

export function validateDevelopmentTarget(actual, expected) {
  if (!actual || !/^dev:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(actual)
    || /prod|production|live/i.test(actual) || actual !== expected) {
    throw new Error("RESET_TARGET_REFUSED");
  }
  return actual;
}
