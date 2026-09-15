export const TAG_COLORS = ["slate", "red", "orange", "green", "blue", "violet"] as const;
export type TagColor = typeof TAG_COLORS[number];
export const MAX_TAG_NAME_LENGTH = 32;
export const MAX_TICKET_TAGS = 20;

export function normalizeTagName(input: string) {
  const name = input.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!name || name.length > MAX_TAG_NAME_LENGTH || new RegExp("[\\p{Cc}\\p{Cf}]", "u").test(name)) {
    throw new Error("INVALID_TAG_NAME");
  }
  return { name, normalizedName: name.toLowerCase() };
}

export function normalizeTagIds<T extends string>(ids: T[]): T[] {
  if (ids.length > MAX_TICKET_TAGS) throw new Error("TOO_MANY_TAGS");
  return Array.from(new Set(ids)).sort();
}
