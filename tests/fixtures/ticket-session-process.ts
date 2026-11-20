// One Ticket CLI process with the real orchestration, HTTP client, Keychain adapter
// and session lock. Only `/usr/bin/security` (files in FIXTURE_DIR) and the
// deployment (a loopback server owned by the test) are fake.
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { FileConfigStore } from "../../scripts/ticket/config";
import { MacOsKeychainCredentialStore } from "../../scripts/ticket/keychain";
import { ConvexTicketRemote } from "../../scripts/ticket/remote";
import { runTicketCli } from "../../scripts/ticket/run";

setTimeout(() => process.exit(99), 30_000).unref();
const dir = process.env.FIXTURE_DIR!;
const securityBinary = fileURLToPath(new URL("./ticket-security.mjs", import.meta.url));

const remote = new ConvexTicketRemote();
const outcome = await runTicketCli(process.argv.slice(2), {
  remote,
  config: new FileConfigStore(join(dir, "ticket.json")),
  credentials: new MacOsKeychainCredentialStore(undefined, "darwin", join(dir, "ticket.lock"), securityBinary),
  signIn: url => remote.signInLocalFixture(url, "owner@fixture.test"),
  newRequestId: randomUUID,
  now: Date.now,
  env: {},
  images: { prepare: async () => [], upload: async () => [] },
});
if (outcome.stdout) process.stdout.write(outcome.stdout);
if (outcome.stderr) process.stderr.write(outcome.stderr);
process.exitCode = outcome.exitCode;
