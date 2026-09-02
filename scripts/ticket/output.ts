/**
 * Every byte the CLI prints to stdout or stderr is shaped here.
 *
 * The machine contract is one compact JSON object per run, with stable keys in a
 * stable order, so these builders are the only place a field name, key order, or
 * public status value is decided.
 */

import { formatTicketNumber } from "../../convex/ticket_numbers";
import type { TicketContent } from "../../convex/ticket_requests";
import type { Deployment } from "./deployment";
import type { TicketCliError } from "./errors";
import type { CurrentSession, TicketDocument } from "./remote";
import { toPublicTicketStatus } from "./status";

/** One compact JSON object plus the trailing newline. */
export function jsonLine(payload: unknown) {
  return `${JSON.stringify(payload)}\n`;
}

export function ticketSummary(ticket: TicketDocument) {
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

export function ticketDetail(ticket: TicketDocument) {
  return {
    ...ticketSummary(ticket),
    media: ticket.media,
    annotations: ticket.annotations ?? [],
  };
}

export function listOutput(deployment: Deployment, tickets: TicketDocument[]) {
  return { ok: true as const, deployment, count: tickets.length, tickets: tickets.map(ticketSummary) };
}

/** The reply for every command that returns one Ticket: get, update, status, archive, restore. */
export function ticketOutput(deployment: Deployment, ticket: TicketDocument) {
  return { ok: true as const, deployment, ticket: ticketDetail(ticket) };
}

export function createOutput(
  deployment: Deployment,
  result: { ticket: TicketDocument; created: boolean; requestId: string },
) {
  return {
    ok: true as const,
    id: result.ticket._id,
    ticket: formatTicketNumber(result.ticket.ticketNumber),
    ticketNumber: result.ticket.ticketNumber,
    status: toPublicTicketStatus(result.ticket.status),
    version: result.ticket.version ?? 0,
    created: result.created,
    deployment,
    requestId: result.requestId,
  };
}

/** The Ticket a create would write, without contacting the deployment. */
export function dryRunOutput(deployment: Deployment, request: TicketContent, requestId: string) {
  return {
    ok: true as const,
    dryRun: true as const,
    created: false as const,
    deployment,
    ticket: {
      title: request.title,
      description: request.description,
      status: "new" as const,
      media: [] as const,
      origin: "staff" as const,
      createdVia: "codex" as const,
      requestId,
    },
  };
}

export function loginOutput(deployment: Deployment, session: { url: string; expiresAt: number }) {
  return {
    ok: true as const,
    authenticated: true as const,
    role: "staff" as const,
    deployment,
    url: session.url,
    expiresAt: session.expiresAt,
  };
}

export function whoamiOutput(deployment: Deployment, url: string, session: CurrentSession) {
  return {
    ok: true as const,
    authenticated: true as const,
    role: session.role,
    deployment,
    url,
    expiresAt: session.expiresAt,
  };
}

export function logoutOutput(deployment: Deployment, loggedOut: boolean) {
  return { ok: true as const, loggedOut, deployment };
}

export function errorOutput(error: TicketCliError, deployment?: Deployment, requestId?: string) {
  return {
    ok: false as const,
    code: error.code,
    message: error.message,
    ...(deployment ? { deployment } : {}),
    ...(requestId ? { requestId } : {}),
    ...(error.hint ? { hint: error.hint } : {}),
  };
}
