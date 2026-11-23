/**
 * Attempt-budget arithmetic for recovery, invitations and action proof.
 * Pure so the windows can be unit tested. The pinned password component
 * throttles password verification by normalized username.
 */

type AttemptRecord = {
  attempts: number;
  firstAttemptAt: number;
  lockedUntil?: number;
};

export type GuardConfig = {
  windowMs: number;
  maxAttempts: number;
  lockoutMs: number;
};

export function isLockedOut(records: Array<AttemptRecord | null | undefined>, now: number) {
  return records.some((record) => (record?.lockedUntil ?? 0) > now);
}

/** Folds one failed attempt into the stored counter, restarting stale windows. */
export function planFailure(
  existing: AttemptRecord | null | undefined,
  now: number,
  config: GuardConfig,
): AttemptRecord {
  const withinWindow = existing !== null
    && existing !== undefined
    && now - existing.firstAttemptAt <= config.windowMs;
  const attempts = withinWindow ? existing.attempts + 1 : 1;
  const firstAttemptAt = withinWindow ? existing.firstAttemptAt : now;
  const lockedUntil = attempts >= config.maxAttempts ? now + config.lockoutMs : undefined;
  return {
    attempts,
    firstAttemptAt,
    ...(lockedUntil === undefined ? {} : { lockedUntil }),
  };
}
