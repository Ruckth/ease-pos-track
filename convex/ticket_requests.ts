/**
 * Rules for externally keyed ticket creation requests.
 *
 * Request-id validation is shared with the CLI. Runtime hashing consumes the
 * shared canonical input; receipt persistence/authorization lives in the domain.
 *
 * The contract a caller can rely on: the same request id with the same content
 * yields the same ticket, and the same request id with different content is an
 * error rather than a second ticket or a silent overwrite.
 */

export const MAX_REQUEST_ID_LENGTH = 200;
export type TicketContent = { title: string; description: string };

/**
 * Trims and bounds a caller-supplied request id. Control characters are refused
 * so an id stays safe to echo back in logs and JSON.
 */
export function normalizeRequestId(value: string) {
  const requestId = value.trim();
  if (!requestId) throw new Error("REQUIRED_REQUEST_ID");
  if (requestId.length > MAX_REQUEST_ID_LENGTH) throw new Error("REQUEST_ID_TOO_LONG");
  if (/[\u0000-\u001f\u007f]/.test(requestId)) throw new Error("INVALID_REQUEST_ID");
  return requestId;
}

/** Runtime boundary: shared canonicalization supplies the input, never a client digest. */
export async function hashTicketRequest(fingerprint: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fingerprint));
  return { digestVersion: 1, inputDigest: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("") };
}
