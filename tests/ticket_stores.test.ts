import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TicketCliError } from "../scripts/ticket/cli";
import {
  deploymentUrl,
  FileConfigStore,
  loadOrCreateConfig,
  MacOsKeychainCredentialStore,
  normalizeDeploymentUrl,
  type ProcessResult,
} from "../scripts/ticket/stores";

test("file configuration persists only non-secret data with restrictive permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ticket-config-"));
  try {
    const path = join(directory, "nested", "ticket.json");
    const store = new FileConfigStore(path);
    const config = await loadOrCreateConfig(store, () => "stable-machine-client-id");
    config.deployments.dev = { url: "https://dev.example.com" };
    await store.save(config);

    assert.deepEqual(await store.load(), config);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, "nested"))).mode & 0o777, 0o700);
    const raw = await readFile(path, "utf8");
    assert.match(raw, /stable-machine-client-id/);
    assert.doesNotMatch(raw, /token|password|secret/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deployment selection prefers explicit and saved URLs while production remains separate", () => {
  const config = { version: 1 as const, clientId: "client", deployments: { dev: { url: "https://saved-dev.example.com" } } };
  assert.equal(deploymentUrl(config, "dev", undefined, { VITE_CONVEX_URL: "https://env-dev.example.com" }), "https://saved-dev.example.com");
  assert.equal(deploymentUrl(config, "dev", "https://explicit.example.com/", {}), "https://explicit.example.com");
  assert.throws(() => deploymentUrl(config, "prod", undefined, { CONVEX_URL: "https://must-not-be-prod.example.com" }), (error: unknown) => error instanceof TicketCliError && error.code === "DEPLOYMENT_NOT_CONFIGURED");
  assert.equal(deploymentUrl(config, "prod", undefined, { TICKET_CONVEX_PROD_URL: "https://prod.example.com" }), "https://prod.example.com");
});

test("deployment URLs refuse embedded credentials and non-http protocols", () => {
  assert.equal(normalizeDeploymentUrl(" https://dev.example.com/ "), "https://dev.example.com");
  for (const value of ["file:///tmp/convex", "https://user:pass@example.com", "https://example.com?q=secret"]) {
    assert.throws(() => normalizeDeploymentUrl(value), (error: unknown) => error instanceof TicketCliError && error.code === "INVALID_DEPLOYMENT_URL");
  }
});

test("macOS Keychain adapter never places session material in process arguments", async () => {
  const calls: Array<{ command: string; args: string[]; stdin?: string }> = [];
  const run = async (command: string, args: string[], stdin?: string): Promise<ProcessResult> => {
    calls.push({ command, args, stdin });
    if (args[0] === "find-generic-password") return { exitCode: 0, stdout: '{"token":"secret-token","expiresAt":20000,"url":"https://dev.example.com"}\n', stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const store = new MacOsKeychainCredentialStore(run, "darwin");
  await store.set("dev", { token: "secret-token", expiresAt: 20_000, url: "https://dev.example.com" });
  assert.equal(calls[0].command, "/usr/bin/security");
  assert.equal(calls[0].args.includes("secret-token"), false);
  assert.match(calls[0].stdin ?? "", /secret-token/);
  assert.equal(calls[0].args.at(-1), "-w");
  assert.equal((await store.get("dev"))?.token, "secret-token");
  await store.delete("dev");
  assert.equal(calls.at(-1)?.args[0], "delete-generic-password");
});

test("Keychain not-found, invalid content, and non-macOS access have stable behavior", async () => {
  const missing = new MacOsKeychainCredentialStore(async () => ({ exitCode: 44, stdout: "", stderr: "not found" }), "darwin");
  assert.equal(await missing.get("dev"), null);

  const invalid = new MacOsKeychainCredentialStore(async () => ({ exitCode: 0, stdout: "not-json", stderr: "" }), "darwin");
  await assert.rejects(() => invalid.get("dev"), (error: unknown) => error instanceof TicketCliError && error.code === "CREDENTIAL_INVALID");

  const unsupported = new MacOsKeychainCredentialStore(async () => ({ exitCode: 0, stdout: "", stderr: "" }), "linux");
  await assert.rejects(() => unsupported.get("dev"), (error: unknown) => error instanceof TicketCliError && error.code === "KEYCHAIN_UNAVAILABLE");
});
