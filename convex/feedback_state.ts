export function validateFeedbackText(titleInput: string, descriptionInput: string) {
  const title = titleInput.trim();
  const description = descriptionInput.trim();
  if (!title || !description) throw new Error("Topic and description are required.");
  if (title.length > 100) throw new Error("Topic must be 100 characters or fewer.");
  if (description.length > 10_000) throw new Error("Description must be 10,000 characters or fewer.");
  return { title, description };
}

export function requireCurrentVersion(doc: { version?: number }, expectedVersion: number) {
  const currentVersion = doc.version ?? 0;
  if (currentVersion !== expectedVersion) {
    throw new Error("This feedback changed in another session. Refresh it before trying again.");
  }
  return currentVersion;
}
