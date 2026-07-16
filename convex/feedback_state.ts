export function validateFeedbackText(titleInput: string, descriptionInput: string) {
  const title = titleInput.trim();
  const description = descriptionInput.trim();
  if (!title) throw new Error("REQUIRED_FEEDBACK");
  if (title.length > 100) throw new Error("TITLE_TOO_LONG");
  if (description.length > 10_000) throw new Error("DESCRIPTION_TOO_LONG");
  return { title, description };
}

export function requireCurrentVersion(doc: { version?: number }, expectedVersion: number) {
  const currentVersion = doc.version ?? 0;
  if (currentVersion !== expectedVersion) {
    throw new Error("VERSION_CONFLICT");
  }
  return currentVersion;
}
