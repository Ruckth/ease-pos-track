import { errorCode } from "../../../shared/errors";

export function archiveFailureDisposition(error: unknown) {
  switch (errorCode(error)) {
    case "VERSION_CONFLICT": return "conflict";
    case "PROJECT_NOT_FOUND":
    case "TICKET_UNAVAILABLE":
    case "STAFF_ONLY": return "unavailable";
    case "INVALID_INPUT": return "rejected";
    default: return "unknown";
  }
}

export function archiveReadDisposition(
  latest: { lifecycle: "active" | "archived"; version: number } | null,
  submittedVersion: number,
) {
  if (latest?.lifecycle === "archived") return "archived";
  return latest && latest.version > submittedVersion ? "review" : "unresolved";
}
