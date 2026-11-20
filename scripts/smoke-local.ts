/** Exercises the real CLI orchestration/adapter without Keychain, provider I/O or remote targets. */
import assert from "node:assert/strict";
import { loadPorts } from "./worktree-ports.mjs";
import { randomUUID } from "node:crypto";
import { runTicketCli, type TicketCliDeps } from "./ticket/run";
import { ConvexTicketRemote } from "./ticket/remote";
import type { TicketConfig } from "./ticket/config";
import type { StoredCredential } from "./ticket/keychain";

const url = `http://127.0.0.1:${loadPorts().CONVEX_CLOUD_PORT}`;
let configuration: TicketConfig = { version: 1, clientId: "local-cli-smoke-client", deployments: { dev: { url } } };
let credential: StoredCredential | null = null;
const remote = new ConvexTicketRemote();
const deps: TicketCliDeps = {
  remote,
  config: {
    load: async () => configuration,
    save: async value => { configuration = value; },
  },
  credentials: {
    get: async () => credential,
    set: async (_target, value) => { credential = value; },
    delete: async () => { credential = null; },
    exclusive: fn => fn(),
  },
  images: {
    prepare: async () => { throw new Error("Text-only smoke cannot prepare uploads"); },
    upload: async () => { throw new Error("Text-only smoke cannot call a provider"); },
  },
  env: {}, now: Date.now, newRequestId: randomUUID,
  // The local test provider stands in for Google on the disposable backend.
  signIn: async target => await remote.signInLocalFixture(target, "owner@local.test"),
};

async function command(args: string[], exitCode = 0) {
  const outcome = await runTicketCli(args, deps);
  assert.equal(outcome.exitCode, exitCode, outcome.stderr);
  const output = exitCode === 0 ? outcome.stdout : outcome.stderr;
  assert.equal(output.trim().split("\n").length, 1);
  return JSON.parse(output);
}
async function main() {
await command(["login", "--url", url]);
await command(["whoami"]);
const requestId = randomUUID();
const args = ["create", "--project", "POS", "--title", "CLI local smoke", "--description", "Text only", "--request-id", requestId];
const created = await command(args);
assert.equal(created.created, true);
assert.equal((await command(args)).created, false);
assert.equal((await command([...args.slice(0, 4), "Conflicting title", ...args.slice(5)], 5)).code, "REQUEST_ID_CONFLICT");
await command(["get", created.ticket]);
await command(["update", created.ticket, "--title", "CLI edited", "--expected-version", "0"]);
const replay = await command(args);
assert.equal(replay.created, false);
assert.equal(replay.id, created.id);
assert.equal((await command(["create", "--project", "APP", ...args.slice(3)], 5)).code, "REQUEST_ID_CONFLICT");
await command(["status", created.ticket, "--status", "acknowledged", "--expected-version", "1"]);
await command(["archive", created.ticket, "--expected-version", "2"]);
const restored = await command(["restore", created.ticket, "--expected-version", "3"]);
assert.equal(restored.ticket.version, 4);
assert.equal(restored.ticket.archived, false);
await command(["logout"]);
console.log(JSON.stringify({ ok: true, target: url, checks: ["login", "whoami", "create", "retry", "retry after edit", "content and Project conflict exit 5", "detail", "edit", "status", "archive", "restore", "logout", "single JSON result"] }));

}
main().catch(error => { console.error(error); process.exitCode = 1; });
