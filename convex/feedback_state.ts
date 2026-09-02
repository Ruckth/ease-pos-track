/** Bounds for ticket text, shared by every writer so limits cannot drift. */
export const MAX_TITLE_LENGTH = 100;
export const MAX_DESCRIPTION_LENGTH = 10_000;

export function validateFeedbackText(titleInput: string, descriptionInput: string) {
  const title = titleInput.trim();
  const description = descriptionInput.trim();
  if (!title) throw new Error("REQUIRED_FEEDBACK");
  if (title.length > MAX_TITLE_LENGTH) throw new Error("TITLE_TOO_LONG");
  if (description.length > MAX_DESCRIPTION_LENGTH) throw new Error("DESCRIPTION_TOO_LONG");
  return { title, description };
}

export function requireCurrentVersion(doc: { version?: number }, expectedVersion: number) {
  const currentVersion = doc.version ?? 0;
  if (currentVersion !== expectedVersion) {
    throw new Error("VERSION_CONFLICT");
  }
  return currentVersion;
}
