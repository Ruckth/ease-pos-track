import { writeFileSync } from "node:fs";
import { ConvexHttpClient } from "convex/browser";
import { seedDevelopment } from "./dev-reset/seed";
import { verifyResetCli } from "./dev-reset/verify-cli";

async function main() {
  const url = process.env.DEV_RESET_URL;
  const staff = process.env.DEV_RESET_STAFF_PASSWORD;
  const customer = process.env.DEV_RESET_CUSTOMER_PASSWORD;
  const resultFile = process.env.DEV_RESET_RESULT_FILE;
  if (!url || !staff || !customer || !resultFile) throw new Error("RESET_SEED_CONFIGURATION_REQUIRED");
  const result = await seedDevelopment(new ConvexHttpClient(url), { staff, customer });
  result.checks.push(...await verifyResetCli(url, staff));
  writeFileSync(resultFile, JSON.stringify(result), { mode: 0o600 });
}
main().catch(() => { console.error("RESET_SEED_OR_VERIFICATION_FAILED"); process.exitCode = 1; });
