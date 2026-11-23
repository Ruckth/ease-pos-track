export const TITLE_MAX_LENGTH = 100;
export const DESCRIPTION_MAX_LENGTH = 10_000;

/** Optional attachments and review never participate in the text-only gate. */
export function ticketDraftIssue(draft: { title: string; description: string }): "REQUIRED_TITLE" | "TITLE_TOO_LONG" | "DESCRIPTION_TOO_LONG" | null {
  if (!draft.title.trim()) return "REQUIRED_TITLE";
  if (draft.title.trim().length > TITLE_MAX_LENGTH) return "TITLE_TOO_LONG";
  if (draft.description.trim().length > DESCRIPTION_MAX_LENGTH) return "DESCRIPTION_TOO_LONG";
  return null;
}
