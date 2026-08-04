/**
 * Brute-force guard arithmetic shared by the customer auth mutations.
 *
 * Pure so the lockout windows can be unit tested. The staff password gate keeps
 * its own inline copy of this logic untouched.
 */

export type AttemptRecord = {
  attempts: number;
  firstAttemptAt: number;
  lockedUntil?: number;
};

export type GuardConfig = {
  windowMs: number;
  maxAttempts: number;
  lockoutMs: number;
};

export const CUSTOMER_GUARD: GuardConfig = {
  windowMs: 10 * 60 * 1000,
  maxAttempts: 5,
  lockoutMs: 5 * 60 * 1000,
};

export const CUSTOMER_GLOBAL_GUARD: GuardConfig = {
  windowMs: 10 * 60 * 1000,
  maxAttempts: 50,
  lockoutMs: 5 * 60 * 1000,
};

/** Attempt keys are namespaced so customer traffic cannot lock out staff. */
export function customerAttemptKey(clientId: string) {
  return `customer:${clientId}`;
}

export const CUSTOMER_GLOBAL_ATTEMPT_KEY = "customer:__global__";

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
