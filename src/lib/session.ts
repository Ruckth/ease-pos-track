/** The two workspace roles; a pending Google identity has neither. */
export type SessionRole = "staff" | "customer";

/** Reads a secret carried in the URL fragment, which never reaches a server log. */
export function readFragmentSecret() {
  return new URLSearchParams(window.location.hash.slice(1)).get("invite") ?? "";
}
