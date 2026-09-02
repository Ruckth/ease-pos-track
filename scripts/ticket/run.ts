import { formatTicketNumber } from "../../convex/ticket_numbers";
import {
  dryRunOutput,
  errorOutput,
  EXIT,
  HELP,
  mapInputError,
  parseTicketArgs,
  TicketCliError,
  type Deployment,
} from "./cli";
import { commandDiscoveryOutput, humanHelp } from "./registry";
import type { TicketDocument, TicketRemote } from "./remote";
import { authHint, credentialError, TicketSessions } from "./session";
import { toPublicTicketStatus } from "./status";
import {
  type ConfigStore,
  type CredentialStore,
} from "./stores";

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

function line(payload: unknown) {
  return `${JSON.stringify(payload)}\n`;
}

function ticketSummary(ticket: TicketDocument) {
  return {
    id: ticket._id,
    ticket: formatTicketNumber(ticket.ticketNumber),
    ticketNumber: ticket.ticketNumber ?? null,
    title: ticket.title,
    description: ticket.description,
    status: toPublicTicketStatus(ticket.status),
    version: ticket.version ?? 0,
    archived: ticket.deletedAt !== undefined,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    origin: ticket.origin ?? null,
    createdVia: ticket.createdVia ?? null,
    mediaCount: ticket.media.length,
    annotationCount: ticket.annotations?.length ?? 0,
  };
}

function ticketDetail(ticket: TicketDocument) {
  return {
    ...ticketSummary(ticket),
    media: ticket.media,
    annotations: ticket.annotations ?? [],
  };
}

export function classifyRemoteError(error: unknown, target: Deployment) {
  if (error instanceof TicketCliError) return error;
  const text = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  if (text.includes("REQUEST_ID_CONFLICT")) {
    return new TicketCliError("REQUEST_ID_CONFLICT", "This request id already created a different Ticket.", EXIT.conflict, "Use a new --request-id for different content.");
  }
  if (text.includes("VERSION_CONFLICT")) {
    return new TicketCliError("VERSION_CONFLICT", "The Ticket changed after it was read.", EXIT.conflict, "Run `pnpm ticket get TKT-####`, then retry with its current version.");
  }
  if (text.includes("INCORRECT_PASSWORD")) return credentialError("INVALID_CREDENTIALS", "The staff password is incorrect.", target);
  if (text.includes("AUTH_RATE_LIMITED")) return new TicketCliError("AUTH_RATE_LIMITED", "Too many sign-in attempts. Try again after the lockout window.", EXIT.auth);
  if (text.includes("SESSION_EXPIRED")) return credentialError("SESSION_EXPIRED", "The saved Ticket session is expired or no longer valid.", target);
  if (text.includes("STAFF_ONLY")) return new TicketCliError("NOT_AUTHORIZED", "This command requires a staff session.", EXIT.auth, authHint(target));
  if (text.includes("FEEDBACK_NOT_FOUND") || text.includes("ARCHIVED_FEEDBACK_NOT_FOUND")) {
    return new TicketCliError("TICKET_NOT_FOUND", "The Ticket does not exist or is not available for this operation.", EXIT.invalidInput);
  }
  for (const code of ["REQUIRED_FEEDBACK", "TITLE_TOO_LONG", "DESCRIPTION_TOO_LONG", "REQUIRED_REQUEST_ID", "REQUEST_ID_TOO_LONG", "INVALID_REQUEST_ID"]) {
    if (text.includes(code)) return mapInputError(new Error(code));
  }
  const first = text.trim().split("\n")[0].slice(0, 300);
  return new TicketCliError("REMOTE_CALL_FAILED", `The Convex deployment call failed${first ? `: ${first}` : "."}`, EXIT.remote);
}

export async function runTicketCli(argv: string[], deps: TicketCliDeps): Promise<TicketCliOutcome> {
  let target: Deployment | undefined;
  let requestId: string | undefined;
  try {
    const sessions = new TicketSessions(deps);
    const command = parseTicketArgs(argv);
    if (command.kind === "help") return { exitCode: EXIT.ok, stdout: `${command.command ? humanHelp(command.command) : HELP}\n`, stderr: "" };
    if (command.kind === "commands") return { exitCode: EXIT.ok, stdout: line(commandDiscoveryOutput()), stderr: "" };
    target = command.deployment;

    if (command.kind === "create") {
      requestId = command.request.requestId ?? deps.newRequestId();
      if (command.dryRun) return { exitCode: EXIT.ok, stdout: line(dryRunOutput(command.request, target, requestId)), stderr: "" };
    }

    if (command.kind === "logout") {
      const loggedOut = await sessions.logout(target);
      return { exitCode: EXIT.ok, stdout: line({ ok: true, loggedOut, deployment: target }), stderr: "" };
    }

    if (command.kind === "login") {
      const password = await deps.readPassword();
      const result = await sessions.login(target, command.url, password);
      return { exitCode: EXIT.ok, stdout: line({ ok: true, authenticated: true, role: "staff", deployment: target, ...result }), stderr: "" };
    }

    const { url, token, session } = await sessions.requireStaff(target);
    if (command.kind === "whoami") {
      return { exitCode: EXIT.ok, stdout: line({ ok: true, authenticated: true, role: session.role, deployment: target, url, expiresAt: session.expiresAt }), stderr: "" };
    }
    if (command.kind === "list") {
      const tickets = await deps.remote.list(url, token, command.includeArchived);
      return { exitCode: EXIT.ok, stdout: line({ ok: true, deployment: target, count: tickets.length, tickets: tickets.map(ticketSummary) }), stderr: "" };
    }
    if (command.kind === "get") {
      const ticket = await deps.remote.get(url, token, command.ticketNumber, command.includeArchived);
      if (!ticket) throw new TicketCliError("TICKET_NOT_FOUND", `Ticket ${formatTicketNumber(command.ticketNumber)} was not found.`, EXIT.invalidInput);
      return { exitCode: EXIT.ok, stdout: line({ ok: true, deployment: target, ticket: ticketDetail(ticket) }), stderr: "" };
    }
    if (command.kind === "create") {
      const result = await deps.remote.create(url, token, { ...command.request, requestId: requestId as string });
      return { exitCode: EXIT.ok, stdout: line({
        ok: true,
        id: result.ticket._id,
        ticket: formatTicketNumber(result.ticket.ticketNumber),
        ticketNumber: result.ticket.ticketNumber,
        status: toPublicTicketStatus(result.ticket.status),
        version: result.ticket.version ?? 0,
        created: result.created,
        deployment: target,
        requestId: result.requestId,
      }), stderr: "" };
    }
    if (command.kind === "update") {
      const ticket = await deps.remote.update(url, token, command);
      return { exitCode: EXIT.ok, stdout: line({ ok: true, deployment: target, ticket: ticketDetail(ticket) }), stderr: "" };
    }
    if (command.kind === "status") {
      const ticket = await deps.remote.changeStatus(url, token, command);
      return { exitCode: EXIT.ok, stdout: line({ ok: true, deployment: target, ticket: ticketDetail(ticket) }), stderr: "" };
    }
    if (command.kind === "archive") {
      const ticket = await deps.remote.archive(url, token, command.ticketNumber, command.expectedVersion);
      return { exitCode: EXIT.ok, stdout: line({ ok: true, deployment: target, ticket: ticketDetail(ticket) }), stderr: "" };
    }
    const ticket = await deps.remote.restore(url, token, command.ticketNumber, command.expectedVersion);
    return { exitCode: EXIT.ok, stdout: line({ ok: true, deployment: target, ticket: ticketDetail(ticket) }), stderr: "" };
  } catch (error) {
    const failure = error instanceof TicketCliError
      ? error
      : target ? classifyRemoteError(error, target) : new TicketCliError("INTERNAL_ERROR", error instanceof Error ? error.message : String(error), EXIT.internal);
    return { exitCode: failure.exitCode, stdout: "", stderr: line(errorOutput(failure, target, requestId)) };
  }
}
