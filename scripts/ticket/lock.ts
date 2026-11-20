/**
 * Cross-process mutual exclusion for the saved Ticket session.
 *
 * Each authenticated run rotates a single-use refresh token, so two CLI
 * processes must never read, rotate and write it at the same time. macOS
 * `open(2)` takes an exclusive flock(2)-style lock atomically with `O_EXLOCK`,
 * and the kernel drops it when the descriptor closes, including when the holder
 * crashes or is killed. There is no stale lock to detect or break; the lock file
 * carries no state and is never removed.
 */

import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { authError } from "./errors";

/** `<sys/fcntl.h>` on macOS. Node passes open flags through but does not export this one. */
const O_EXLOCK = 0x20;
const LOCK_FLAGS = constants.O_CREAT | constants.O_RDWR | constants.O_NONBLOCK | O_EXLOCK;

/** Long enough for queued runs' refresh round-trips, short enough to surface a hung holder. */
export const DEFAULT_LOCK_TIMEOUT_MS = 60_000;
const POLL_MS = 25;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Runs `fn` while holding the exclusive lock at `path`, waiting up to `timeoutMs` for it. */
export async function withFileLock<T>(path: string, fn: () => Promise<T>, timeoutMs = DEFAULT_LOCK_TIMEOUT_MS): Promise<T> {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  } catch {
    throw lockFailure(path);
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let handle;
    try {
      handle = await open(path, LOCK_FLAGS, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw lockFailure(path);
      if (Date.now() >= deadline) {
        throw authError(
          "CREDENTIAL_LOCK_TIMEOUT",
          "Another Ticket CLI run is still using the saved session.",
          "Wait for the other run to finish, then retry the same command.",
        );
      }
      await sleep(POLL_MS + Math.random() * POLL_MS);
      continue;
    }
    try {
      return await fn();
    } finally {
      await handle.close();
    }
  }
}

function lockFailure(path: string) {
  return authError("CREDENTIAL_LOCK_ERROR", `The Ticket session lock could not be opened at ${path}.`);
}
