/**
 * Hosted Ticket pages: reservation, staging, atomic publication, revocation and
 * reclaim. HTTP routes stage bytes in Convex File Storage; this module owns every
 * row transition and checks Ticket write access, Project access and lifecycle on
 * reservation and again on commit.
 */
import { v } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { actorFields, assertCanWriteTicket, type Actor } from "../authz";
import { normalizeRequestId } from "../ticket_requests";
import { formatTicketNumber, parseTicketReference } from "../../shared/ticket-numbers";
import { PAGE_LIMITS, pageContentType, pageFingerprintInput, pageUrl, sha256Hex, validatePageBundle,
  type PageManifestEntry } from "../../shared/ticket-pages";
import { mutationOperation, queryOperation } from "./operation";
import { readableTicket, requireWritableTicket } from "./operations";
import { requireUsableProject } from "./projects";

export const STAGING_TTL_MS = 15 * 60 * 1000;
export const PAGE_SWEEP_LIMIT = 10;

type Ctx = QueryCtx | MutationCtx;
type AnyActor = Actor<Id<"customers">>;

const manifestValidator = v.array(v.object({ path: v.string(), size: v.number(), sha256: v.string() }));

export function siteUrl() {
  const url = process.env.CONVEX_SITE_URL;
  if (!url) throw new Error("PAGE_HOST_NOT_CONFIGURED");
  return url.replace(/\/+$/, "");
}

function publicPage(ticket: Doc<"tickets"> | null, row: Doc<"ticketPages">) {
  return {
    _id: row._id,
    url: pageUrl(siteUrl(), row.shareKey!, row.entryPath),
    entryPath: row.entryPath,
    fileCount: row.files.length,
    totalBytes: row.totalBytes,
    publishedAt: row.publishedAt ?? row.createdAt,
    ...(ticket ? { ticket: formatTicketNumber(ticket.ticketNumber, ticket.projectKey) } : {}),
  };
}

function makeShareKey() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sameActor(row: Doc<"ticketPages">, actor: AnyActor) {
  return row.actorRole === actor.role && row.actorCustomerId === actor.customerId;
}

async function ticketByReference(ctx: Ctx, reference: string) {
  const ref = parseTicketReference(reference);
  if (!ref) throw new Error("TICKET_UNAVAILABLE");
  const doc = await ctx.db.query("tickets").withIndex("by_project_ticket", q =>
    q.eq("projectKey", ref.projectKey).eq("ticketNumber", ref.ticketNumber)).unique();
  if (!doc) throw new Error("TICKET_UNAVAILABLE");
  return doc;
}

/** Current Ticket write access, active lifecycle and Project access. */
async function requirePublishableTicket(ctx: MutationCtx, actor: AnyActor, id: Id<"tickets">) {
  const doc = await requireWritableTicket(ctx, actor, id);
  await requireUsableProject(ctx, actor, doc.projectId);
  return doc;
}

function stagedView(row: Doc<"ticketPages">) {
  return row.files.map(file => ({ path: file.path, sha256: file.sha256 }));
}

export const reservePage = mutationOperation({
  args: { token: v.string(), ticket: v.string(), requestId: v.string(), entry: v.string(), manifest: manifestValidator },
  handler: async (ctx, args) => {
    const { actor, session } = ctx;
    const requestId = normalizeRequestId(args.requestId);
    const located = await ticketByReference(ctx, args.ticket);
    const ticket = await requirePublishableTicket(ctx, actor, located._id);
    const bundle = validatePageBundle(args.entry, args.manifest);
    if (bundle.files.some(file => !/^[0-9a-f]{64}$/.test(file.sha256))) throw new Error("PAGE_FILE_INVALID");
    const manifest: PageManifestEntry[] = bundle.files.map(({ path, size, sha256 }) => ({ path, size, sha256 }));
    const inputDigest = await sha256Hex(new TextEncoder().encode(pageFingerprintInput({ ticketId: ticket._id, entry: bundle.entry, files: manifest })));
    const now = Date.now();
    const existing = await ctx.db.query("ticketPages").withIndex("by_request", q => q.eq("requestId", requestId)).unique();
    if (existing) {
      // No content comparison or result is exposed to another actor.
      if (!sameActor(existing, actor)) throw new Error("TICKET_UNAVAILABLE");
      if (existing.ticketId !== ticket._id || existing.inputDigest !== inputDigest) throw new Error("PAGE_REQUEST_CONFLICT");
      if (existing.state === "published") return { state: "published" as const, pageId: existing._id, page: publicPage(ticket, existing) };
      if (existing.state === "revoked") throw new Error("PAGE_REVOKED");
      // Retry of an interrupted or abandoned upload: keep recorded blobs, extend staging.
      await ctx.db.patch(existing._id, { state: "staging", sessionId: session._id, expiresAt: now + STAGING_TTL_MS,
        reclaimAfter: existing.discarded.length ? existing.reclaimAfter ?? now : undefined, updatedAt: now });
      return { state: "staging" as const, pageId: existing._id, staged: stagedView(existing) };
    }
    const published = await ctx.db.query("ticketPages").withIndex("by_ticket", q => q.eq("ticketId", ticket._id).eq("state", "published")).take(PAGE_LIMITS.maxPagesPerTicket);
    const staging = await ctx.db.query("ticketPages").withIndex("by_ticket", q => q.eq("ticketId", ticket._id).eq("state", "staging")).take(PAGE_LIMITS.maxPagesPerTicket);
    if (published.length + staging.length >= PAGE_LIMITS.maxPagesPerTicket) throw new Error("PAGE_LIMIT_REACHED");
    const pageId = await ctx.db.insert("ticketPages", {
      ticketId: ticket._id, projectId: ticket.projectId, requestId, ...actorFields(actor), sessionId: session._id,
      inputDigest, entryPath: bundle.entry, manifest, files: [], discarded: [], totalBytes: bundle.totalBytes,
      state: "staging", expiresAt: now + STAGING_TTL_MS, createdAt: now, updatedAt: now,
    });
    return { state: "staging" as const, pageId, staged: [] };
  },
});

/**
 * Records one stored blob against its reservation. Ownership is always
 * recorded, even when the blob can no longer be used, so only the gated reclaim
 * sweep ever deletes page storage.
 */
export async function recordStagedFile(ctx: MutationCtx, args: { pageId: Id<"ticketPages">; path: string; sha256: string; size: number; storageId: Id<"_storage"> }) {
  const row = await ctx.db.get(args.pageId);
  if (!row) throw new Error("PAGE_UNAVAILABLE");
  const now = Date.now();
  const expected = row.manifest.find(file => file.path === args.path);
  const usable = row.state === "staging" && expected && expected.sha256 === args.sha256 && expected.size === args.size
    && !row.files.some(file => file.path === args.path);
  if (!usable) {
    await ctx.db.patch(row._id, { discarded: [...row.discarded, args.storageId], reclaimAfter: row.reclaimAfter ?? now, updatedAt: now });
    return false;
  }
  await ctx.db.patch(row._id, { files: [...row.files, { path: args.path, sha256: args.sha256, size: args.size,
    contentType: pageContentType(args.path)!, storageId: args.storageId }], updatedAt: now });
  return true;
}

export const commitPage = mutationOperation({
  args: { token: v.string(), pageId: v.id("ticketPages") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.pageId);
    if (!row || !sameActor(row, ctx.actor)) throw new Error("TICKET_UNAVAILABLE");
    const ticket = await requirePublishableTicket(ctx, ctx.actor, row.ticketId);
    if (row.state === "published") return publicPage(ticket, row);
    if (row.state !== "staging") throw new Error(row.state === "revoked" ? "PAGE_REVOKED" : "PAGE_UPLOAD_EXPIRED");
    const complete = row.files.length === row.manifest.length && row.manifest.every(expected =>
      row.files.some(file => file.path === expected.path && file.sha256 === expected.sha256 && file.size === expected.size));
    if (!complete) throw new Error("PAGE_UPLOAD_INCOMPLETE");
    const now = Date.now();
    const shareKey = makeShareKey();
    await ctx.db.patch(row._id, { state: "published", shareKey, publishedAt: now, updatedAt: now });
    return publicPage(ticket, { ...row, shareKey, publishedAt: now });
  },
});

/** A definitive rejection ends staging; the gated sweep reclaims recorded blobs. */
export async function abandonPage(ctx: MutationCtx, pageId: Id<"ticketPages">) {
  const row = await ctx.db.get(pageId);
  if (!row || row.state !== "staging") return false;
  const now = Date.now();
  await ctx.db.patch(row._id, { state: "abandoned", reclaimAfter: row.reclaimAfter ?? now, updatedAt: now });
  return true;
}

export const listTicketPages = queryOperation({
  args: { token: v.string(), id: v.id("tickets") },
  handler: async (ctx, args) => {
    const ticket = await readableTicket(ctx, ctx.actor, args.id);
    if (!ticket) return [];
    const rows = await ctx.db.query("ticketPages").withIndex("by_ticket", q => q.eq("ticketId", ticket._id).eq("state", "published"))
      .order("desc").take(PAGE_LIMITS.maxPagesPerTicket);
    return rows.map(row => publicPage(null, row));
  },
});

export const revokeTicketPage = mutationOperation({
  args: { token: v.string(), pageId: v.id("ticketPages") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.pageId);
    const ticket = row ? await readableTicket(ctx, ctx.actor, row.ticketId) : null;
    if (!row || !ticket) throw new Error("PAGE_UNAVAILABLE");
    assertCanWriteTicket(ctx.actor, ticket);
    if (row.state === "revoked") return { revoked: false };
    if (row.state !== "published") throw new Error("PAGE_UNAVAILABLE");
    const now = Date.now();
    await ctx.db.patch(row._id, { state: "revoked", revokedAt: now, reclaimAfter: row.reclaimAfter ?? now, updatedAt: now });
    return { revoked: true };
  },
});

/** Every HTML and asset read rechecks publication, revocation and Ticket lifecycle. */
export async function resolveServedFile(ctx: QueryCtx, shareKey: string, path: string | undefined) {
  const row = await ctx.db.query("ticketPages").withIndex("by_share_key", q => q.eq("shareKey", shareKey)).unique();
  if (!row || row.state !== "published") return null;
  const ticket = await ctx.db.get(row.ticketId);
  if (!ticket || ticket.lifecycle !== "active") return null;
  if (path === undefined) return { redirect: row.entryPath };
  const file = row.files.find(item => item.path === path);
  return file ? { storageId: file.storageId, contentType: file.contentType } : null;
}

/** Expiry only records the reservation as abandoned; it never deletes bytes. */
export async function expireStagingPages(ctx: MutationCtx) {
  const now = Date.now();
  const rows = await ctx.db.query("ticketPages").withIndex("by_state_expires", q => q.eq("state", "staging").lte("expiresAt", now)).take(PAGE_SWEEP_LIMIT * 2);
  for (const row of rows) await ctx.db.patch(row._id, { state: "abandoned", reclaimAfter: row.reclaimAfter ?? now, updatedAt: now });
  return rows.length;
}

/**
 * Deletes only blobs recorded on a page row, behind MEDIA_CLEANUP_ENABLED.
 * Published and staging rows lose only their discarded duplicates.
 */
export async function reclaimPageStorage(ctx: MutationCtx) {
  if (process.env.MEDIA_CLEANUP_ENABLED !== "true") return 0;
  const now = Date.now();
  const rows = await ctx.db.query("ticketPages").withIndex("by_reclaim", q => q.gte("reclaimAfter", 0).lte("reclaimAfter", now)).take(PAGE_SWEEP_LIMIT);
  for (const row of rows) {
    const terminal = row.state === "revoked" || row.state === "abandoned";
    for (const storageId of [...row.discarded, ...(terminal ? row.files.map(file => file.storageId) : [])]) {
      if (await ctx.db.system.get(storageId)) await ctx.storage.delete(storageId);
    }
    await ctx.db.patch(row._id, { discarded: [], ...(terminal ? { files: [] } : {}), reclaimAfter: undefined, updatedAt: now });
  }
  return rows.length;
}

/**
 * Ticket purge retires its pages in bounded batches before audit removal ends.
 * Returns true once no published or staging page remains.
 */
export async function retireTicketPages(ctx: MutationCtx, ticketId: Id<"tickets">) {
  const now = Date.now();
  let remaining = false;
  for (const state of ["published", "staging"] as const) {
    const rows = await ctx.db.query("ticketPages").withIndex("by_ticket", q => q.eq("ticketId", ticketId).eq("state", state)).take(PAGE_SWEEP_LIMIT * 5);
    if (rows.length === PAGE_SWEEP_LIMIT * 5) remaining = true;
    for (const row of rows) {
      await ctx.db.patch(row._id, { state: state === "published" ? "revoked" : "abandoned",
        ...(state === "published" ? { revokedAt: now } : {}), reclaimAfter: row.reclaimAfter ?? now, updatedAt: now });
    }
  }
  return !remaining;
}
