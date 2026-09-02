/**
 * Where the secret half of a session lives: the token, its expiry, and the
 * deployment URL it is bound to.
 *
 * The only implementation is macOS Keychain, driven through `/usr/bin/security`
 * with an injectable process runner. Non-macOS hosts fail closed rather than
 * falling back to a plaintext file.
 */

import { spawn } from "node:child_process";
import { platform } from "node:os";
import { authError, type TicketCliError } from "./errors";
import { ticketCommand, type Deployment } from "./deployment";

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
const SECURITY_BINARY = "/usr/bin/security";
/** `security` reports a missing item with this status; it is not a failure. */
const ITEM_NOT_FOUND = 44;

function isStoredCredential(value: unknown): value is StoredCredential {
  const credential = value as StoredCredential | null;
  return (
    credential !== null &&
    typeof credential === "object" &&
    typeof credential.token === "string" &&
    typeof credential.expiresAt === "number" &&
    typeof credential.url === "string"
  );
}

/**
 * Accepts the base64 form written today and the plaintext JSON written by
 * earlier versions, so an existing session survives an upgrade.
 */
function decodeCredential(stored: string): StoredCredential | null {
  const candidates = [stored, Buffer.from(stored, "base64").toString("utf8")];
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isStoredCredential(parsed)) return parsed;
    } catch {
      // Not this encoding; try the next candidate.
    }
  }
  return null;
}

/** macOS Keychain adapter. Secret values are passed on stdin, never as arguments. */
export class MacOsKeychainCredentialStore implements CredentialStore {
  constructor(private readonly run: ProcessRunner = spawnProcess, private readonly os = platform()) {}

  async get(target: Deployment) {
    const result = await this.security(["find-generic-password", "-a", target, "-s", KEYCHAIN_SERVICE, "-w"]);
    if (result.exitCode === ITEM_NOT_FOUND) return null;
    if (result.exitCode !== 0) throw this.failure(result);
    const credential = decodeCredential(result.stdout.trim());
    if (credential) return credential;
    throw authError(
      "CREDENTIAL_INVALID",
      "The saved Ticket session in macOS Keychain is invalid.",
      `Run \`${ticketCommand("logout", target)}\`, then log in again.`,
    );
  }

  async set(target: Deployment, credential: StoredCredential) {
    const encoded = Buffer.from(JSON.stringify(credential), "utf8").toString("base64");
    // The secret reaches `security` through stdin so it never appears in `ps`.
    const result = await this.security(
      ["-i"],
      `add-generic-password -U -a ${target} -s ${KEYCHAIN_SERVICE} -w ${encoded}\n`,
    );
    if (result.exitCode !== 0) throw this.failure(result);
  }

  async delete(target: Deployment) {
    const result = await this.security(["delete-generic-password", "-a", target, "-s", KEYCHAIN_SERVICE]);
    if (result.exitCode !== 0 && result.exitCode !== ITEM_NOT_FOUND) throw this.failure(result);
  }

  private async security(args: string[], stdin?: string) {
    if (this.os !== "darwin") {
      throw authError(
        "KEYCHAIN_UNAVAILABLE",
        "Persistent Ticket sessions require macOS Keychain.",
        "Run the Ticket CLI on macOS or inject a platform credential store.",
      );
    }
    return await this.run(SECURITY_BINARY, args, stdin);
  }

  private failure(result: ProcessResult): TicketCliError {
    const detail = (result.stderr || result.stdout).trim().split("\n")[0];
    return authError("KEYCHAIN_ERROR", `macOS Keychain operation failed${detail ? `: ${detail}` : "."}`);
  }
}
