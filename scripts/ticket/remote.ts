/**
 * The boundary to the deployment. The CLI calls the same public Convex functions
 * the app calls; it adds no second authorization scheme and no second workflow.
 *
 * `TicketRemote` is the seam the orchestration layer depends on, so command
 * behavior can be tested without a deployment.
 */

import type { FunctionReturnType } from "convex/server";
import { ConvexHttpClient } from "convex/browser";
import { ConvexError } from "convex/values";
import { api } from "../../convex/_generated/api";
import type { TicketDetail } from "../../shared/ticket-contracts";
import type { Id } from "../../convex/_generated/dataModel";
import type { TicketRef } from "./cli";
import type { TicketMediaItem } from "./images";
import { toStoredTicketStatus, type TicketStatus } from "./status";

export type TicketDocument = TicketDetail;

export type CurrentSession = {
  role: "staff" | "customer";
  expiresAt: number;
  customerId: string | null;
  email: string | null;
};

type TicketCreateInput = { title: string; description: string; requestId: string; projectKey?: string };
type TicketCreateResult = { ticket: TicketDocument; created: boolean; requestId: string };
type TicketUpdateInput = { ref: TicketRef; title?: string; description?: string; expectedVersion: number };
type TicketStatusInput = { ref: TicketRef; status: TicketStatus; expectedVersion: number };
type TicketUploadIntent = {
  intentId: Id<"uploadIntents">;
  secret: string;
  ticketId?: Id<"tickets">;
  uploadedFiles: TicketMediaItem[];
};
type TicketUploadCredentials = Pick<TicketUploadIntent, "intentId" | "secret">;
export type TicketAttachInput = TicketUploadCredentials & {
  requestId: string;
  id: Id<"tickets">;
  expectedVersion: number;
  media: TicketMediaItem[];
};

export interface TicketRemote {
  login(url: string, password: string, clientId: string): Promise<{ token: string; expiresAt: number }>;
  currentSession(url: string, token: string): Promise<CurrentSession | null>;
  logout(url: string, token: string): Promise<void>;
  list(url: string, token: string, projectKey: string | undefined, includeArchived: boolean): Promise<TicketDocument[]>;
  get(url: string, token: string, ref: TicketRef, includeArchived: boolean): Promise<TicketDocument | null>;
  create(url: string, token: string, input: TicketCreateInput): Promise<TicketCreateResult>;
  createUploadIntent(url: string, token: string, input: { requestId: string; files: Array<{ name: string; size: number; type: string }> }): Promise<TicketUploadIntent>;
  recordUploadedFile(url: string, input: TicketUploadCredentials & { token: string; file: TicketMediaItem }): Promise<void>;
  cancelUploadIntent(url: string, token: string, input: TicketUploadCredentials): Promise<void>;
  attachImages(url: string, token: string, input: TicketAttachInput): Promise<void>;
  update(url: string, token: string, input: TicketUpdateInput): Promise<TicketDocument>;
  changeStatus(url: string, token: string, input: TicketStatusInput): Promise<TicketDocument>;
  archive(url: string, token: string, ref: TicketRef, expectedVersion: number): Promise<TicketDocument>;
  restore(url: string, token: string, ref: TicketRef, expectedVersion: number): Promise<TicketDocument>;
}

/**
 * Which reads a Ticket write may see: the state it is about to change, and the
 * state it produces. Archiving reads an active Ticket and returns an archived
 * one; restoring does the reverse.
 */
type ArchivedVisibility = { before: boolean; after: boolean };

const WITHIN_ACTIVE: ArchivedVisibility = { before: false, after: false };
const ARCHIVING: ArchivedVisibility = { before: false, after: true };
const RESTORING: ArchivedVisibility = { before: true, after: false };

export class ConvexTicketRemote implements TicketRemote {
  private readonly clients = new Map<string, ConvexHttpClient>();

  /** One client per deployment URL; `ConvexHttpClient` carries no session state. */
  private client(url: string) {
    const existing = this.clients.get(url);
    if (existing) return existing;
    const client = new ConvexHttpClient(url, { logger: false, skipConvexDeploymentUrlCheck: true });
    this.clients.set(url, client);
    return client;
  }

  async login(url: string, password: string, clientId: string) {
    return await this.client(url).mutation(api.auth.login, { password, clientId });
  }

  async currentSession(url: string, token: string) {
    return await this.client(url).query(api.auth.currentSession, { token });
  }

  async logout(url: string, token: string) {
    await this.client(url).mutation(api.auth.logout, { token });
  }

  async list(url: string, token: string, projectKey: string | undefined, includeArchived: boolean) {
    const client = this.client(url);
    const projects = await client.query(api.projects.listProjects, { token });
    const scoped = projectKey === undefined ? projects : projects.filter(project => project.key === projectKey.trim().toUpperCase());
    if (projectKey !== undefined && scoped.length === 0) throw new ConvexError({ code: "PROJECT_NOT_FOUND" });
    const tickets: TicketDocument[] = [];
    for (const project of scoped) {
      for (const lifecycle of (includeArchived ? ["active", "archived"] : ["active"]) as Array<"active" | "archived">) {
        let cursor: string | null = null;
        for (;;) {
          const result: FunctionReturnType<typeof api.tickets.pageTicketDetails> = await client.query(api.tickets.pageTicketDetails, { token, projectId: project._id, lifecycle, paginationOpts: { numItems: 50, cursor } });
          tickets.push(...result.page);
          if (result.isDone) break;
          cursor = result.continueCursor;
        }
      }
    }
    return Array.from(new Map(tickets.map(ticket => [ticket._id, ticket])).values()).sort((a, b) => b._creationTime - a._creationTime);
  }

  async get(url: string, token: string, ref: TicketRef, includeArchived: boolean) {
    return await this.client(url).query(api.tickets.getTicketByTicketNumber, {
      token,
      projectKey: ref.projectKey,
      ticketNumber: ref.ticketNumber,
      includeDeleted: includeArchived,
    });
  }

  async create(url: string, token: string, input: TicketCreateInput) {
    return await this.client(url).mutation(api.tickets.createTextTicket, { token, title: input.title, description: input.description, requestId: input.requestId, projectKey: input.projectKey });
  }

  async createUploadIntent(url: string, token: string, input: { requestId: string; files: Array<{ name: string; size: number; type: string }> }) {
    return await this.client(url).mutation(api.uploads.createUploadIntent, {
      token,
      idempotencyKey: input.requestId,
      files: input.files,
    });
  }

  async recordUploadedFile(url: string, input: TicketUploadCredentials & { token: string; file: TicketMediaItem }) {
    const result = await this.client(url).mutation(api.uploads.recordUploadedFile, { token: input.token, intentId: input.intentId, secret: input.secret, file: input.file });
    if (result.state === "queued") throw new ConvexError({ code: "UPLOAD_INTENT_INVALID" });
  }

  async cancelUploadIntent(url: string, token: string, input: TicketUploadCredentials) {
    const result = await this.client(url).mutation(api.uploads.cancelUploadIntent, { token, intentId: input.intentId, secret: input.secret });
    if (result.state === "failed") throw new ConvexError({ code: "UPLOAD_CLEANUP_FAILED", jobIds: result.jobIds });
  }

  async attachImages(url: string, token: string, input: TicketAttachInput) {
    await this.client(url).mutation(api.tickets.attachTicketMedia, {
      token,
      id: input.id,
      media: input.media,
      uploadIntentId: input.intentId,
      uploadIntentSecret: input.secret,
      expectedVersion: input.expectedVersion,
      requestId: input.requestId,
    });
  }

  async update(url: string, token: string, input: TicketUpdateInput) {
    // Omitted fields keep their stored value; the mutation replaces both.
    return await this.write(url, token, input.ref, WITHIN_ACTIVE, async (current) => {
      await this.client(url).mutation(api.tickets.editTicket, {
        token,
        id: current._id,
        title: input.title ?? current.title,
        description: input.description ?? current.description,
        expectedVersion: input.expectedVersion,
      });
    });
  }

  async changeStatus(url: string, token: string, input: TicketStatusInput) {
    return await this.write(url, token, input.ref, WITHIN_ACTIVE, async (current) => {
      await this.client(url).mutation(api.tickets.updateTicketStatus, {
        token,
        id: current._id,
        status: toStoredTicketStatus(input.status),
        expectedVersion: input.expectedVersion,
      });
    });
  }

  async archive(url: string, token: string, ref: TicketRef, expectedVersion: number) {
    return await this.write(url, token, ref, ARCHIVING, async (current) => {
      await this.client(url).mutation(api.tickets.archiveTicket, { token, id: current._id, expectedVersion });
    });
  }

  async restore(url: string, token: string, ref: TicketRef, expectedVersion: number) {
    return await this.write(url, token, ref, RESTORING, async (current) => {
      await this.client(url).mutation(api.tickets.restoreTicket, { token, id: current._id, expectedVersion });
    });
  }

  /**
   * Resolves the Ticket reference to the document id the mutations take, applies
   * the mutation, then reads the Ticket back so callers always report the state
   * the deployment now holds.
   */
  private async write(
    url: string,
    token: string,
    ref: TicketRef,
    archived: ArchivedVisibility,
    mutate: (current: TicketDocument) => Promise<void>,
  ) {
    const current = await this.requireTicket(url, token, ref, archived.before);
    await mutate(current);
    return await this.requireTicket(url, token, ref, archived.after);
  }

  /** Reports the domain's own not-found code so the CLI classifies it once. */
  private async requireTicket(url: string, token: string, ref: TicketRef, includeArchived: boolean) {
    const ticket = await this.get(url, token, ref, includeArchived);
    if (!ticket) throw new Error("TICKET_UNAVAILABLE");
    return ticket;
  }
}
