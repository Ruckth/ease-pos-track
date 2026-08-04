/**
 * Session token storage shared by the staff workspace and the customer portal.
 *
 * Tokens live in sessionStorage only; any token left in localStorage by an older
 * build is migrated and removed.
 */

const SESSION_KEY = "ease-pos-tracking-session";
const CLIENT_ID_KEY = "ease-pos-client-id";

export type SessionRole = "staff" | "customer";

export function getStoredToken() {
  const token = window.sessionStorage.getItem(SESSION_KEY) ?? window.localStorage.getItem(SESSION_KEY) ?? "";
  if (token) window.sessionStorage.setItem(SESSION_KEY, token);
  window.localStorage.removeItem(SESSION_KEY);
  return token;
}

export function storeToken(token: string) {
  window.sessionStorage.setItem(SESSION_KEY, token);
}

export function clearToken() {
  window.sessionStorage.removeItem(SESSION_KEY);
  window.localStorage.removeItem(SESSION_KEY);
}

/** Stable per-browser id used by the sign-in rate limiters. */
export function getClientId() {
  const existing = window.localStorage.getItem(CLIENT_ID_KEY);
  if (existing) return existing;
  const clientId = crypto.randomUUID();
  window.localStorage.setItem(CLIENT_ID_KEY, clientId);
  return clientId;
}
