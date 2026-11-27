import { writeFileSync } from "node:fs";
import { ConvexTicketRemote } from "./ticket/remote";
import { isLoopbackDeployment } from "./ticket/google-login";
import { seedAsOwner } from "./dev-reset/session";

/**
 * Local rehearsal only, run under `dev --once --start` so the disposable
 * backend stays up. The bootstrapped Owner signs in through the loopback
 * fixture (the server also requires LOCAL_FIXTURES_ENABLED and a loopback
 * deployment). Development signs the Owner in with Google in dev-reset.ts.
 */
const LOCAL_OWNER_EMAIL = "owner@local.test";

async function main() {
  const url = process.env.DEV_RESET_URL;
  const customer = process.env.DEV_RESET_CUSTOMER_PASSWORD;
  const resultFile = process.env.DEV_RESET_RESULT_FILE;
  if (!url || !isLoopbackDeployment(url) || !customer || !resultFile) throw new Error("RESET_SEED_CONFIGURATION_REQUIRED");
  const owner = await new ConvexTicketRemote().signInLocalFixture(url, LOCAL_OWNER_EMAIL);
  if (!owner) throw new Error("RESET_OWNER_SESSION_REQUIRED");
  writeFileSync(resultFile, JSON.stringify(await seedAsOwner(url, owner, customer)), { mode: 0o600 });
}
main().catch(error => {
  const message = `RESET_SEED_OR_VERIFICATION_FAILED: ${error instanceof Error ? error.message.split("\n")[0] : "unknown"}`;
  // `dev --start` does not propagate this exit status; the private result file carries the failure.
  if (process.env.DEV_RESET_RESULT_FILE) writeFileSync(process.env.DEV_RESET_RESULT_FILE, JSON.stringify({ ok: false, error: message }), { mode: 0o600 });
  console.error(message);
  process.exitCode = 1;
});
