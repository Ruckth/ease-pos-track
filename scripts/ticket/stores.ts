import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { EXIT, TicketCliError, type Deployment } from "./cli";

export type TicketConfig = {
  version: 1;
  clientId: string;
  deployments: Partial<Record<Deployment, { url: string }>>;
};

export interface ConfigStore {
  load(): Promise<TicketConfig | null>;
  save(config: TicketConfig): Promise<void>;
}

export function defaultConfigPath() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "track-ease-pos", "ticket.json");
}

export class FileConfigStore implements ConfigStore {
  constructor(readonly path = defaultConfigPath()) {}

  async load() {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new TicketCliError("CONFIG_IO_ERROR", `Ticket CLI configuration could not be read at ${this.path}.`, EXIT.auth);
    }
    try {
      const parsed = JSON.parse(raw) as TicketConfig;
      if (parsed.version !== 1 || typeof parsed.clientId !== "string" || !parsed.deployments || typeof parsed.deployments !== "object") throw new Error();
      return parsed;
    } catch {
      throw new TicketCliError("CONFIG_INVALID", `Ticket CLI configuration is invalid at ${this.path}.`, EXIT.auth, "Repair or remove the file, then run `pnpm ticket login`.");
    }
  }

  async save(config: TicketConfig) {
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await chmod(dirname(this.path), 0o700);
      await writeFile(this.path, `${JSON.stringify(config)}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(this.path, 0o600);
    } catch {
      throw new TicketCliError("CONFIG_IO_ERROR", `Ticket CLI configuration could not be written at ${this.path}.`, EXIT.auth);
    }
  }
}

export async function loadOrCreateConfig(store: ConfigStore, newClientId = randomUUID) {
  const existing = await store.load();
  if (existing) return existing;
  const config: TicketConfig = { version: 1, clientId: newClientId(), deployments: {} };
  await store.save(config);
  return config;
}

export function normalizeDeploymentUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new TicketCliError("INVALID_DEPLOYMENT_URL", "The deployment URL is not a valid URL.", EXIT.usage);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TicketCliError("INVALID_DEPLOYMENT_URL", "The deployment URL must be an http(s) origin without credentials, a query, or a fragment.", EXIT.usage);
  }
  return url.toString().replace(/\/$/, "");
}

export function deploymentUrl(
  config: TicketConfig | null,
  target: Deployment,
  override: string | undefined,
  env: NodeJS.ProcessEnv,
) {
  const fromEnv = target === "prod"
    ? env.TICKET_CONVEX_PROD_URL
    : env.TICKET_CONVEX_URL ?? env.CONVEX_URL ?? env.VITE_CONVEX_URL;
  const value = override ?? config?.deployments[target]?.url ?? fromEnv;
  if (!value) {
    throw new TicketCliError(
      "DEPLOYMENT_NOT_CONFIGURED",
      `No ${target === "prod" ? "production" : "development"} deployment URL is configured.`,
      EXIT.auth,
      `Run \`pnpm ticket login${target === "prod" ? " --prod" : ""} --url <deployment-url>\`.`,
    );
  }
  return normalizeDeploymentUrl(value);
}

export type StoredCredential = { token: string; expiresAt: number; url: string };

export interface CredentialStore {
  get(target: Deployment): Promise<StoredCredential | null>;
  set(target: Deployment, credential: StoredCredential): Promise<void>;
  delete(target: Deployment): Promise<void>;
}

export type ProcessResult = { exitCode: number; stdout: string; stderr: string };
export type ProcessRunner = (command: string, args: string[], stdin?: string) => Promise<ProcessResult>;

export const spawnProcess: ProcessRunner = (command, args, stdin) => new Promise((resolve) => {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], shell: false });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.on("error", (error) => resolve({ exitCode: 127, stdout, stderr: `${stderr}${error.message}` }));
  child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  child.stdin.end(stdin);
});

const KEYCHAIN_SERVICE = "com.track-ease-pos.ticket-cli";

/** macOS Keychain adapter. Secret values are passed on stdin, never as arguments. */
export class MacOsKeychainCredentialStore implements CredentialStore {
  constructor(private readonly run: ProcessRunner = spawnProcess, private readonly os = platform()) {}

  private assertAvailable() {
    if (this.os !== "darwin") {
      throw new TicketCliError("KEYCHAIN_UNAVAILABLE", "Persistent Ticket sessions require macOS Keychain.", EXIT.auth, "Run the Ticket CLI on macOS or inject a platform credential store.");
    }
  }

  async get(target: Deployment) {
    this.assertAvailable();
    const result = await this.run("/usr/bin/security", ["find-generic-password", "-a", target, "-s", KEYCHAIN_SERVICE, "-w"]);
    if (result.exitCode === 44) return null;
    if (result.exitCode !== 0) throw this.failure(result);
    const raw = result.stdout.trim();
    for (const candidate of [raw, Buffer.from(raw, "base64").toString("utf8")]) {
      try {
        const parsed = JSON.parse(candidate) as StoredCredential;
        if (typeof parsed.token !== "string" || typeof parsed.expiresAt !== "number" || typeof parsed.url !== "string") continue;
        return parsed;
      } catch {
        // Try the base64-encoded format after the legacy plaintext JSON format.
      }
    }
    throw new TicketCliError("CREDENTIAL_INVALID", "The saved Ticket session in macOS Keychain is invalid.", EXIT.auth, `Run \`pnpm ticket logout${target === "prod" ? " --prod" : ""}\`, then log in again.`);
  }

  async set(target: Deployment, credential: StoredCredential) {
    this.assertAvailable();
    const encoded = Buffer.from(JSON.stringify(credential), "utf8").toString("base64");
    const result = await this.run(
      "/usr/bin/security",
      ["-i"],
      `add-generic-password -U -a ${target} -s ${KEYCHAIN_SERVICE} -w ${encoded}\n`,
    );
    if (result.exitCode !== 0) throw this.failure(result);
  }

  async delete(target: Deployment) {
    this.assertAvailable();
    const result = await this.run("/usr/bin/security", ["delete-generic-password", "-a", target, "-s", KEYCHAIN_SERVICE]);
    if (result.exitCode !== 0 && result.exitCode !== 44) throw this.failure(result);
  }

  private failure(result: ProcessResult) {
    const detail = (result.stderr || result.stdout).trim().split("\n")[0];
    return new TicketCliError("KEYCHAIN_ERROR", `macOS Keychain operation failed${detail ? `: ${detail}` : "."}`, EXIT.auth);
  }
}
