/** Fail closed: fixture access and detailed errors are local opt-ins only. */
export function localFixturesEnabled() {
  let host: string | undefined;
  try { host = new URL(process.env.CONVEX_CLOUD_URL ?? "").hostname; } catch { /* Fail closed. */ }
  return process.env.LOCAL_FIXTURES_ENABLED === "true"
    && ["127.0.0.1", "localhost", "[::1]"].includes(host ?? "");
}

export function requireLocalFixtures() {
  if (!localFixturesEnabled()) throw new Error("LOCAL_FIXTURES_DISABLED");
}
