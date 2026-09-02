#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { config as loadEnvironment } from "dotenv";
import { FileConfigStore } from "./ticket/config";
import { MacOsKeychainCredentialStore } from "./ticket/keychain";
import { readHiddenPassword } from "./ticket/prompt";
import { ConvexTicketRemote } from "./ticket/remote";
import { runTicketCli } from "./ticket/run";

loadEnvironment({ path: [".env.local", ".env"], quiet: true });

runTicketCli(process.argv.slice(2), {
  remote: new ConvexTicketRemote(),
  config: new FileConfigStore(),
  credentials: new MacOsKeychainCredentialStore(),
  readPassword: readHiddenPassword,
  newRequestId: randomUUID,
  now: Date.now,
  env: process.env,
}).then((outcome) => {
  if (outcome.stdout) process.stdout.write(outcome.stdout);
  if (outcome.stderr) process.stderr.write(outcome.stderr);
  process.exitCode = outcome.exitCode;
});
