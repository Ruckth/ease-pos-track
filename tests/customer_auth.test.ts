import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPasswordIsNotEmail,
  normalizeCustomerEmail,
  validateClientId,
  validateCustomerEmail,
  validateCustomerPassword,
} from "../convex/customer_validation";
import {
  CUSTOMER_GLOBAL_ATTEMPT_KEY,
  CUSTOMER_GUARD,
  customerAttemptKey,
  isLockedOut,
  planFailure,
} from "../convex/login_guard";
import {
  constantTimeEquals,
  createPasswordRecord,
  DECOY_PASSWORD_RECORD,
  derivePasswordHash,
  PASSWORD_ALGORITHM,
  resolvePasswordPepper,
  verifyPasswordRecord,
} from "../convex/password";

test("the pepper is required and account paths fail closed without it", () => {
  // A configured pepper is returned verbatim, so derivations stay stable.
  assert.equal(resolvePasswordPepper("deployment-secret"), "deployment-secret");
  assert.equal(resolvePasswordPepper(" padded "), " padded ");
  for (const missing of [undefined, "", "   ", "\n\t"]) {
    assert.throws(() => resolvePasswordPepper(missing), /CUSTOMER_ACCOUNTS_UNAVAILABLE/, String(missing));
  }
});

test("emails are normalized and clearly invalid ones are rejected", () => {
  assert.equal(normalizeCustomerEmail("  Owner@Shop.CO  "), "owner@shop.co");
  assert.equal(validateCustomerEmail(" Owner@Shop.CO "), "owner@shop.co");
  for (const invalid of ["", "   ", "owner", "owner@shop", "owner shop@mail.com", "@shop.co", `${"a".repeat(250)}@shop.co`]) {
    assert.throws(() => validateCustomerEmail(invalid), /INVALID_EMAIL/, invalid);
  }
});

test("passwords need length plus a letter and a digit", () => {
  assert.equal(validateCustomerPassword("printer2024"), "printer2024");
  assert.throws(() => validateCustomerPassword("short1"), /WEAK_PASSWORD/);
  assert.throws(() => validateCustomerPassword("allletterspassword"), /WEAK_PASSWORD/);
  assert.throws(() => validateCustomerPassword("1234567890"), /WEAK_PASSWORD/);
  assert.throws(() => validateCustomerPassword(`${"a1".repeat(65)}`), /PASSWORD_TOO_LONG/);
  assert.throws(() => assertPasswordIsNotEmail("owner@shop.co", "Owner@Shop.CO"), /WEAK_PASSWORD/);
  assert.doesNotThrow(() => assertPasswordIsNotEmail("owner@shop.co", "printer2024"));
});

test("client ids are bounded so the rate limiter keys stay sane", () => {
  const clientId = "a".repeat(36);
  assert.equal(validateClientId(` ${clientId} `), clientId);
  assert.throws(() => validateClientId("short"), /INVALID_SIGNIN_CLIENT/);
  assert.throws(() => validateClientId("a".repeat(129)), /INVALID_SIGNIN_CLIENT/);
});

test("customer attempt keys are namespaced away from staff attempts", () => {
  assert.equal(customerAttemptKey("device-1"), "customer:device-1");
  assert.equal(CUSTOMER_GLOBAL_ATTEMPT_KEY, "customer:__global__");
  assert.notEqual(customerAttemptKey("__global__"), "__global__");
});

test("repeated failures lock out, and a stale window starts over", () => {
  const now = 1_000_000;
  let record = planFailure(null, now, CUSTOMER_GUARD);
  assert.deepEqual(record, { attempts: 1, firstAttemptAt: now });
  for (let attempt = 2; attempt < CUSTOMER_GUARD.maxAttempts; attempt += 1) {
    record = planFailure(record, now + attempt, CUSTOMER_GUARD);
    assert.equal(record.lockedUntil, undefined);
  }
  record = planFailure(record, now + 10, CUSTOMER_GUARD);
  assert.equal(record.attempts, CUSTOMER_GUARD.maxAttempts);
  assert.equal(record.lockedUntil, now + 10 + CUSTOMER_GUARD.lockoutMs);

  assert.equal(isLockedOut([record], now + 10), true);
  assert.equal(isLockedOut([record], now + 10 + CUSTOMER_GUARD.lockoutMs + 1), false);
  assert.equal(isLockedOut([null, undefined], now), false);

  const afterWindow = planFailure(record, now + CUSTOMER_GUARD.windowMs + 1, CUSTOMER_GUARD);
  assert.equal(afterWindow.attempts, 1);
});

test("passwords are stored as salted PBKDF2 hashes, never in the clear", async () => {
  const record = await createPasswordRecord("printer2024", "pepper");
  assert.equal(record.passwordAlgorithm, PASSWORD_ALGORITHM);
  assert.equal(record.passwordSalt.length, 32);
  assert.equal(record.passwordHash.length, 64);
  assert.equal(record.passwordIterations > 100_000, true);
  assert.equal(record.passwordHash.includes("printer2024"), false);

  assert.equal(await verifyPasswordRecord("printer2024", "pepper", record), true);
  assert.equal(await verifyPasswordRecord("printer2025", "pepper", record), false);
  // The pepper is part of the key material, so the same password fails without it.
  assert.equal(await verifyPasswordRecord("printer2024", "", record), false);

  const second = await createPasswordRecord("printer2024", "pepper");
  assert.notEqual(second.passwordSalt, record.passwordSalt);
  assert.notEqual(second.passwordHash, record.passwordHash);
});

test("derivation is deterministic for a given salt and iteration count", async () => {
  const first = await derivePasswordHash("printer2024", "0".repeat(32), 1_000, "");
  const same = await derivePasswordHash("printer2024", "0".repeat(32), 1_000, "");
  const other = await derivePasswordHash("printer2024", "1".repeat(32), 1_000, "");
  assert.equal(first, same);
  assert.notEqual(first, other);
  await assert.rejects(() => derivePasswordHash("printer2024", "zz", 1_000, ""), /INVALID_PASSWORD_RECORD/);
  await assert.rejects(() => derivePasswordHash("printer2024", "0".repeat(32), 10, ""), /INVALID_PASSWORD_RECORD/);
});

test("the decoy record makes unknown emails do the same work and still fail", async () => {
  assert.equal(await verifyPasswordRecord("anything1234", "pepper", DECOY_PASSWORD_RECORD), false);
  assert.equal(DECOY_PASSWORD_RECORD.passwordIterations > 100_000, true);
});

test("hash comparison does not exit on the first differing character", () => {
  assert.equal(constantTimeEquals("abcd", "abcd"), true);
  assert.equal(constantTimeEquals("abcd", "abce"), false);
  assert.equal(constantTimeEquals("abcd", "abcde"), false);
  assert.equal(constantTimeEquals("", ""), true);
});
