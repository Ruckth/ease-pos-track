/**
 * Pure identity rules shared by the Convex identity handlers, the browser and
 * unit tests: admission decisions, username and password policy, saved
 * recovery codes and invitation secrets. No database or network access.
 */
import type { Actor, StaffRole } from "./authz";

export const PASSWORD_MIN_CODE_POINTS = 15;
export const PASSWORD_MAX_CODE_POINTS = 100;
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 32;
export const DISPLAY_NAME_MAX = 80;
export const STAFF_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PROJECT_INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const CHALLENGE_MAX_FAILURES = 5;
export const GOOGLE_FLOW_TTL_MS = 15 * 60 * 1000;

const RESERVED_USERNAMES = new Set([
  "admin", "administrator", "root", "system", "support", "owner", "staff", "help",
  "security", "operator", "tackle", "trackease", "track-ease", "api", "null", "undefined",
]);

/** Trim and lowercase on the server; reject anything outside the ASCII rule. */
export function normalizeUsername(value: string) {
  const username = value.trim().toLowerCase();
  if (username.length < USERNAME_MIN || username.length > USERNAME_MAX
    || !/^[a-z0-9_-]+$/.test(username) || !/[a-z0-9]/.test(username)) throw new Error("INVALID_USERNAME");
  if (RESERVED_USERNAMES.has(username)) throw new Error("USERNAME_UNAVAILABLE");
  return username;
}

/** Thai or English display names; control characters are refused. */
export function normalizeDisplayName(value: string) {
  const name = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (!name || [...name].length > DISPLAY_NAME_MAX || /[\p{Cc}\p{Cf}]/u.test(name)) throw new Error("INVALID_DISPLAY_NAME");
  return name;
}

export type PasswordProblem =
  | "PASSWORD_TOO_SHORT" | "PASSWORD_TOO_LONG" | "PASSWORD_HAS_SURROUNDING_WHITESPACE";

/**
 * One policy for signup, change and recovery: NFC first, then 15–100 code
 * points and no surrounding Unicode whitespace. The pinned password component
 * adds its common-password check and hashes the same NFC value.
 */
export function checkNewPassword(value: string): { password: string } | { problem: PasswordProblem } {
  const password = value.normalize("NFC");
  const length = [...password].length;
  if (length < PASSWORD_MIN_CODE_POINTS) return { problem: "PASSWORD_TOO_SHORT" };
  if (length > PASSWORD_MAX_CODE_POINTS) return { problem: "PASSWORD_TOO_LONG" };
  if (/^\s|\s$/u.test(password)) return { problem: "PASSWORD_HAS_SURROUNDING_WHITESPACE" };
  return { password };
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 26 Crockford Base32 characters carry the 128 random bits (130-bit space). */
export function encodeRecoveryCode(bytes: Uint8Array) {
  if (bytes.length !== 16) throw new Error("INVALID_RECOVERY_BYTES");
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  let out = "";
  for (let index = 0; index < 26; index++) {
    out = CROCKFORD[Number(bits & 31n)] + out;
    bits >>= 5n;
  }
  return out;
}

/** Reading groups of five; separators and case are ignored on entry. */
export function formatRecoveryCode(code: string) {
  return code.match(/.{1,5}/g)!.join("-");
}

/** Canonical form or null; I/L map to 1 and O to 0 as Crockford specifies. */
export function canonicalRecoveryCode(input: string) {
  const code = input.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(code) ? code : null;
}

export function randomBytes(length: number) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Invitation secrets: 256 random bits, URL-safe, only their digest is stored. */
export function newInvitationSecret() {
  return toBase64Url(randomBytes(32));
}

export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Purpose-separated digest; secrets never collide across uses. */
export function secretDigest(purpose: "staff-invite" | "project-invite" | "google-state", secret: string) {
  return sha256Hex(`${purpose}:v1:${secret}`);
}

export function recoveryCodeDigest(customerId: string, generation: number, canonicalCode: string) {
  return sha256Hex(`recovery-code:v1:${customerId}:${generation}:${canonicalCode}`);
}

/** Keyed digest for short codes, so a database copy cannot brute-force them. */
export async function challengeCodeDigest(key: string, challengeScope: string, code: string) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", material, new TextEncoder().encode(`challenge:v1:${challengeScope}:${code}`));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Eight decimal digits from rejection-sampled random bytes. */
export function newChallengeCode() {
  let code = "";
  while (code.length < 8) {
    const [byte] = randomBytes(1);
    if (byte < 250) code += String(byte % 10);
  }
  return code;
}

/** Compares digests without an early exit on the first difference. */
export function constantTimeEquals(left: string, right: string) {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index++) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

/** The JWT subject is the core session ID of a token minted in this transaction. */
export function accessTokenSessionId(accessToken: string) {
  const payload = accessToken.split(".")[1] ?? "";
  const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
  let claims: { sub?: unknown };
  try { claims = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))) as { sub?: unknown }; }
  catch { throw new Error("ADMISSION_REQUIRED"); }
  if (typeof claims.sub !== "string" || !claims.sub) throw new Error("ADMISSION_REQUIRED");
  return claims.sub;
}

export function normalizeEmail(value: string) {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("INVALID_EMAIL");
  return email;
}

type AdmissionLike<StaffId, CustomerId> = {
  principal: "pending" | "staff" | "customer";
  userId: string;
  staffId?: StaffId;
  customerId?: CustomerId;
  generation: number;
  revokedAt?: number;
};
type PrincipalLike = { userId: string; status: "active" | "disabled"; generation: number };

/**
 * The admission check every protected call runs: the live Convex Auth session
 * belongs to the admitted user, the admission is unrevoked, and the principal
 * is active at the admitted generation. Every failure is SESSION_EXPIRED.
 */
export function actorFromAdmission<StaffId extends string, CustomerId extends string>(input: {
  sessionUserId: string | null;
  admission: AdmissionLike<StaffId, CustomerId> | null;
  staff?: (PrincipalLike & { role: StaffRole }) | null;
  customer?: PrincipalLike | null;
}): Actor<CustomerId, StaffId> {
  const { sessionUserId, admission } = input;
  if (!sessionUserId || !admission || admission.revokedAt !== undefined || admission.userId !== sessionUserId) {
    throw new Error("SESSION_EXPIRED");
  }
  const live = (principal: PrincipalLike | null | undefined) => principal && principal.userId === sessionUserId
    && principal.status === "active" && principal.generation === admission.generation;
  if (admission.principal === "staff" && admission.staffId && live(input.staff)) {
    return { role: "staff", staffId: admission.staffId, staffRole: input.staff!.role };
  }
  if (admission.principal === "customer" && admission.customerId && live(input.customer)) {
    return { role: "customer", customerId: admission.customerId };
  }
  throw new Error(admission.principal === "pending" ? "IDENTITY_PENDING" : "SESSION_EXPIRED");
}

/**
 * A Google flow may admit a known principal only when it started strictly after
 * the principal's last disable/replacement/re-enable transition.
 */
export function googleFlowAdmissible(flowStartedAt: number, principal: { status: "active" | "disabled"; validAfter: number }) {
  return principal.status === "active" && flowStartedAt > principal.validAfter;
}
