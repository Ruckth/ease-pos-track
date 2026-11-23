/**
 * The CLI failure vocabulary: one error type, the exit codes it maps to, and the
 * translation from the Convex domain's validation codes.
 *
 * Everything else in the CLI — parser, adapters, orchestration — depends on this
 * module rather than on each other, so a code and its exit status are declared
 * exactly once.
 */

import { MAX_DESCRIPTION_LENGTH, MAX_TITLE_LENGTH } from "../../shared/ticket-state";
import { MAX_REQUEST_ID_LENGTH } from "../../convex/ticket_requests";
import { PAGE_FILE_EXTENSIONS, PAGE_LIMITS } from "../../shared/ticket-pages";

const MIB = 1024 * 1024;

export const EXIT = {
  ok: 0,
  internal: 1,
  usage: 2,
  invalidInput: 3,
  auth: 4,
  conflict: 5,
  remote: 6,
} as const;

type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class TicketCliError extends Error {
  constructor(readonly code: string, message: string, readonly exitCode: number, readonly hint?: string) {
    super(message);
    this.name = "TicketCliError";
  }
}

const DISCOVERY_HINT = "Run `pnpm ticket --help` or `pnpm ticket commands`.";

/** The caller phrased the command wrong: exit 2. */
export function usageError(code: string, message: string) {
  return new TicketCliError(code, message, EXIT.usage, DISCOVERY_HINT);
}

/** The command was well formed but the Ticket input was not: exit 3. */
export function inputError(code: string, message: string) {
  return new TicketCliError(code, message, EXIT.invalidInput);
}

/** Configuration, session, or authorization failure: exit 4. */
export function authError(code: string, message: string, hint?: string) {
  return new TicketCliError(code, message, EXIT.auth, hint);
}

/** Idempotency-key or optimistic-version conflict: exit 5. */
export function conflictError(code: string, message: string, hint: string) {
  return new TicketCliError(code, message, EXIT.conflict, hint);
}

/** The deployment could not be reached or answered with something unexpected: exit 6. */
export function remoteError(message: string) {
  return new TicketCliError("REMOTE_CALL_FAILED", message, EXIT.remote);
}

/** A CLI invariant broke, rather than the caller or the deployment: exit 1. */
export function internalError(message: string) {
  return new TicketCliError("INTERNAL_ERROR", message, EXIT.internal);
}

/**
 * Convex validation code to CLI code and flag-oriented message. The limits come
 * from the domain modules so a bound can never be described here and enforced
 * differently there.
 */
const INPUT_ERRORS: Record<string, { code: string; message: string }> = {
  REQUIRED_TICKET: { code: "TITLE_REQUIRED", message: "--title is required and cannot be blank." },
  TITLE_TOO_LONG: { code: "TITLE_TOO_LONG", message: `--title must be ${MAX_TITLE_LENGTH} characters or fewer.` },
  DESCRIPTION_TOO_LONG: { code: "DESCRIPTION_TOO_LONG", message: `--description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer.` },
  REQUIRED_REQUEST_ID: { code: "REQUEST_ID_REQUIRED", message: "--request-id cannot be blank." },
  REQUEST_ID_TOO_LONG: { code: "REQUEST_ID_TOO_LONG", message: `--request-id must be ${MAX_REQUEST_ID_LENGTH} characters or fewer.` },
  INVALID_REQUEST_ID: { code: "INVALID_REQUEST_ID", message: "--request-id must not contain control characters." },
  IMAGE_VIDEO_ONLY: { code: "IMAGE_TYPE_UNSUPPORTED", message: "--image accepts image files only." },
  MEDIA_LIMIT_EXCEEDED: { code: "IMAGE_LIMIT_EXCEEDED", message: "A Ticket can contain at most 10 images." },
  IMAGE_TOO_LARGE: { code: "IMAGE_SIZE_INVALID", message: "Each --image must be larger than zero and no more than 8 MB." },
  INVALID_FILE_METADATA: { code: "INVALID_IMAGE_SOURCE", message: "An image has invalid file metadata." },
  INVALID_MEDIA_REFERENCE: { code: "INVALID_IMAGE_SOURCE", message: "An image upload did not produce a valid HTTPS reference." },
  INVALID_PROJECT_KEY: { code: "INVALID_PROJECT", message: "--project must be 2-10 letters or digits, starting with a letter." },
  PROJECT_NOT_FOUND: { code: "PROJECT_NOT_FOUND", message: "No active Project has that key." },
  PROJECT_REQUIRED: { code: "PROJECT_REQUIRED", message: "More than one Project exists; pass --project with its key." },
  PAGE_FILES_REQUIRED: { code: "PAGE_FILES_REQUIRED", message: "The page has no files to publish." },
  PAGE_FILE_LIMIT: { code: "PAGE_FILE_LIMIT", message: `A page can contain at most ${PAGE_LIMITS.maxFiles} files.` },
  PAGE_TOO_LARGE: { code: "PAGE_TOO_LARGE", message: `A page can contain at most ${PAGE_LIMITS.maxTotalBytes / MIB} MiB of files.` },
  PAGE_PATH_INVALID: { code: "PAGE_PATH_INVALID", message: "A file path is not a safe relative path inside the page." },
  PAGE_PATH_DUPLICATE: { code: "PAGE_PATH_DUPLICATE", message: "Two files resolve to the same path." },
  PAGE_FILE_TYPE_UNSUPPORTED: { code: "PAGE_FILE_TYPE_UNSUPPORTED", message: `Pages accept only ${PAGE_FILE_EXTENSIONS.join(", ")} files.` },
  PAGE_FILE_INVALID: { code: "PAGE_FILE_INVALID", message: "A page file has invalid metadata." },
  PAGE_ENTRY_INVALID: { code: "PAGE_ENTRY_INVALID", message: "--entry must name an .html or .htm file inside the page." },
  PAGE_FORM_INVALID: { code: "PAGE_FORM_INVALID", message: "The page upload request was malformed." },
  PAGE_LIMIT_REACHED: { code: "PAGE_LIMIT_REACHED", message: `A Ticket can have at most ${PAGE_LIMITS.maxPagesPerTicket} pages; revoke one first.` },
};

/** The validation codes a remote call can also report, for error classification. */
export const SERVER_INPUT_ERROR_CODES = Object.keys(INPUT_ERRORS);

export function mapInputError(error: unknown) {
  const serverCode = error instanceof Error ? error.message : String(error);
  const known = INPUT_ERRORS[serverCode];
  return known
    ? inputError(known.code, known.message)
    : inputError(serverCode, `Invalid Ticket input: ${serverCode}.`);
}

/**
 * Runs a domain validator and re-labels its thrown code as CLI input failure,
 * so every validated flag reports through the same table.
 */
export function validated<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw mapInputError(error);
  }
}
