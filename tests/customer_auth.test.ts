import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalRecoveryCode, checkNewPassword, constantTimeEquals, encodeRecoveryCode, formatRecoveryCode, normalizeDisplayName,
  normalizeEmail, normalizeUsername, PASSWORD_MAX_CODE_POINTS, PASSWORD_MIN_CODE_POINTS, recoveryCodeDigest,
} from "../convex/identity_rules";
import { isLockedOut, planFailure } from "../convex/login_guard";

test("usernames: trimmed, lowercased ASCII 3–32 with a letter or digit; reserved names refused", () => {
  assert.equal(normalizeUsername("  Alice_01 "), "alice_01");
  assert.equal(normalizeUsername("a-b"), "a-b");
  for (const bad of ["ab", "a".repeat(33), "___", "---", "สมชาย", "al ice", "al.ice", ""]) {
    assert.throws(() => normalizeUsername(bad), /INVALID_USERNAME/, bad);
  }
  for (const reserved of ["Admin", "support", "OWNER"]) assert.throws(() => normalizeUsername(reserved), /USERNAME_UNAVAILABLE/);
});

test("display names accept Thai and English and refuse control characters", () => {
  assert.equal(normalizeDisplayName("  สมชาย   ใจดี "), "สมชาย ใจดี");
  assert.throws(() => normalizeDisplayName("   "), /INVALID_DISPLAY_NAME/);
  assert.throws(() => normalizeDisplayName("a\u0000b"), /INVALID_DISPLAY_NAME/);
  assert.throws(() => normalizeDisplayName("x".repeat(81)), /INVALID_DISPLAY_NAME/);
});

test("one password policy counts NFC code points: 14/15/100/101, astral, Thai and whitespace", () => {
  assert.equal(PASSWORD_MIN_CODE_POINTS, 15);
  assert.equal(PASSWORD_MAX_CODE_POINTS, 100);
  assert.deepEqual(checkNewPassword("a".repeat(14)), { problem: "PASSWORD_TOO_SHORT" });
  assert.deepEqual(checkNewPassword("a".repeat(15)), { password: "a".repeat(15) });
  assert.deepEqual(checkNewPassword("a".repeat(100)), { password: "a".repeat(100) });
  assert.deepEqual(checkNewPassword("a".repeat(101)), { problem: "PASSWORD_TOO_LONG" });
  assert.deepEqual(checkNewPassword("🙂".repeat(15)), { password: "🙂".repeat(15) });
  assert.deepEqual(checkNewPassword("รหัสผ่านภาษาไทยยาวพอ"), { password: "รหัสผ่านภาษาไทยยาวพอ" });
  // Decomposed and composed spellings are the same password after NFC.
  const composed = "café passphrase!";
  const decomposed = "café passphrase!";
  assert.deepEqual(checkNewPassword(decomposed), checkNewPassword(composed));
  assert.deepEqual(checkNewPassword(" leading passphrase"), { problem: "PASSWORD_HAS_SURROUNDING_WHITESPACE" });
  assert.deepEqual(checkNewPassword("trailing passphrase "), { problem: "PASSWORD_HAS_SURROUNDING_WHITESPACE" });
  assert.ok("password" in checkNewPassword("spaces inside are fine"));
});

test("saved recovery codes carry 128 random bits as 26 Crockford characters and ignore separators and case", async () => {
  const bytes = new Uint8Array(16).fill(255);
  const code = encodeRecoveryCode(bytes);
  assert.equal(code.length, 26);
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(canonicalRecoveryCode(formatRecoveryCode(code).toLowerCase()), code);
  assert.equal(canonicalRecoveryCode("ILO" + "0".repeat(23)), "110" + "0".repeat(23));
  assert.equal(canonicalRecoveryCode("short"), null);
  assert.equal(canonicalRecoveryCode("U".repeat(26)), null);
  assert.notEqual(encodeRecoveryCode(new Uint8Array(16)), code);
  // The digest binds customer and generation: the same code differs across either.
  const digest = await recoveryCodeDigest("customer_1", 1, code);
  assert.notEqual(digest, await recoveryCodeDigest("customer_1", 2, code));
  assert.notEqual(digest, await recoveryCodeDigest("customer_2", 1, code));
});

test("emails are normalized for invitation matching", () => {
  assert.equal(normalizeEmail("  Owner@Shop.CO  "), "owner@shop.co");
  for (const bad of ["", "no-at", "a@b", "a b@c.d"]) assert.throws(() => normalizeEmail(bad), /INVALID_EMAIL/);
});

test("attempt budgets lock after the threshold and a stale window starts over", () => {
  const config = { windowMs: 1000, maxAttempts: 3, lockoutMs: 5000 };
  let record = planFailure(null, 0, config);
  record = planFailure(record, 10, config);
  assert.equal(isLockedOut([record], 20), false);
  record = planFailure(record, 20, config);
  assert.equal(isLockedOut([record], 21), true);
  assert.equal(isLockedOut([record], 5021), false);
  assert.deepEqual(planFailure({ attempts: 2, firstAttemptAt: 0 }, 5000, config), { attempts: 1, firstAttemptAt: 5000 });
});

test("digest comparison does not exit on the first differing character", () => {
  assert.equal(constantTimeEquals("abcd", "abcd"), true);
  assert.equal(constantTimeEquals("abcd", "abce"), false);
  assert.equal(constantTimeEquals("abc", "abcd"), false);
});
