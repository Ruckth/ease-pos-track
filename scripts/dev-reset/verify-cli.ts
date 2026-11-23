import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { runTicketCli, type TicketCliDeps } from "../ticket/run";
import { ConvexTicketRemote } from "../ticket/remote";
import type { TicketConfig } from "../ticket/config";
import type { StoredCredential } from "../ticket/keychain";

/** Read the seeded installation through the real CLI adapter, without Keychain or provider access. */
export async function verifyResetCli(url: string, ownerRefreshToken: string) {
  const remote = new ConvexTicketRemote();
  let config: TicketConfig = { version: 1, clientId: randomUUID(), deployments: { dev: { url } } };
  let credential: StoredCredential | null = null;
  const deps: TicketCliDeps = {
    remote,
    config: { load: async () => config, save: async value => { config = value; } },
    credentials: { get: async () => credential, set: async (_target, value) => { credential = value; }, delete: async () => { credential = null; }, exclusive: fn => fn() },
    images: { prepare: async () => { throw new Error("RESET_CLI_UPLOAD_FORBIDDEN"); }, upload: async () => { throw new Error("RESET_CLI_UPLOAD_FORBIDDEN"); } },
    // The operator's named Owner session; the CLI rotates it like a saved login.
    env: {}, now: Date.now, newRequestId: randomUUID,
    signIn: async target => await remote.refresh(target, ownerRefreshToken),
  };
  async function command(args: string[]) {
    const result = await runTicketCli(args, deps);
    assert.equal(result.exitCode, 0, "reset CLI check failed");
    assert.equal(result.stdout.trim().split("\n").length, 1);
    return JSON.parse(result.stdout);
  }
  await command(["login", "--url", url]);
  try {
    await command(["whoami"]);
    await command(["list", "--project", "POS"]);
    await command(["get", "POS-0001"]);
  } finally { await command(["logout"]); }
  return ["CLI login/whoami/list/get/logout", "single JSON CLI result"];
}
