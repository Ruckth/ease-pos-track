/** Exercises the real CLI orchestration/adapter without Keychain, provider I/O or remote targets. */
import { pageFormData } from "../shared/ticket-pages";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { runTicketCli, type TicketCliDeps } from "./ticket/run";
import { ConvexTicketRemote } from "./ticket/remote";
import type { TicketConfig } from "./ticket/config";
import type { StoredCredential } from "./ticket/keychain";
import { loadPorts } from "./worktree-ports.mjs";

const url = `http://127.0.0.1:${loadPorts().CONVEX_CLOUD_PORT}`;
const pageFixture = "tests/fixtures/ticket-page";
let configuration: TicketConfig = { version: 1, clientId: "local-cli-smoke-client", deployments: { dev: { url } } };
let credential: StoredCredential | null = null;
const deps: TicketCliDeps = {
  remote: new ConvexTicketRemote(),
  config: {
    load: async () => configuration,
    save: async value => { configuration = value; },
  },
  credentials: {
    get: async () => credential,
    set: async (_target, value) => { credential = value; },
    delete: async () => { credential = null; },
  },
  images: {
    prepare: async () => { throw new Error("Text-only smoke cannot prepare uploads"); },
    upload: async () => { throw new Error("Text-only smoke cannot call a provider"); },
  },
  env: {}, now: Date.now, newRequestId: randomUUID,
  readPassword: async () => "LocalStaff123!",
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
// Hosted pages: folder with a nested entry, retry, conflict, serving and revocation.
assert.equal((await command(["page", "publish", created.ticket, pageFixture], 3)).code, "PAGE_ENTRY_REQUIRED");
const pageArgs = ["page", "publish", created.ticket, pageFixture, "--entry", "reports/summary.html", "--request-id", randomUUID()];
const published = await command(pageArgs);
assert.equal(published.created, true);
assert.equal(published.fileCount, 7);
assert.match(published.url, /\/p\/[A-Za-z0-9_-]{43}\/reports\/summary\.html$/);
const replayed = await command(pageArgs);
assert.equal(replayed.created, false);
assert.equal(replayed.url, published.url);
assert.equal((await command([...pageArgs.slice(0, 5), "reports/details.html", ...pageArgs.slice(6)], 5)).code, "PAGE_REQUEST_CONFLICT");
const entry = await fetch(published.url);
assert.equal(entry.status, 200);
assert.match(entry.headers.get("content-security-policy") ?? "", /^sandbox allow-scripts;/);
assert.equal(entry.headers.get("cache-control"), "no-store");
const asset = await fetch(new URL("../assets/img/dot.png", published.url));
assert.match(asset.headers.get("content-type") ?? "", /^image\/(png|webp|avif|jpeg)$/);
const single = await command(["page", "publish", created.ticket, `${pageFixture}/reports/details.html`]);
assert.match(single.url, /\/details\.html$/);
const listed = await command(["page", "list", created.ticket]);
assert.equal(listed.count, 2);
assert.equal((await command(["page", "revoke", created.ticket, "--page", published.pageId])).revoked, true);
assert.equal((await fetch(published.url)).status, 404);
assert.equal((await fetch(new URL("../assets/img/dot.png", published.url))).status, 404);
assert.equal((await command(["page", "list", created.ticket])).count, 1);
// Exercise both sides of the Node action transport limit on the real backend.
const padding = " ".repeat(5 * 1024 * 1024);
const png = await readFile(pageFixture + "/assets/img/dot.png");
const html = new Blob(['<!--', padding, '--><img src="data:image/png;base64,', png.toString("base64"), '">']);
const session = await deps.credentials.get("dev");
assert(session);
const large = await fetch(new URL("/v1/tickets/" + created.ticket + "/pages", published.url), {
  method: "POST",
  headers: { Authorization: "Bearer " + session.token, "Idempotency-Key": randomUUID() },
  body: pageFormData("large.html", [{ path: "large.html", blob: html }]),
});
const result = await large.json();
assert.equal(large.status, 201, result.code);
assert((await (await fetch(result.url)).text()).includes(padding));
await command(["logout"]);
console.log(JSON.stringify({ ok: true, target: url, checks: ["login", "whoami", "create", "retry", "retry after edit", "content and Project conflict exit 5", "detail", "edit", "status", "archive", "restore",
  "page entry required", "page folder publish", "page replay", "page conflict exit 5", "page headers", "nested asset", "single-file page", "page list", "page revoke stops HTML and assets", "large HTML round trip", "logout", "single JSON result"] }));

}
main().catch(error => { console.error(error); process.exitCode = 1; });
