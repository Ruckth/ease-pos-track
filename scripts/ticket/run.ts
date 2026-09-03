/**
 * Command orchestration: turn one parsed command into one JSON line and one exit
 * code, and turn any failure into the single-object stderr contract.
 *
 * Parsing lives in `cli.ts`, JSON shapes in `output.ts`, deployment calls behind
 * `TicketRemote`, and session policy in `TicketSessions`; this module only
 * decides the order those are used in.
 */

import { formatTicketNumber } from "../../convex/ticket_numbers";
import { createHash } from "node:crypto";
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
  attachmentOutput,
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
import type { TicketImages } from "./images";
import { TicketSessions, credentialError, type StaffAccess } from "./session";

export type TicketCliDeps = {
  remote: TicketRemote;
  config: ConfigStore;
  credentials: CredentialStore;
  readPassword: () => Promise<string>;
  newRequestId: () => string;
  now: () => number;
  env: NodeJS.ProcessEnv;
  images: TicketImages;
};

export type TicketCliOutcome = { exitCode: number; stdout: string; stderr: string };

/** Commands that need a deployment but not a staff session. */
type SessionCommand = Extract<TicketCommand, { kind: "login" | "logout" }>;
/**
 * Commands that run against a validated staff session. `create` is handled
 * separately because its idempotency key must exist before authentication, so a
 * failed run can still report which key was in play.
 */
type StaffCommand = Exclude<TicketCommand, { kind: "help" | "commands" | "login" | "logout" | "create" | "attach" }>;

function uploadRequestId(requestId: string) {
  return createHash("sha256").update(`ticket-images\0${requestId}`).digest("hex");
}

function sameFileMetadata(file: File, media: { name: string; size: number; type: string }) {
  return file.name === media.name && file.size === media.size && file.type === media.type;
}

async function attachTicketImages(
  input: { ticketNumber: number; expectedVersion: number; images: string[]; requestId: string },
  access: StaffAccess,
  deps: TicketCliDeps,
) {
  const files = await deps.images.prepare(input.images);
  const intent = await deps.remote.createUploadIntent(access.url, access.token, {
    requestId: uploadRequestId(input.requestId),
    files: files.map((file) => ({ name: file.name, size: file.size, type: file.type })),
  });
  if (intent.feedbackId) {
    const existing = await deps.remote.get(access.url, access.token, input.ticketNumber, false);
    if (!existing || existing._id !== intent.feedbackId) throw inputError("UPLOAD_INTENT_MISMATCH", "The image retry belongs to a different Ticket.");
    return existing;
  }
  const reusable = [...intent.uploadedFiles];
  const resolved = files.map((file) => {
    const index = reusable.findIndex((media) => sameFileMetadata(file, media));
    if (index < 0) return undefined;
    return reusable.splice(index, 1)[0];
  });
  const missing = files.flatMap((file, index) => resolved[index] ? [] : [{ file, index }]);
  const uploaded = missing.length === 0 ? [] : await deps.images.upload(missing.map(({ file }) => file));
  uploaded.forEach((media, offset) => {
    resolved[missing[offset].index] = media;
  });
  for (const file of uploaded) {
    await deps.remote.recordUploadedFile(access.url, { intentId: intent.intentId, secret: intent.secret, file });
  }
  const media = resolved.filter((item): item is NonNullable<typeof item> => item !== undefined);
  if (media.length !== files.length) throw internalError("The image upload result did not match the requested files.");
  return await deps.remote.attachImages(access.url, access.token, {
    ticketNumber: input.ticketNumber,
    expectedVersion: input.expectedVersion,
    intentId: intent.intentId,
    secret: intent.secret,
    media,
  });
}

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
    codes: ["UPLOAD_REQUEST_CONFLICT"],
    toError: () => conflictError("UPLOAD_REQUEST_CONFLICT", "This request id was already used with different images.", "Use the same --request-id only when retrying the same images."),
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
      if (command.dryRun) {
        const files = await deps.images.prepare(command.images);
        return succeed(jsonLine(dryRunOutput(target, command.request, idempotencyKey, files)));
      }
      const access = await sessions.requireStaff(target);
      const { url, token } = access;
      const created = await deps.remote.create(url, token, { ...command.request, requestId: idempotencyKey });
      if (command.images.length > 0) {
        created.ticket = await attachTicketImages({
          ticketNumber: created.ticket.ticketNumber!,
          expectedVersion: created.ticket.version ?? 0,
          images: command.images,
          requestId: idempotencyKey,
        }, access, deps);
      }
      return succeed(jsonLine(createOutput(target, created)));
    }
    if (command.kind === "attach") {
      requestId = command.requestId ?? deps.newRequestId();
      const access = await sessions.requireStaff(target);
      const attached = await attachTicketImages({ ...command, requestId }, access, deps);
      return succeed(jsonLine(attachmentOutput(target, attached, requestId)));
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
