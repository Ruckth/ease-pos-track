import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parse } from "dotenv";
import AdmZip from "adm-zip";
import { POST_CLEAR_BLOCKED, POST_CLEAR_STAGES, reset, resume, type Manifest, type ResetBackend, type ResetConfig } from "./dev-reset/core";
import { fakeResetProvider, uploadthingResetProvider } from "./dev-reset/provider";
import { seedAsOwner } from "./dev-reset/session";
import { readSnapshot } from "./dev-reset/snapshot";
import { localResetTarget, validateDevelopmentTarget } from "./dev-reset-target.mjs";
import { loadPorts } from "./worktree-ports.mjs";
import { parseEnvironment, runDevelopment, validatePasswords, verifyDeploymentUrl } from "./dev-reset/runner";
import { ConvexTicketRemote, type SessionTokens } from "./ticket/remote";
import { googleLoopbackSignIn } from "./ticket/google-login";

const USAGE = "RESET_USAGE: inspect | execute --confirm exact-name --expect inspect-manifest | resume --confirm exact-name --expect run-manifest | env-set MEDIA_CLEANUP_ENABLED true|false | env-remove UPLOADTHING_TOKEN [--target local|development]";
/** Disposable rehearsal only: the loopback fixture Owner (convex/local_identity.ts). */
const LOCAL_OWNER_SUBJECT = "local-fixture-owner";

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { target: { type: "string" }, confirm: { type: "string" }, expect: { type: "string" } } });
  const mode = positionals[0] ?? "inspect";
  const envCommand = mode === "env-set" || mode === "env-remove";
  if ((!envCommand && (positionals.length > 1 || !["inspect", "execute", "resume"].includes(mode)))
    || (mode === "env-set" && (positionals.length !== 3 || positionals[1] !== "MEDIA_CLEANUP_ENABLED" || !["true", "false"].includes(positionals[2])))
    || (mode === "env-remove" && (positionals.length !== 2 || positionals[1] !== "UPLOADTHING_TOKEN"))
    || (values.target && !["local", "development"].includes(values.target))) throw new Error(USAGE);
  const local = values.target === "local";
  const config: ResetConfig = JSON.parse(readFileSync(resolve(import.meta.dirname, "dev-reset.config.json"), "utf8"));
  const settings = parse(readFileSync(".env.local"));
  const target = local ? localResetTarget() : validateDevelopmentTarget(settings.CONVEX_DEPLOYMENT, config.deployment);
  if ((mode === "execute" || mode === "resume") && values.confirm !== target) throw new Error("RESET_CONFIRM_REQUIRED");
  if (mode === "execute" && !values.expect) throw new Error("RESET_INSPECT_MANIFEST_REQUIRED");
  if (mode === "resume" && !values.expect) throw new Error("RESET_RUN_MANIFEST_REQUIRED");
  const expect: Manifest | undefined = values.expect ? JSON.parse(readFileSync(values.expect, "utf8")) : undefined;
  const runs = resolve(".reset");
  // Resume continues in the run's own directory, beside its snapshots and private configuration.
  const directory = mode === "resume" ? dirname(resolve(values.expect!)) : resolve(runs, `${Date.now()}-${randomUUID()}`);
  if (mode === "resume" && dirname(directory) !== runs) throw new Error("RESET_RUN_MANIFEST_REQUIRED");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(runs, 0o700);
  const url = local ? `http://127.0.0.1:${loadPorts().CONVEX_CLOUD_PORT}` : `https://${target.slice(4)}.convex.cloud`;
  // Confirm the guessed hostname serves this exact deployment before any writes.
  if (!local) await verifyDeploymentUrl(url, target);
  const suppliedCustomer = process.env.DEV_RESET_CUSTOMER_PASSWORD;
  const customer = suppliedCustomer ?? `reset passphrase 1 ${randomBytes(24).toString("base64url")}`;
  if (mode === "execute" || mode === "resume") validatePasswords([customer]);
  async function cli(args: string[], env = process.env) {
    try {
      if (!local) return await runDevelopment(args, target, config.deployment, env);
      return execFileSync("pnpm", ["--silent", "convex:local", ...args], {
        encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], env,
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("RESET_")) throw error;
      const failure = error as { stdout?: string; stderr?: string };
      writeFileSync(resolve(directory, "command-error.log"), `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`, { mode: 0o600 });
      throw new Error(`RESET_CONVEX_COMMAND_FAILED: ${args.slice(0, 2).join(" ")} (private details in ${directory}/command-error.log; manifests retained)`);
    }
  }
  if (envCommand) {
    await cli(mode === "env-set" ? ["env", "set", positionals[1], positionals[2]] : ["env", "remove", positionals[1]]);
    console.log(JSON.stringify({ target, command: mode, variable: positionals[1] }));
    return;
  }
  const provider = local ? fakeResetProvider() : mode === "execute"
    ? uploadthingResetProvider(process.env.DEV_RESET_UPLOADTHING_TOKEN ?? settings.UPLOADTHING_TOKEN, config.uploadthingAppId)
    // Inspection and resume never call the provider.
    : { kind: "uploadthing" as const, appId: async () => "", ownedKeys: async () => new Set<string>(), delete: async () => ({ outcome: "unknown" as const }) };
  const remote = new ConvexTicketRemote();
  async function environment() {
    // Agent-mode CLIs list names only unless values are requested explicitly.
    return parseEnvironment(await cli(["env", "list", "--include-values"]));
  }
  async function ownerGoogleSignIn(step: string) {
    console.error(`Owner sign-in (${step}): continue with the Owner's Google account in the browser.`);
    const tokens = await googleLoopbackSignIn(remote, url);
    if (!tokens) throw new Error("RESET_OWNER_SIGN_IN_FAILED");
    return tokens;
  }
  const backend: ResetBackend = {
    environment,
    async snapshot() {
      let index = 1;
      while (existsSync(resolve(directory, `snapshot-${index}.zip`))) index++;
      const path = resolve(directory, `snapshot-${index}.zip`);
      await cli(["export", "--path", path]);
      chmodSync(path, 0o600);
      return readSnapshot(new AdmZip(path));
    },
    async clear() {
      const path = resolve(directory, "empty.zip");
      new AdmZip().writeZip(path);
      await cli(["import", "--replace-all", "--yes", path]);
    },
    async push() { await cli(["dev", "--once", "--typecheck", "disable"]); },
    async configure() {
      const token = process.env.DEV_RESET_UPLOADTHING_TOKEN ?? settings.UPLOADTHING_TOKEN;
      const callback = process.env.DEV_RESET_CALLBACK_SECRET || randomBytes(32).toString("base64url");
      // The HTTP runtime must receive this same value; retain it privately, never print it.
      // Development identity settings (Google client, redirect origins, sender, Owner
      // subject) are operator settings checked before clearing; the disposable
      // rehearsal configures its loopback fixture Owner here instead.
      const variables = { MEDIA_CLEANUP_ENABLED: "false", UPLOAD_CALLBACK_SECRET: callback,
        ...(local ? { LOCAL_FIXTURES_ENABLED: "true", OWNER_BOOTSTRAP_GOOGLE_SUBJECT: LOCAL_OWNER_SUBJECT } : { LOCAL_FIXTURES_ENABLED: "false", UPLOADTHING_TOKEN: token! }) };
      function writeEnv(name: string, values: Record<string, string>) {
        writeFileSync(resolve(directory, name), Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n") + "\n", { mode: 0o600 });
      }
      writeEnv("backend.env", variables);
      writeEnv("runtime.env", { ...variables, CONVEX_URL: url });
      writeEnv("web.env", { VITE_CONVEX_URL: url, VITE_CONVEX_SITE_URL: local ? `http://127.0.0.1:${loadPorts().CONVEX_SITE_PORT}` : url.replace(/\.cloud$/, ".site") });
      await cli(["env", "set", "--force", "--from-file", resolve(directory, "backend.env")]);
      console.log("HTTP configuration: private runtime.env. Browser configuration: web.env (VITE_ variables only). Values are never printed.");
    },
    async bootstrapOwner() {
      const googleSubject = (await environment()).OWNER_BOOTSTRAP_GOOGLE_SUBJECT?.trim();
      if (!googleSubject) throw new Error("RESET_OWNER_BOOTSTRAP_NOT_READY");
      if (local) await cli(["run", "seed:localPendingOwner", "{}"]);
      else {
        // The first sign-in only records the pending Google identity.
        const pending = await ownerGoogleSignIn("1 of 2, records the pending identity");
        const viewer = await remote.currentSession(url, pending.accessToken);
        await remote.logout(url, pending.refreshToken);
        if (viewer?.role !== "pending") throw new Error("RESET_OWNER_PENDING_IDENTITY_REQUIRED");
        console.error(`Bootstrapping the configured Owner subject; signed in as ${viewer.email ?? "an account without email"}.`);
      }
      // The real one-use internal bootstrap; it refuses any other subject or an unverified email.
      await cli(["run", "identity:bootstrapOwner", JSON.stringify({ googleSubject })]);
    },
    async seedAndVerify() {
      let result: { ok?: boolean; checks?: string[]; error?: string };
      if (local) {
        const resultFile = resolve(directory, "verification.json");
        rmSync(resultFile, { force: true });
        await cli(["dev", "--once", "--typecheck", "disable", "--start", "pnpm exec tsx scripts/dev-reset-seed.ts"], {
          ...process.env, DEV_RESET_URL: url, DEV_RESET_RESULT_FILE: resultFile, DEV_RESET_CUSTOMER_PASSWORD: customer,
        });
        try { result = JSON.parse(readFileSync(resultFile, "utf8")); } catch { throw new Error("RESET_VERIFICATION_DID_NOT_COMPLETE"); }
      } else {
        const owner: SessionTokens = await ownerGoogleSignIn("2 of 2, fresh Owner session for seeding");
        result = await seedAsOwner(url, owner, customer);
        writeFileSync(resolve(directory, "verification.json"), JSON.stringify(result), { mode: 0o600 });
      }
      if (result.ok !== true) throw new Error(`RESET_VERIFICATION_FAILED${typeof result.error === "string" ? ` (${result.error})` : ""}`);
      console.log(JSON.stringify(result));
      // Supplied credentials need no echo. Generated credentials are printed exactly once, after the customers exist.
      if (suppliedCustomer === undefined) console.log(`Generated customer password (alice, bob): ${customer}`);
    },
  };
  let latest: Manifest | undefined;
  const deps = {
    provider, backend,
    async save(manifest: Manifest) {
      latest = manifest;
      const path = resolve(directory, "manifest.json");
      writeFileSync(`${path}.tmp`, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
      writeFileSync(resolve(directory, "unresolved.json"), JSON.stringify(manifest.unresolved, null, 2) + "\n", { mode: 0o600 });
    },
  };
  let manifest: Manifest;
  try {
    manifest = mode === "resume"
      ? await resume({ local, deployment: settings.CONVEX_DEPLOYMENT, confirm: values.confirm, manifest: expect, config }, deps)
      : await reset({ mode: mode as "inspect" | "execute", local, deployment: settings.CONVEX_DEPLOYMENT, confirm: values.confirm, expect, config }, deps);
  } catch (error) {
    if (error instanceof Error && error.message === "RESET_PILOT_INSTALLED") {
      console.error("Use the restore procedure in docs/named-pilot-operations.md for an installed pilot.");
    } else if (latest?.stage === POST_CLEAR_BLOCKED || (mode === "resume" && expect?.stage === POST_CLEAR_BLOCKED)) {
      console.error(`Rows were found after the clear. Start with a read-only inspection: pnpm dev:reset inspect${local ? " --target local" : ""}. Review its manifest before authorizing a separate execute.`);
    } else if (latest && (POST_CLEAR_STAGES as readonly string[]).includes(latest.stage)) {
      console.error(`Rows are cleared (stage ${latest.stage}). After fixing the cause, continue with: pnpm dev:reset resume${local ? " --target local" : ""} --confirm ${target} --expect ${resolve(directory, "manifest.json")}`);
    }
    throw error;
  } finally {
    rmSync(resolve(directory, "empty.zip"), { force: true });
  }
  console.log(JSON.stringify({ target, stage: manifest.stage, counts: manifest.counts, media: manifest.media, manifest: resolve(directory, "manifest.json"), unresolved: manifest.unresolved.length }));
  if (mode !== "inspect") console.log("Domain checks passed. Keep MEDIA_CLEANUP_ENABLED=false until browser, CLI, trusted uploads, cancellation/expiry and retention checks in docs/dev-reset.md pass. The tool never enables cleanup.");
  // Retain snapshots and runtime configuration for diagnosis; no data rollback is promised.
}
main().catch(error => { console.error(error instanceof Error ? error.message : "RESET_FAILED"); process.exitCode = 1; });
