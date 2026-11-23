import { ConvexHttpClient } from "convex/browser";
import type { SessionTokens } from "../ticket/remote";
import { seedDevelopment } from "./seed";
import { verifyResetCli } from "./verify-cli";

/**
 * Seeds and verifies with the Owner's fresh post-clear session. The tokens stay
 * in this process: never printed, written or passed through the environment.
 */
export async function seedAsOwner(url: string, owner: SessionTokens, customer: string) {
  const client = (accessToken?: string) => {
    const result = new ConvexHttpClient(url, { logger: false });
    if (accessToken) result.setAuth(accessToken);
    return result;
  };
  const result = await seedDevelopment({ owner: client(owner.accessToken), anonymous: client(), signedIn: client }, { customer });
  // The CLI check rotates this same session like a saved login, then signs it out.
  result.checks.push(...await verifyResetCli(url, owner.refreshToken));
  return result;
}
