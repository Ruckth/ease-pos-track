/**
 * The CLI's non-secret configuration file: a stable machine client id and the
 * deployment URLs that were signed in to. Session tokens never come here; they
 * live in the credential store.
 */

import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Deployment } from "./deployment";
import { authError } from "./errors";

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

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

function isTicketConfig(value: unknown): value is TicketConfig {
  const config = value as TicketConfig | null;
  return (
    config !== null &&
    typeof config === "object" &&
    config.version === 1 &&
    typeof config.clientId === "string" &&
    typeof config.deployments === "object" &&
    config.deployments !== null
  );
}

/** Owner-only file on disk; unreadable or unrecognized content fails closed. */
export class FileConfigStore implements ConfigStore {
  constructor(readonly path = defaultConfigPath()) {}

  async load() {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw this.ioError("read");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw this.invalidError();
    }
    if (!isTicketConfig(parsed)) throw this.invalidError();
    return parsed;
  }

  async save(config: TicketConfig) {
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: DIRECTORY_MODE });
      await chmod(dirname(this.path), DIRECTORY_MODE);
      await writeFile(this.path, `${JSON.stringify(config)}\n`, { encoding: "utf8", mode: FILE_MODE });
      await chmod(this.path, FILE_MODE);
    } catch {
      throw this.ioError("written");
    }
  }

  private ioError(action: "read" | "written") {
    return authError("CONFIG_IO_ERROR", `Ticket CLI configuration could not be ${action} at ${this.path}.`);
  }

  private invalidError() {
    return authError(
      "CONFIG_INVALID",
      `Ticket CLI configuration is invalid at ${this.path}.`,
      "Repair or remove the file, then run `pnpm ticket login`.",
    );
  }
}

/**
 * Reads the configuration, creating it on first use. Only called by commands
 * that are about to write to it, so read-only commands never leave a file
 * behind before setup is complete.
 */
export async function loadOrCreateConfig(store: ConfigStore, newClientId: () => string = randomUUID) {
  const existing = await store.load();
  if (existing) return existing;
  const config: TicketConfig = { version: 1, clientId: newClientId(), deployments: {} };
  await store.save(config);
  return config;
}
