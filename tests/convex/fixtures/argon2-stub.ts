// Test stand-in for password-hash-wasm/argon2id (see vitest.convex.config.ts).
// The edge-runtime test environment cannot instantiate the ESM-integrated WASM;
// validation, NFC, rate limits and storage in the pinned component stay real.
// The real argon2id path runs on the disposable local backend smoke.
async function digest(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function hashPassword(password: string) { return `$test-sha256$${await digest(password)}`; }
export async function verifyPassword(password: string, hash: string) { return hash === `$test-sha256$${await digest(password)}`; }
