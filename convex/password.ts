/**
 * Password hashing for self-serve customer accounts.
 *
 * Uses PBKDF2-HMAC-SHA256 through the Web Crypto API, which the default Convex
 * runtime supports (SubtleCrypto), so no Node-only action is required. The same
 * API exists in Node 18+, so these helpers are directly unit testable.
 *
 * Hashing is intentionally kept out of queries/mutations and called from an
 * action, because the derivation is CPU heavy.
 */

export const PASSWORD_ALGORITHM = "pbkdf2-sha256";
export const PASSWORD_ITERATIONS = 310_000;
const SALT_BYTES = 16;
const DERIVED_BITS = 256;

export type PasswordRecord = {
  passwordAlgorithm: string;
  passwordSalt: string;
  passwordHash: string;
  passwordIterations: number;
};

/**
 * Stand-in record used when an email has no account, so a failed login performs
 * the same derivation work as a real one and does not leak account existence
 * through response timing.
 */
export const DECOY_PASSWORD_RECORD: PasswordRecord = {
  passwordAlgorithm: PASSWORD_ALGORITHM,
  passwordSalt: "00000000000000000000000000000000",
  passwordHash: "00",
  passwordIterations: PASSWORD_ITERATIONS,
};

/**
 * Resolves the required `CUSTOMER_PASSWORD_PEPPER` deployment secret.
 *
 * Fails closed with a stable, localized code when it is missing or blank: without
 * a pepper the account paths would silently store weaker hashes that the first
 * correct configuration would then invalidate.
 */
export function resolvePasswordPepper(value: string | undefined) {
  if (value === undefined || value.trim().length === 0) {
    throw new Error("CUSTOMER_ACCOUNTS_UNAVAILABLE");
  }
  return value;
}

function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string) {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new Error("INVALID_PASSWORD_RECORD");
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function makePasswordSalt() {
  const bytes = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/** Compares two hex digests without an early exit on the first difference. */
export function constantTimeEquals(left: string, right: string) {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

/**
 * The pepper is a required deployment secret mixed into the key material, so a
 * leaked database alone is not enough to mount an offline dictionary attack.
 */
export async function derivePasswordHash(
  password: string,
  salt: string,
  iterations: number,
  pepper: string,
) {
  if (!Number.isInteger(iterations) || iterations < 1_000) throw new Error("INVALID_PASSWORD_RECORD");
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(`${password}\u0000${pepper}`),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: fromHex(salt), iterations, hash: "SHA-256" },
    keyMaterial,
    DERIVED_BITS,
  );
  return toHex(new Uint8Array(bits));
}

export async function createPasswordRecord(password: string, pepper: string): Promise<PasswordRecord> {
  const passwordSalt = makePasswordSalt();
  const passwordHash = await derivePasswordHash(password, passwordSalt, PASSWORD_ITERATIONS, pepper);
  return {
    passwordAlgorithm: PASSWORD_ALGORITHM,
    passwordSalt,
    passwordHash,
    passwordIterations: PASSWORD_ITERATIONS,
  };
}

export async function verifyPasswordRecord(
  password: string,
  pepper: string,
  record: PasswordRecord,
) {
  if (record.passwordAlgorithm !== PASSWORD_ALGORITHM) return false;
  const candidate = await derivePasswordHash(
    password,
    record.passwordSalt,
    record.passwordIterations,
    pepper,
  );
  return constantTimeEquals(candidate, record.passwordHash);
}
