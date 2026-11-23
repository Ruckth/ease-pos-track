/**
 * Where the secret half of a session lives: the token, its expiry, and the
 * deployment URL it is bound to.
 *
 * The only implementation is macOS Keychain, driven through `/usr/bin/security`
 * with an injectable process runner. Non-macOS hosts fail closed rather than
 * falling back to a plaintext file.
 *
 * Keychain has no compare-and-swap, so read-rotate-write sequences run inside
 * `exclusive`, which serializes them across every CLI process of the account.
 */

import { spawn } from "node:child_process";
import { platform, userInfo } from "node:os";
import { join } from "node:path";
import { authError, type TicketCliError } from "./errors";
import { ticketCommand, type Deployment } from "./deployment";
import { withFileLock } from "./lock";

export type StoredCredential = { token: string; expiresAt: number; url: string };

export interface CredentialStore {
  get(target: Deployment): Promise<StoredCredential | null>;
  set(target: Deployment, credential: StoredCredential): Promise<void>;
  delete(target: Deployment): Promise<void>;
  /**
   * Runs `fn` with exclusive use of the saved sessions across processes. Calls
   * do not nest: `fn` must not call `exclusive` again.
   */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
}

export type ProcessResult = { exitCode: number; stdout: string; stderr: string };
type ProcessRunner = (command: string, args: string[], stdin?: string, lockFd?: number) => Promise<ProcessResult>;

const spawnProcess: ProcessRunner = (command, args, stdin, lockFd) => new Promise((resolve) => {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe", lockFd ?? "ignore"], shell: false });
  let stdout = "";
  let stderr = "";
  // The fourth descriptor selects Node’s general spawn overload. The first three are pipes.
  child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.on("error", (error) => resolve({ exitCode: 127, stdout, stderr: `${stderr}${error.message}` }));
  child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  child.stdin!.end(stdin);
});

const KEYCHAIN_SERVICE = "com.track-ease-pos.ticket-cli";
/** Every configuration profile of this OS user shares the same Keychain item. */
export function keychainLockPath() {
  return join(userInfo().homedir, ".config", "track-ease-pos", "ticket.lock");
}
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

function decodeCredential(stored: string): StoredCredential | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(stored, "base64").toString("utf8"));
    return isStoredCredential(parsed) ? parsed : null;
  } catch { return null; }
}

/** macOS Keychain adapter. Secret values are passed on stdin, never as arguments. */
export class MacOsKeychainCredentialStore implements CredentialStore {
  private lockFd?: number;

  constructor(
    private readonly run: ProcessRunner = spawnProcess,
    private readonly os = platform(),
    private readonly lockPath?: string,
    private readonly securityBinary = SECURITY_BINARY,
  ) {}

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

  async exclusive<T>(fn: () => Promise<T>) {
    this.requireMacOs();
    return await withFileLock(this.lockPath ?? keychainLockPath(), async fd => {
      this.lockFd = fd;
      try { return await fn(); } finally { this.lockFd = undefined; }
    });
  }

  private async security(args: string[], stdin?: string) {
    this.requireMacOs();
    return await this.run(this.securityBinary, args, stdin, this.lockFd);
  }

  private requireMacOs() {
    if (this.os !== "darwin") {
      throw authError(
        "KEYCHAIN_UNAVAILABLE",
        "Persistent Ticket sessions require macOS Keychain.",
        "Run the Ticket CLI on macOS or inject a platform credential store.",
      );
    }
  }

  private failure(result: ProcessResult): TicketCliError {
    const detail = (result.stderr || result.stdout).trim().split("\n")[0];
    return authError("KEYCHAIN_ERROR", `macOS Keychain operation failed${detail ? `: ${detail}` : "."}`);
  }
}
