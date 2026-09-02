/**
 * The CLI failure vocabulary: one error type, the exit codes it maps to, and the
 * translation from the Convex domain's validation codes.
 *
 * Everything else in the CLI — parser, adapters, orchestration — depends on this
 * module rather than on each other, so a code and its exit status are declared
 * exactly once.
 */

import { MAX_DESCRIPTION_LENGTH, MAX_TITLE_LENGTH } from "../../convex/feedback_state";
import { MAX_REQUEST_ID_LENGTH } from "../../convex/ticket_requests";

export const EXIT = {
  ok: 0,
  internal: 1,
  usage: 2,
  invalidInput: 3,
  auth: 4,
  conflict: 5,
  remote: 6,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

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
  REQUIRED_FEEDBACK: { code: "TITLE_REQUIRED", message: "--title is required and cannot be blank." },
  TITLE_TOO_LONG: { code: "TITLE_TOO_LONG", message: `--title must be ${MAX_TITLE_LENGTH} characters or fewer.` },
  DESCRIPTION_TOO_LONG: { code: "DESCRIPTION_TOO_LONG", message: `--description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer.` },
  REQUIRED_REQUEST_ID: { code: "REQUEST_ID_REQUIRED", message: "--request-id cannot be blank." },
  REQUEST_ID_TOO_LONG: { code: "REQUEST_ID_TOO_LONG", message: `--request-id must be ${MAX_REQUEST_ID_LENGTH} characters or fewer.` },
  INVALID_REQUEST_ID: { code: "INVALID_REQUEST_ID", message: "--request-id must not contain control characters." },
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
