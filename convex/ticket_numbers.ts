/**
 * Ticket references and Project keys. Pure module: the UI, the audit trail and
 * the Ticket CLI all format and parse references through here.
 *
 * A Ticket reference is `<PROJECT KEY>-<number>`, for example `POS-0012`.
 * Numbers count up per Project, and a Project key never changes once created,
 * so a reference stays valid for the life of its Ticket.
 */

export const MAX_PROJECT_NAME_LENGTH = 80;

/** 2-10 characters: an uppercase letter, then uppercase letters or digits. */
const PROJECT_KEY = /^[A-Z][A-Z0-9]{1,9}$/;

export function isValidTicketNumber(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value > 0;
}

/** The immutable Project key and number form the public Ticket reference. */
export function formatTicketNumber(ticketNumber: number, projectKey: string) {
  return `${projectKey}-${String(ticketNumber).padStart(4, "0")}`;
}

/** Parses `POS-0012` (any case) into its Project key and number, or null. */
export function parseTicketReference(value: string) {
  const match = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d{4,})$/.exec(value.trim());
  if (!match) return null;
  const ticketNumber = Number(match[2]);
  if (!Number.isSafeInteger(ticketNumber) || ticketNumber < 1) return null;
  return { projectKey: match[1].toUpperCase(), ticketNumber };
}

export function normalizeProjectKey(value: string) {
  const key = value.trim().toUpperCase();
  if (!PROJECT_KEY.test(key)) throw new Error("INVALID_PROJECT_KEY");
  return key;
}

export function validateProjectName(value: string) {
  const name = value.trim();
  if (!name) throw new Error("REQUIRED_PROJECT_NAME");
  if (name.length > MAX_PROJECT_NAME_LENGTH) throw new Error("PROJECT_NAME_TOO_LONG");
  return name;
}

/**
 * A starting key for the "New Project" form: the initials of a multi-word name,
 * or the first letters of a single word. The person creating the Project can
 * still change it before saving.
 */
export function suggestProjectKey(name: string) {
  const words = name.toUpperCase().match(/[A-Z][A-Z0-9]*/g) ?? [];
  const candidate = words.length > 1 ? words.map((word) => word[0]).join("") : (words[0] ?? "");
  return candidate.slice(0, 4);
}
