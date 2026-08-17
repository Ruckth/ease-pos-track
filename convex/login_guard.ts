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

/** Attempt keys are namespaced so customer traffic cannot lock out staff. */
export function customerAttemptKey(clientId: string) {
  return `customer:${clientId}`;
}

/** Account-scoped failures stop password spraying without a site-wide lockout. */
export function customerEmailAttemptKey(email: string) {
  return `customer-email:${email}`;
}

/** Duplicate sign-up attempts must never lock the existing account itself. */
export function customerRegistrationAttemptKeys(clientId: string) {
  return [customerAttemptKey(clientId)];
}

/** Failed password checks are bounded by both device and target account. */
export function customerLoginAttemptKeys(clientId: string, email: string) {
  return [customerAttemptKey(clientId), customerEmailAttemptKey(email)];
}

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
