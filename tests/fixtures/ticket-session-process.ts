// One Ticket CLI process with the real orchestration, HTTP client, Keychain adapter
// and session lock. Only `/usr/bin/security` (files in FIXTURE_DIR) and the
// deployment (a loopback server owned by the test) are fake.
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FileConfigStore } from "../../scripts/ticket/config";
import { MacOsKeychainCredentialStore, type ProcessResult } from "../../scripts/ticket/keychain";
import { ConvexTicketRemote } from "../../scripts/ticket/remote";
import { runTicketCli } from "../../scripts/ticket/run";

setTimeout(() => process.exit(99), 30_000).unref();
const dir = process.env.FIXTURE_DIR!;
const ok = (stdout = ""): ProcessResult => ({ exitCode: 0, stdout, stderr: "" });
const missing: ProcessResult = { exitCode: 44, stdout: "", stderr: "The specified item could not be found in the keychain." };

/** Emulates the three `security` invocations the adapter makes; each write is an atomic rename. */
async function security(_command: string, args: string[], stdin?: string): Promise<ProcessResult> {
  const words = args[0] === "-i" ? (stdin ?? "").trim().split(" ") : args;
  const item = join(dir, `keychain-${words[words.indexOf("-a") + 1]}`);
  switch (words[0]) {
    case "find-generic-password":
      try { return ok(`${await readFile(item, "utf8")}\n`); } catch { return missing; }
    case "add-generic-password": {
      const temporary = `${item}.${randomUUID()}`;
      await writeFile(temporary, words[words.indexOf("-w") + 1]);
      await rename(temporary, item);
      return ok();
    }
    case "delete-generic-password":
      try { await rm(item); return ok(); } catch { return missing; }
    default:
      return { exitCode: 1, stdout: "", stderr: `unexpected security call ${words[0]}` };
  }
}

const remote = new ConvexTicketRemote();
const outcome = await runTicketCli(process.argv.slice(2), {
  remote,
  config: new FileConfigStore(join(dir, "ticket.json")),
  credentials: new MacOsKeychainCredentialStore(security, "darwin", join(dir, "ticket.lock")),
  signIn: url => remote.signInLocalFixture(url, "owner@fixture.test"),
  newRequestId: randomUUID,
  now: Date.now,
  env: {},
  images: { prepare: async () => [], upload: async () => [] },
});
if (outcome.stdout) process.stdout.write(outcome.stdout);
if (outcome.stderr) process.stderr.write(outcome.stderr);
process.exitCode = outcome.exitCode;
