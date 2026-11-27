import { isLoopbackOrigin, legacyMode } from "../shared/pilot-settings";

/** Fail closed: fixture access and detailed errors are local opt-ins only. */
export function localFixturesEnabled() {
  return process.env.LOCAL_FIXTURES_ENABLED === "true"
    && isLoopbackOrigin(process.env.CONVEX_CLOUD_URL)
    && legacyMode(process.env, true);
}

export function requireLocalFixtures() {
  if (!localFixturesEnabled()) throw new Error("LOCAL_FIXTURES_DISABLED");
}
