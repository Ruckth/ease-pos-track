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
import type { PageBundle } from "./pages";
import { pageFormData } from "../../shared/ticket-pages";
import { toStoredTicketStatus, type TicketStatus } from "./status";

export type TicketDocument = TicketDetail;

export type CurrentSession = {
  role: "staff" | "customer" | "pending";
  name: string | null;
  email: string | null;
};

/** A Convex Auth session: short-lived access JWT plus the rotating refresh token. */
export type SessionTokens = { accessToken: string; refreshToken: string; refreshTokenExpiresAt: number };

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

export type TicketPage = { pageId: string; url: string; entry: string; fileCount: number; totalBytes: number; publishedAt: number };
export type TicketPagePublishInput = { ticket: string; requestId: string; bundle: PageBundle };
export type TicketPagePublishResult = TicketPage & { created: boolean; requestId: string };

export interface TicketRemote {
  /** Named staff sign-in: Google start/complete through the same guarded adapter as the browser. */
  startGoogle(url: string, redirectTo: string): Promise<{ redirect: string; state: string }>;
  completeGoogle(url: string, code: string, state: string): Promise<SessionTokens | null>;
  /** Disposable local backend only (LOCAL_FIXTURES_ENABLED on a loopback deployment). */
  signInLocalFixture(url: string, email: string): Promise<SessionTokens | null>;
  /** Rotates the refresh token; null when the session no longer exists. */
  refresh(url: string, refreshToken: string): Promise<SessionTokens | null>;
  currentSession(url: string, token: string): Promise<CurrentSession | null>;
  logout(url: string, refreshToken: string): Promise<void>;
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
  publishPage(url: string, token: string, input: TicketPagePublishInput): Promise<TicketPagePublishResult>;
  listPages(url: string, token: string, id: TicketDocument["_id"]): Promise<TicketPage[]>;
  revokePage(url: string, token: string, pageId: string): Promise<boolean>;
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
  /** A fresh client per call: the access JWT travels only as its auth header. */
  private client(url: string, accessToken?: string) {
    const client = new ConvexHttpClient(url, { logger: false, skipConvexDeploymentUrlCheck: true });
    if (accessToken) client.setAuth(accessToken);
    return client;
  }

  async startGoogle(url: string, redirectTo: string) {
    return await this.client(url).mutation(api.auth.startSignInWithClerk, { redirectTo });
  }

  async completeGoogle(url: string, code: string, state: string) {
    const result = await this.client(url).mutation(api.auth.completeSignInWithClerk, { code, state });
    return result.status === "complete" ? result.tokens : null;
  }

  async signInLocalFixture(url: string, email: string) {
    const result = await this.client(url).mutation(api.auth.signInLocalFixture, { email });
    return result.status === "complete" ? result.tokens : null;
  }

  async refresh(url: string, refreshToken: string) {
    const result = await this.client(url).mutation(api.auth.refreshSession, { refreshToken });
    return result.kind === "rotated" ? result.tokens : null;
  }

  async currentSession(url: string, token: string): Promise<CurrentSession | null> {
    const viewer = await this.client(url, token).query(api.identity.viewer, {});
    if (!viewer) return null;
    if (viewer.kind === "staff") return { role: "staff", name: viewer.name, email: viewer.email };
    if (viewer.kind === "customer") return { role: "customer", name: viewer.displayName, email: null };
    return { role: "pending", name: viewer.name, email: viewer.email };
  }

  async logout(url: string, refreshToken: string) {
    await this.client(url).mutation(api.auth.signOut, { refreshToken });
  }

  async list(url: string, token: string, projectKey: string | undefined, includeArchived: boolean) {
    const client = this.client(url, token);
    const projects = await client.query(api.projects.listProjects, {});
    const scoped = projectKey === undefined ? projects : projects.filter(project => project.key === projectKey.trim().toUpperCase());
    if (projectKey !== undefined && scoped.length === 0) throw new ConvexError({ code: "PROJECT_NOT_FOUND" });
    const tickets: TicketDocument[] = [];
    for (const project of scoped) {
      for (const lifecycle of (includeArchived ? ["active", "archived"] : ["active"]) as Array<"active" | "archived">) {
        let cursor: string | null = null;
        for (;;) {
          const result: FunctionReturnType<typeof api.tickets.pageTicketDetails> = await client.query(api.tickets.pageTicketDetails, { projectId: project._id, lifecycle, paginationOpts: { numItems: 50, cursor } });
          tickets.push(...result.page);
          if (result.isDone) break;
          cursor = result.continueCursor;
        }
      }
    }
    return Array.from(new Map(tickets.map(ticket => [ticket._id, ticket])).values()).sort((a, b) => b._creationTime - a._creationTime);
  }

  async get(url: string, token: string, ref: TicketRef, includeArchived: boolean) {
    return await this.client(url, token).query(api.tickets.getTicketByTicketNumber, { projectKey: ref.projectKey,
      ticketNumber: ref.ticketNumber,
      includeDeleted: includeArchived,
    });
  }

  async create(url: string, token: string, input: TicketCreateInput) {
    return await this.client(url, token).mutation(api.tickets.createTextTicket, { title: input.title, description: input.description, requestId: input.requestId, projectKey: input.projectKey });
  }

  async createUploadIntent(url: string, token: string, input: { requestId: string; files: Array<{ name: string; size: number; type: string }> }) {
    return await this.client(url, token).mutation(api.uploads.createUploadIntent, { idempotencyKey: input.requestId,
      files: input.files,
    });
  }

  async recordUploadedFile(url: string, input: TicketUploadCredentials & { token: string; file: TicketMediaItem }) {
    const result = await this.client(url, input.token).mutation(api.uploads.recordUploadedFile, { intentId: input.intentId, secret: input.secret, file: input.file });
    if (result.state === "queued") throw new ConvexError({ code: "UPLOAD_INTENT_INVALID" });
  }

  async cancelUploadIntent(url: string, token: string, input: TicketUploadCredentials) {
    const result = await this.client(url, token).mutation(api.uploads.cancelUploadIntent, { intentId: input.intentId, secret: input.secret });
    if (result.state === "failed") throw new ConvexError({ code: "UPLOAD_CLEANUP_FAILED", jobIds: result.jobIds });
  }

  async attachImages(url: string, token: string, input: TicketAttachInput) {
    await this.client(url, token).mutation(api.tickets.attachTicketMedia, { id: input.id,
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
      await this.client(url, token).mutation(api.tickets.editTicket, { id: current._id,
        title: input.title ?? current.title,
        description: input.description ?? current.description,
        expectedVersion: input.expectedVersion,
      });
    });
  }

  async changeStatus(url: string, token: string, input: TicketStatusInput) {
    return await this.write(url, token, input.ref, WITHIN_ACTIVE, async (current) => {
      await this.client(url, token).mutation(api.tickets.updateTicketStatus, { id: current._id,
        status: toStoredTicketStatus(input.status),
        expectedVersion: input.expectedVersion,
      });
    });
  }

  async archive(url: string, token: string, ref: TicketRef, expectedVersion: number) {
    return await this.write(url, token, ref, ARCHIVING, async (current) => {
      await this.client(url, token).mutation(api.tickets.archiveTicket, { id: current._id, expectedVersion });
    });
  }

  async restore(url: string, token: string, ref: TicketRef, expectedVersion: number) {
    return await this.write(url, token, ref, RESTORING, async (current) => {
      await this.client(url, token).mutation(api.tickets.restoreTicket, { id: current._id, expectedVersion });
    });
  }

  /**
   * Publishes through the deployment's HTTP page route. The Convex site origin is
   * read from the deployment, so local and hosted backends need no extra setting.
   */
  async publishPage(url: string, token: string, input: TicketPagePublishInput) {
    const { siteUrl } = await this.client(url, token).query(api.pages.publishTarget, {});
    const form = pageFormData(input.bundle.entry, input.bundle.files.map(file => ({ path: file.path, blob: new Blob([file.bytes as BlobPart]) })));
    const response = await fetch(`${siteUrl}/v1/tickets/${encodeURIComponent(input.ticket)}/pages`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "X-Ticket-Image-Policy": "v1", "Idempotency-Key": input.requestId }, body: form,
    });
    const body = await response.json().catch(() => null) as ({ ok: true } & TicketPagePublishResult) | { ok: false; code?: string } | null;
    if (!response.ok || !body?.ok) throw new ConvexError({ code: body && !body.ok && body.code ? body.code : "PAGE_PUBLISH_UNKNOWN" });
    const { ok: _ok, ...page } = body;
    return page;
  }

  async listPages(url: string, token: string, id: TicketDocument["_id"]) {
    const pages = await this.client(url, token).query(api.pages.listTicketPages, { id });
    return pages.map(page => ({ pageId: page._id, url: page.url, entry: page.entryPath, fileCount: page.fileCount, totalBytes: page.totalBytes, publishedAt: page.publishedAt }));
  }

  async revokePage(url: string, token: string, pageId: string) {
    const result = await this.client(url, token).mutation(api.pages.revokeTicketPage, { pageId: pageId as Id<"ticketPages"> });
    return result.revoked;
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
