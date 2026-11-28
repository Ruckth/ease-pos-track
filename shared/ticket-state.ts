/** Bounds for ticket text, shared by every writer so limits cannot drift. */
export const MAX_TITLE_LENGTH = 100;
export const MAX_DESCRIPTION_LENGTH = 10_000;
export const MIN_URGENCY_SCORE = 1;
export const MAX_URGENCY_SCORE = 100;

export function validateTicketText(titleInput: string, descriptionInput: string) {
  const title = titleInput.trim();
  const description = descriptionInput.trim();
  if (!title) throw new Error("REQUIRED_TICKET");
  if (title.length > MAX_TITLE_LENGTH) throw new Error("TITLE_TOO_LONG");
  if (description.length > MAX_DESCRIPTION_LENGTH) throw new Error("DESCRIPTION_TOO_LONG");
  return { title, description };
}

/**
 * Urgency is staff triage metadata. Missing means the Ticket has not been
 * scored yet; every stored score is a whole number on the shared 1-100 scale.
 */
export function validateUrgencyScore(score: number | undefined) {
  if (score === undefined) return undefined;
  if (!Number.isInteger(score) || score < MIN_URGENCY_SCORE || score > MAX_URGENCY_SCORE) {
    throw new Error("INVALID_URGENCY_SCORE");
  }
  return score;
}

export function requireCurrentVersion(doc: { version: number }, expectedVersion: number) {
  const currentVersion = doc.version;
  if (currentVersion !== expectedVersion) {
    throw new Error("VERSION_CONFLICT");
  }
  return currentVersion;
}

export function ticketCustomerQueueGroup(status: "new" | "acknowledged" | "in_progress" | "waiting" | "done") {
  return status === "waiting" || status === "done" ? status : "active";
}
