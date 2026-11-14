/** Only structured transport data or an exact local validator code is actionable. */
export function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const data = "data" in error ? error.data : error;
  if (data && typeof data === "object" && "code" in data && typeof data.code === "string") return data.code;
  return error instanceof Error && /^[A-Z][A-Z_]+$/.test(error.message) ? error.message : undefined;
}
