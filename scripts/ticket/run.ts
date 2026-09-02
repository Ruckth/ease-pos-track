/**
 * Command orchestration: turn one parsed command into one JSON line and one exit
 * code, and turn any failure into the single-object stderr contract.
 *
 * Parsing lives in `cli.ts`, JSON shapes in `output.ts`, deployment calls behind
 * `TicketRemote`, and session policy in `TicketSessions`; this module only
 * decides the order those are used in.
 */

import { formatTicketNumber } from "../../convex/ticket_numbers";
import { parseTicketArgs, type TicketCommand } from "./cli";
import type { ConfigStore } from "./config";
import { authHint, type Deployment } from "./deployment";
import {
  authError,
  conflictError,
  EXIT,
  inputError,
  internalError,
  mapInputError,
  remoteError,
  SERVER_INPUT_ERROR_CODES,
  TicketCliError,
} from "./errors";
import type { CredentialStore } from "./keychain";
import {
  createOutput,
  dryRunOutput,
  errorOutput,
  jsonLine,
  listOutput,
  loginOutput,
  logoutOutput,
  ticketOutput,
  whoamiOutput,
} from "./output";
import { commandDiscoveryOutput, humanHelp } from "./registry";
import type { TicketRemote } from "./remote";
import { TicketSessions, credentialError, type StaffAccess } from "./session";

export type TicketCliDeps = {
  remote: TicketRemote;
  config: ConfigStore;
  credentials: CredentialStore;
  readPassword: () => Promise<string>;
  newRequestId: () => string;
  now: () => number;
  env: NodeJS.ProcessEnv;
};

export type TicketCliOutcome = { exitCode: number; stdout: string; stderr: string };

/** Commands that need a deployment but not a staff session. */
type SessionCommand = Extract<TicketCommand, { kind: "login" | "logout" }>;
/**
 * Commands that run against a validated staff session. `create` is handled
 * separately because its idempotency key must exist before authentication, so a
 * failed run can still report which key was in play.
 */
type StaffCommand = Exclude<TicketCommand, { kind: "help" | "commands" | "login" | "logout" | "create" }>;

function unreachable(command: never): never {
  const { kind } = command as { kind: string };
  throw internalError(`Unsupported Ticket command "${kind}".`);
}

/**
 * Convex reports domain failures as thrown errors whose text carries a stable
 * code. Order matters: the first matching rule wins, and generic remote failure
 * is the fallback.
 */
const REMOTE_ERROR_RULES: ReadonlyArray<{ codes: string[]; toError: (target: Deployment) => TicketCliError }> = [
  {
    codes: ["REQUEST_ID_CONFLICT"],
    toError: () => conflictError("REQUEST_ID_CONFLICT", "This request id already created a different Ticket.", "Use a new --request-id for different content."),
  },
  {
    codes: ["VERSION_CONFLICT"],
    toError: () => conflictError("VERSION_CONFLICT", "The Ticket changed after it was read.", "Run `pnpm ticket get TKT-####`, then retry with its current version."),
  },
  {
    codes: ["INCORRECT_PASSWORD"],
    toError: (target) => credentialError("INVALID_CREDENTIALS", "The staff password is incorrect.", target),
  },
  {
    codes: ["AUTH_RATE_LIMITED"],
    toError: () => authError("AUTH_RATE_LIMITED", "Too many sign-in attempts. Try again after the lockout window."),
  },
  {
    codes: ["SESSION_EXPIRED"],
    toError: (target) => credentialError("SESSION_EXPIRED", "The saved Ticket session is expired or no longer valid.", target),
  },
  {
    codes: ["STAFF_ONLY"],
    toError: (target) => authError("NOT_AUTHORIZED", "This command requires a staff session.", authHint(target)),
  },
  {
    codes: ["FEEDBACK_NOT_FOUND", "ARCHIVED_FEEDBACK_NOT_FOUND"],
    toError: () => inputError("TICKET_NOT_FOUND", "The Ticket does not exist or is not available for this operation."),
  },
];

const REMOTE_DETAIL_LIMIT = 300;

export function classifyRemoteError(error: unknown, target: Deployment) {
  if (error instanceof TicketCliError) return error;
  const text = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  for (const rule of REMOTE_ERROR_RULES) {
    if (rule.codes.some((code) => text.includes(code))) return rule.toError(target);
  }
  for (const code of SERVER_INPUT_ERROR_CODES) {
    if (text.includes(code)) return mapInputError(new Error(code));
  }
  const detail = text.trim().split("\n")[0].slice(0, REMOTE_DETAIL_LIMIT);
  return remoteError(`The Convex deployment call failed${detail ? `: ${detail}` : "."}`);
}

async function runSessionCommand(command: SessionCommand, sessions: TicketSessions, deps: TicketCliDeps) {
  const target = command.deployment;
  switch (command.kind) {
    case "logout":
      return logoutOutput(target, await sessions.logout(target));
    case "login": {
      const password = await deps.readPassword();
      return loginOutput(target, await sessions.login(target, command.url, password));
    }
    default:
      return unreachable(command);
  }
}

async function runStaffCommand(command: StaffCommand, access: StaffAccess, deps: TicketCliDeps) {
  const target = command.deployment;
  const { url, token, session } = access;
  const remote = deps.remote;
  switch (command.kind) {
    case "whoami":
      return whoamiOutput(target, url, session);
    case "list":
      return listOutput(target, await remote.list(url, token, command.includeArchived));
    case "get": {
      const ticket = await remote.get(url, token, command.ticketNumber, command.includeArchived);
      if (!ticket) throw inputError("TICKET_NOT_FOUND", `Ticket ${formatTicketNumber(command.ticketNumber)} was not found.`);
      return ticketOutput(target, ticket);
    }
    case "update":
      return ticketOutput(target, await remote.update(url, token, command));
    case "status":
      return ticketOutput(target, await remote.changeStatus(url, token, command));
    case "archive":
      return ticketOutput(target, await remote.archive(url, token, command.ticketNumber, command.expectedVersion));
    case "restore":
      return ticketOutput(target, await remote.restore(url, token, command.ticketNumber, command.expectedVersion));
    default:
      return unreachable(command);
  }
}

function succeed(stdout: string): TicketCliOutcome {
  return { exitCode: EXIT.ok, stdout, stderr: "" };
}

export async function runTicketCli(argv: string[], deps: TicketCliDeps): Promise<TicketCliOutcome> {
  // Kept outside the try so a failure can still report which deployment and
  // which idempotency key the run was using.
  let target: Deployment | undefined;
  let requestId: string | undefined;
  try {
    const command = parseTicketArgs(argv);
    if (command.kind === "help") return succeed(`${humanHelp(command.command)}\n`);
    if (command.kind === "commands") return succeed(jsonLine(commandDiscoveryOutput()));
    target = command.deployment;

    const sessions = new TicketSessions(deps);
    if (command.kind === "login" || command.kind === "logout") {
      return succeed(jsonLine(await runSessionCommand(command, sessions, deps)));
    }
    if (command.kind === "create") {
      const idempotencyKey = command.request.requestId ?? deps.newRequestId();
      requestId = idempotencyKey;
      if (command.dryRun) return succeed(jsonLine(dryRunOutput(target, command.request, idempotencyKey)));
      const { url, token } = await sessions.requireStaff(target);
      const created = await deps.remote.create(url, token, { ...command.request, requestId: idempotencyKey });
      return succeed(jsonLine(createOutput(target, created)));
    }
    return succeed(jsonLine(await runStaffCommand(command, await sessions.requireStaff(target), deps)));
  } catch (error) {
    const failure = error instanceof TicketCliError
      ? error
      : target
        ? classifyRemoteError(error, target)
        : internalError(error instanceof Error ? error.message : String(error));
    return { exitCode: failure.exitCode, stdout: "", stderr: jsonLine(errorOutput(failure, target, requestId)) };
  }
}
