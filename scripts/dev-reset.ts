import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { parse } from "dotenv";
import AdmZip from "adm-zip";
import { reset, type Manifest, type ResetConfig, type Snapshot } from "./dev-reset/core";
import { fakeResetProvider, uploadthingResetProvider } from "./dev-reset/provider";
import { localResetTarget, validateDevelopmentTarget } from "./dev-reset-target.mjs";
import { loadPorts } from "./worktree-ports.mjs";
import { parseEnvironment, runDevelopment, validatePasswords, verifyDeploymentUrl } from "./dev-reset/runner";

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { target: { type: "string" }, confirm: { type: "string" }, expect: { type: "string" } } });
  const mode = positionals[0] ?? "inspect";
  const envCommand = mode === "env-set" || mode === "env-remove";
  if ((!envCommand && (positionals.length > 1 || !["inspect", "execute"].includes(mode)))
    || (mode === "env-set" && (positionals.length !== 3 || positionals[1] !== "MEDIA_CLEANUP_ENABLED" || !["true", "false"].includes(positionals[2])))
    || (mode === "env-remove" && (positionals.length !== 2 || positionals[1] !== "UPLOADTHING_TOKEN"))
    || (values.target && !["local", "development"].includes(values.target))) throw new Error("RESET_USAGE: inspect | execute --confirm exact-name --expect inspect-manifest | env-set MEDIA_CLEANUP_ENABLED true|false | env-remove UPLOADTHING_TOKEN [--target local|development]");
  const local = values.target === "local";
  const config: ResetConfig = JSON.parse(readFileSync(resolve(import.meta.dirname, "dev-reset.config.json"), "utf8"));
  const settings = parse(readFileSync(".env.local"));
  const target = local ? localResetTarget() : validateDevelopmentTarget(settings.CONVEX_DEPLOYMENT, config.deployment);
  if (mode === "execute" && values.confirm !== target) throw new Error("RESET_CONFIRM_REQUIRED");
  if (mode === "execute" && !values.expect) throw new Error("RESET_INSPECT_MANIFEST_REQUIRED");
  const expect: Manifest | undefined = values.expect ? JSON.parse(readFileSync(values.expect, "utf8")) : undefined;
  const directory = resolve(".reset", `${Date.now()}-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(resolve(".reset"), 0o700);
  const url = local ? `http://127.0.0.1:${loadPorts().CONVEX_CLOUD_PORT}` : `https://${target.slice(4)}.convex.cloud`;
  // Confirm the guessed hostname serves this exact deployment before any writes.
  if (!local) await verifyDeploymentUrl(url, target);
  const credentials = {
    staff: process.env.DEV_RESET_STAFF_PASSWORD ?? `Aa1!${randomBytes(32).toString("base64url")}`,
    customer: process.env.DEV_RESET_CUSTOMER_PASSWORD ?? `Aa1!${randomBytes(32).toString("base64url")}`,
  };
  if (mode === "execute") validatePasswords([credentials.staff, credentials.customer]);
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
      throw new Error(`RESET_CONVEX_COMMAND_FAILED: ${args[0]} (private details in ${directory}/command-error.log; manifests retained)`);
    }
  }
  if (envCommand) {
    await cli(mode === "env-set" ? ["env", "set", positionals[1], positionals[2]] : ["env", "remove", positionals[1]]);
    console.log(JSON.stringify({ target, command: mode, variable: positionals[1] }));
    return;
  }
  const provider = local ? fakeResetProvider() : mode === "execute"
    ? uploadthingResetProvider(process.env.DEV_RESET_UPLOADTHING_TOKEN ?? settings.UPLOADTHING_TOKEN, config.uploadthingAppId)
    : { kind: "uploadthing" as const, appId: async () => "", ownedKeys: async () => new Set<string>(), delete: async () => ({ outcome: "unknown" as const }) };
  let snapshots = 0;
  const manifest = await reset({ mode: mode as "inspect" | "execute", local, deployment: settings.CONVEX_DEPLOYMENT, confirm: values.confirm, expect, config }, {
    provider,
    async save(manifest: Manifest) {
      const path = resolve(directory, "manifest.json");
      writeFileSync(`${path}.tmp`, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
      writeFileSync(resolve(directory, "unresolved.json"), JSON.stringify(manifest.unresolved, null, 2) + "\n", { mode: 0o600 });
    },
    backend: {
      async environment() { return parseEnvironment(await cli(["env", "list"])); },
      async snapshot() {
        const path = resolve(directory, `snapshot-${++snapshots}.zip`);
        await cli(["export", "--path", path]);
        chmodSync(path, 0o600);
        const zip = new AdmZip(path);
        const snapshot: Snapshot = {};
        for (const entry of zip.getEntries()) {
          const match = /^([^/]+)\/documents.jsonl$/.exec(entry.entryName);
          if (!match) continue;
          snapshot[match[1]] = entry.getData().toString("utf8").split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
        }
        return snapshot;
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
        const variables = { MEDIA_CLEANUP_ENABLED: "false", LOCAL_FIXTURES_ENABLED: "false", APP_PASSWORD: credentials.staff,
          CUSTOMER_PASSWORD_PEPPER: randomBytes(32).toString("base64url"), UPLOAD_CALLBACK_SECRET: callback,
          ...(local ? {} : { UPLOADTHING_TOKEN: token! }) };
        const path = resolve(directory, "backend.env");
        function writeEnv(name: string, values: Record<string, string>) {
          writeFileSync(resolve(directory, name), Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n") + "\n", { mode: 0o600 });
        }
        writeEnv("backend.env", variables);
        writeEnv("runtime.env", { ...variables, CONVEX_URL: url });
        writeEnv("web.env", { VITE_CONVEX_URL: url, VITE_CONVEX_SITE_URL: local ? `http://127.0.0.1:${loadPorts().CONVEX_SITE_PORT}` : url.replace(/\.cloud$/, ".site") });
        await cli(["env", "set", "--force", "--from-file", path]);
        console.log("HTTP configuration: private runtime.env. Browser configuration: web.env (VITE_ variables only). Values are never printed.");
        // Supplied credentials need no echo. Generated credentials are printed exactly once.
        if (process.env.DEV_RESET_STAFF_PASSWORD === undefined) console.log(`Generated staff password: ${credentials.staff}`);
        if (process.env.DEV_RESET_CUSTOMER_PASSWORD === undefined) console.log(`Generated customer password (alice@dev.example, bob@dev.example): ${credentials.customer}`);
      },
      async seedAndVerify() {
        const resultFile = resolve(directory, "verification.json");
        await cli(["dev", "--once", "--typecheck", "disable", "--start", "pnpm exec tsx scripts/dev-reset-seed.ts"], {
          ...process.env, DEV_RESET_URL: url, DEV_RESET_RESULT_FILE: resultFile,
          DEV_RESET_STAFF_PASSWORD: credentials.staff, DEV_RESET_CUSTOMER_PASSWORD: credentials.customer,
        });
        let result;
        try { result = JSON.parse(readFileSync(resultFile, "utf8")); } catch { throw new Error("RESET_VERIFICATION_DID_NOT_COMPLETE"); }
        if (result.ok !== true) throw new Error("RESET_VERIFICATION_FAILED");
        console.log(JSON.stringify(result));
      },
    },
  });
  console.log(JSON.stringify({ target, stage: manifest.stage, counts: manifest.counts, media: manifest.media, manifest: resolve(directory, "manifest.json"), unresolved: manifest.unresolved.length }));
  if (mode === "execute") console.log("Domain checks passed. Keep MEDIA_CLEANUP_ENABLED=false until browser, CLI, trusted uploads, cancellation/expiry and retention checks in docs/dev-reset.md pass. The tool never enables cleanup.");
  // Retain snapshot and runtime configuration for diagnosis; no data rollback is promised.
  rmSync(resolve(directory, "empty.zip"), { force: true });
}
main().catch(error => { console.error(error instanceof Error ? error.message : "RESET_FAILED"); process.exitCode = 1; });
