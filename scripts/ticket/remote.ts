/**
 * The boundary to the deployment. The CLI calls the same public Convex functions
 * the app calls; it adds no second authorization scheme and no second workflow.
 *
 * `TicketRemote` is the seam the orchestration layer depends on, so command
 * behavior can be tested without a deployment.
 */

import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import type { Id } from "../../convex/_generated/dataModel";
import type { TicketMediaItem } from "./images";
import { toStoredTicketStatus, type TicketStatus } from "./status";

export type TicketDocument = Doc<"feedback">;

export type CurrentSession = {
  role: "staff" | "customer";
  expiresAt: number;
  customerId: string | null;
  email: string | null;
};

export type TicketCreateInput = { title: string; description: string; requestId: string };
export type TicketCreateResult = { ticket: TicketDocument; created: boolean; requestId: string };
export type TicketUpdateInput = { ticketNumber: number; title?: string; description?: string; expectedVersion: number };
export type TicketStatusInput = { ticketNumber: number; status: TicketStatus; expectedVersion: number };
export type TicketUploadIntent = {
  intentId: Id<"uploadIntents">;
  secret: string;
  feedbackId?: Id<"feedback">;
  uploadedFiles: TicketMediaItem[];
};
export type TicketUploadCredentials = Pick<TicketUploadIntent, "intentId" | "secret">;
export type TicketAttachInput = TicketUploadCredentials & {
  ticketNumber: number;
  expectedVersion: number;
  media: TicketMediaItem[];
};

export interface TicketRemote {
  login(url: string, password: string, clientId: string): Promise<{ token: string; expiresAt: number }>;
  currentSession(url: string, token: string): Promise<CurrentSession | null>;
  logout(url: string, token: string): Promise<void>;
  list(url: string, token: string, includeArchived: boolean): Promise<TicketDocument[]>;
  get(url: string, token: string, ticketNumber: number, includeArchived: boolean): Promise<TicketDocument | null>;
  create(url: string, token: string, input: TicketCreateInput): Promise<TicketCreateResult>;
  createUploadIntent(url: string, token: string, input: { requestId: string; files: Array<{ name: string; size: number; type: string }> }): Promise<TicketUploadIntent>;
  recordUploadedFile(url: string, input: TicketUploadCredentials & { file: TicketMediaItem }): Promise<void>;
  attachImages(url: string, token: string, input: TicketAttachInput): Promise<TicketDocument>;
  update(url: string, token: string, input: TicketUpdateInput): Promise<TicketDocument>;
  changeStatus(url: string, token: string, input: TicketStatusInput): Promise<TicketDocument>;
  archive(url: string, token: string, ticketNumber: number, expectedVersion: number): Promise<TicketDocument>;
  restore(url: string, token: string, ticketNumber: number, expectedVersion: number): Promise<TicketDocument>;
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

  async list(url: string, token: string, includeArchived: boolean) {
    await this.ensureNumbering(url, token);
    return await this.client(url).query(api.feedback.listFeedback, { token, includeDeleted: includeArchived });
  }

  async get(url: string, token: string, ticketNumber: number, includeArchived: boolean) {
    await this.ensureNumbering(url, token);
    return await this.client(url).query(api.feedback.getFeedbackByTicketNumber, {
      token,
      ticketNumber,
      includeDeleted: includeArchived,
    });
  }

  async create(url: string, token: string, input: TicketCreateInput) {
    return await this.client(url).mutation(api.feedback.createTextFeedback, { token, ...input });
  }

  async createUploadIntent(url: string, token: string, input: { requestId: string; files: Array<{ name: string; size: number; type: string }> }) {
    return await this.client(url).mutation(api.uploads.createUploadIntent, {
      token,
      idempotencyKey: input.requestId,
      files: input.files,
    });
  }

  async recordUploadedFile(url: string, input: TicketUploadCredentials & { file: TicketMediaItem }) {
    await this.client(url).mutation(api.uploads.recordUploadedFile, input);
  }

  async attachImages(url: string, token: string, input: TicketAttachInput) {
    return await this.write(url, token, input.ticketNumber, WITHIN_ACTIVE, async (current) => {
      await this.client(url).mutation(api.feedback.attachFeedbackMedia, {
        token,
        id: current._id,
        media: input.media,
        uploadIntentId: input.intentId,
        uploadIntentSecret: input.secret,
        expectedVersion: input.expectedVersion,
      });
    });
  }

  async update(url: string, token: string, input: TicketUpdateInput) {
    // Omitted fields keep their stored value; the mutation replaces both.
    return await this.write(url, token, input.ticketNumber, WITHIN_ACTIVE, async (current) => {
      await this.client(url).mutation(api.feedback.editFeedback, {
        token,
        id: current._id,
        title: input.title ?? current.title,
        description: input.description ?? current.description,
        expectedVersion: input.expectedVersion,
      });
    });
  }

  async changeStatus(url: string, token: string, input: TicketStatusInput) {
    return await this.write(url, token, input.ticketNumber, WITHIN_ACTIVE, async (current) => {
      await this.client(url).mutation(api.feedback.updateFeedbackStatus, {
        token,
        id: current._id,
        status: toStoredTicketStatus(input.status),
        expectedVersion: input.expectedVersion,
      });
    });
  }

  async archive(url: string, token: string, ticketNumber: number, expectedVersion: number) {
    return await this.write(url, token, ticketNumber, ARCHIVING, async (current) => {
      await this.client(url).mutation(api.feedback.archiveFeedback, { token, id: current._id, expectedVersion });
    });
  }

  async restore(url: string, token: string, ticketNumber: number, expectedVersion: number) {
    return await this.write(url, token, ticketNumber, RESTORING, async (current) => {
      await this.client(url).mutation(api.feedback.restoreFeedback, { token, id: current._id, expectedVersion });
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
    ticketNumber: number,
    archived: ArchivedVisibility,
    mutate: (current: TicketDocument) => Promise<void>,
  ) {
    const current = await this.requireTicket(url, token, ticketNumber, archived.before);
    await mutate(current);
    return await this.requireTicket(url, token, ticketNumber, archived.after);
  }

  /** Reports the domain's own not-found code so the CLI classifies it once. */
  private async requireTicket(url: string, token: string, ticketNumber: number, includeArchived: boolean) {
    const ticket = await this.get(url, token, ticketNumber, includeArchived);
    if (!ticket) throw new Error("FEEDBACK_NOT_FOUND");
    return ticket;
  }

  private async ensureNumbering(url: string, token: string) {
    await this.client(url).mutation(api.feedback.ensureTicketNumbers, { token });
  }
}
