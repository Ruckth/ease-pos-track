// Real command orchestration, HTTP client and terminal prompt; all external I/O is fake.
import assert from "node:assert/strict";
import { ConvexTicketRemote } from "../../scripts/ticket/remote";
import { readHiddenPassword } from "../../scripts/ticket/prompt";
import { runTicketCli } from "../../scripts/ticket/run";
import type { TicketConfig } from "../../scripts/ticket/config";

// A leaked handle must fail the subprocess test, rather than strand its runner.
setTimeout(() => process.exit(99), 5_000).unref();
globalThis.fetch = async (_request, init) => {
  const { path, args } = JSON.parse(String(init?.body));
  let value: unknown;
  switch (path) {
    case "auth:login":
      if (args[0].password === "wrong-password") {
        return Response.json({ status: "error", errorMessage: "INCORRECT_PASSWORD", logLines: [] });
      }
      assert.equal(args[0].password, "fixture-password");
      value = { token: "fake-token", expiresAt: 20_000 };
      break;
    case "auth:currentSession":
      value = { role: "staff", expiresAt: 20_000, customerId: null, email: null };
      break;
    case "auth:logout": value = null; break;
    case "projects:listProjects": value = []; break;
    default: throw new Error(`Unexpected fake request: ${path}`);
  }
  return Response.json({ status: "success", value, logLines: [] });
};
let config: TicketConfig = { version: 1, clientId: "fixture-client", deployments: { dev: { url: "https://fixture.invalid" } } };
const outcome = await runTicketCli(process.argv.slice(2), {
  remote: new ConvexTicketRemote(),
  config: { load: async () => config, save: async value => { config = value; } },
  credentials: {
    get: async () => ({ token: "fake-token", expiresAt: 20_000, url: "https://fixture.invalid" }),
    set: async () => {}, delete: async () => {},
  },
  readPassword: readHiddenPassword,
  newRequestId: () => "fixture-request",
  now: () => 10_000,
  env: {},
  images: { prepare: async () => [], upload: async () => [] },
});
if (outcome.stdout) process.stdout.write(outcome.stdout);
if (outcome.stderr) process.stderr.write(outcome.stderr);
process.exitCode = outcome.exitCode;
