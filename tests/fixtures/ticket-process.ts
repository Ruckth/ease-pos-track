// Real command orchestration, HTTP client and loopback sign-in listener; all external I/O is fake.
import assert from "node:assert/strict";
import { get } from "node:http";
import { ConvexTicketRemote } from "../../scripts/ticket/remote";
import { googleLoopbackSignIn } from "../../scripts/ticket/google-login";
import { runTicketCli } from "../../scripts/ticket/run";
import type { TicketConfig } from "../../scripts/ticket/config";

// A leaked handle must fail the subprocess test, rather than strand its runner.
setTimeout(() => process.exit(99), 5_000).unref();
const tokens = { accessToken: "fake-access", refreshToken: "fake-refresh", refreshTokenExpiresAt: 20_000, userId: "user" };
globalThis.fetch = async (_request, init) => {
  const { path, args } = JSON.parse(String(init?.body));
  let value: unknown;
  switch (path) {
    case "auth:startSignInWithGoogle":
      assert.match(args[0].redirectTo, /^http:\/\/127\.0\.0\.1:\d+\/$/);
      value = { redirect: "https://accounts.google.com/o/oauth2/v2/auth?fixture", state: "fixture-state" };
      break;
    case "auth:completeSignInWithGoogle":
      assert.equal(args[0].state, "fixture-state");
      value = args[0].code === "fixture-code" ? { status: "complete", tokens } : { status: "error", userError: { error: "INVALID_CODE" } };
      break;
    case "auth:refreshSession": value = { kind: "rotated", tokens }; break;
    case "identity:viewer": value = { kind: "staff", staffId: "staff", role: "owner", name: "Fixture Owner", email: "owner@fixture.test" }; break;
    case "auth:signOut": value = null; break;
    case "projects:listProjects": value = []; break;
    default: throw new Error(`Unexpected fake request: ${path}`);
  }
  return Response.json({ status: "success", value, logLines: [] });
};
let config: TicketConfig = { version: 1, clientId: "fixture-client", deployments: { dev: { url: "https://fixture.invalid" } } };
const remote = new ConvexTicketRemote();
const code = process.env.FIXTURE_GOOGLE_CODE ?? "fixture-code";
const outcome = await runTicketCli(process.argv.slice(2), {
  remote,
  config: { load: async () => config, save: async value => { config = value; } },
  credentials: {
    get: async () => ({ token: "fake-refresh", expiresAt: 20_000, url: "https://fixture.invalid" }),
    set: async () => {}, delete: async () => {},
  },
  // The browser is simulated by requesting the loopback redirect directly.
  signIn: url => googleLoopbackSignIn(remote, url, {
    port: 47_231,
    open: () => { get(`http://127.0.0.1:47231/?convexAuthCode=${code}`, response => response.resume()); },
  }),
  newRequestId: () => "fixture-request",
  now: () => 10_000,
  env: {},
  images: { prepare: async () => [], upload: async () => [] },
});
if (outcome.stdout) process.stdout.write(outcome.stdout);
if (outcome.stderr) process.stderr.write(outcome.stderr);
process.exitCode = outcome.exitCode;
