/**
 * Rules for externally keyed ticket creation requests.
 *
 * Pure module: no Convex imports, so the retry semantics can be unit tested and
 * are shared by anything that creates a ticket on behalf of an outside caller.
 *
 * The contract a caller can rely on: the same request id with the same content
 * yields the same ticket, and the same request id with different content is an
 * error rather than a second ticket or a silent overwrite.
 */

export const MAX_REQUEST_ID_LENGTH = 200;

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

export type TicketContent = {
  title: string;
  description: string;
};

/** True when a retry carries exactly the content the stored ticket was created with. */
export function isSameTicketRequest(existing: TicketContent, requested: TicketContent) {
  return existing.title === requested.title && existing.description === requested.description;
}

/**
 * Guards a retry. Reusing a request id for different content is a caller bug —
 * failing loudly is safer than creating a duplicate ticket the caller will not
 * expect, or editing a ticket someone may already be working on.
 */
export function assertSameTicketRequest(existing: TicketContent, requested: TicketContent) {
  if (!isSameTicketRequest(existing, requested)) throw new Error("REQUEST_ID_CONFLICT");
}
