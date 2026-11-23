#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { config as loadEnvironment } from "dotenv";
import { FileConfigStore } from "./ticket/config";
import { MacOsKeychainCredentialStore } from "./ticket/keychain";
import { ConvexTicketRemote } from "./ticket/remote";
import { googleLoopbackSignIn, isLoopbackDeployment } from "./ticket/google-login";
import { UploadThingTicketImages } from "./ticket/images";
import { runTicketCli } from "./ticket/run";

loadEnvironment({ path: [".env.local", ".env"], quiet: true });

const remote = new ConvexTicketRemote();
const fixtureEmail = process.env.TICKET_LOCAL_FIXTURE_EMAIL;

runTicketCli(process.argv.slice(2), {
  remote,
  config: new FileConfigStore(),
  credentials: new MacOsKeychainCredentialStore(),
  // Named staff identity only. The local test provider works only against a
  // loopback deployment with LOCAL_FIXTURES_ENABLED; the server enforces it too.
  signIn: url => fixtureEmail && isLoopbackDeployment(url)
    ? remote.signInLocalFixture(url, fixtureEmail)
    : googleLoopbackSignIn(remote, url, { port: Number(process.env.TICKET_LOGIN_PORT) || undefined }),
  newRequestId: randomUUID,
  now: Date.now,
  env: process.env,
  images: new UploadThingTicketImages(process.env.UPLOADTHING_TOKEN),
}).then((outcome) => {
  if (outcome.stdout) process.stdout.write(outcome.stdout);
  if (outcome.stderr) process.stderr.write(outcome.stderr);
  process.exitCode = outcome.exitCode;
});
