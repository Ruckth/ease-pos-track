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
/**
 * A write claimed now can only land in storage while the publishing action runs
 * (Convex actions stop after 10 minutes), so its blob is created inside this window.
 */
export const PAGE_WRITE_WINDOW_MS = 11 * 60 * 1000;
/** Storage rows read per reconciliation pass; later passes resume from `scannedTo`. */
export const PAGE_WRITE_SCAN = 100;
/** Recent storage commits may still be settling; missing-blob conclusions wait this long. */
const WRITE_SETTLE_MS = 5_000;
const MAX_OPEN_WRITES = PAGE_LIMITS.maxFiles * 2;

type Ctx = QueryCtx | MutationCtx;
type AnyActor = Actor<Id<"customers">>;

const manifestValidator = v.array(v.object({ path: v.string(), size: v.number(), sha256: v.string(), rasterType: v.optional(v.string()) }));

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

/** Private per-write marker carried in the stored blob's content type. Never served. */
export function pageWriteType(marker: string) {
  return `application/vnd.ticket-page-write; write=${marker}`;
}

function hexToBase64(hex: string) {
  let binary = "";
  for (let index = 0; index < hex.length; index += 2) binary += String.fromCharCode(parseInt(hex.slice(index, index + 2), 16));
  return btoa(binary);
}

/** Lowercase hex: Blob types are lowercased, so the marker must survive that. */
function makeWriteMarker() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
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

type PageWrite = NonNullable<Doc<"ticketPages">["writes"]>[number];

/**
 * Claims one write per manifest file not yet recorded. The claim is durable
 * before any byte is stored, so an interrupted upload stays attributable.
 */
async function claimWrites(ctx: MutationCtx, row: Doc<"ticketPages">, now: number) {
  const open = row.writes ?? [];
  const missing = row.manifest.filter(entry => !row.files.some(file => file.path === entry.path));
  if (open.length + missing.length > MAX_OPEN_WRITES) throw new Error("PAGE_UPLOAD_BUSY");
  const claimed: PageWrite[] = missing.map(({path, size, sha256}) => ({ path, size, sha256, marker: makeWriteMarker(), claimedAt: now, scannedTo: now - 1_000 }));
  await ctx.db.patch(row._id, { writes: [...open, ...claimed], writeCheckAt: row.writeCheckAt ?? now + PAGE_WRITE_WINDOW_MS });
  return claimed.map(write => ({ path: write.path, marker: write.marker, contentType: pageWriteType(write.marker) }));
}

/**
 * Resolves unrecorded writes from storage metadata. A blob is attributed only by
 * its exact private marker; size and hash must also match before it is adopted.
 * Found blobs are adopted while staging or else recorded as discarded for the
 * gated reclaim. A write is dropped as never stored only after its whole window
 * has been scanned. Reads at most PAGE_WRITE_SCAN storage rows per pass.
 */
export async function reconcilePageWrites(ctx: MutationCtx, pageId: Id<"ticketPages">) {
  const row = await ctx.db.get(pageId);
  const writes = row?.writes ?? [];
  if (!row || writes.length === 0) return row;
  const now = Date.now();
  const settled = now - WRITE_SETTLE_MS;
  const from = Math.min(...writes.map(write => write.scannedTo));
  const until = Math.min(now, Math.max(...writes.map(write => write.claimedAt + PAGE_WRITE_WINDOW_MS)));
  const blobs = await ctx.db.system.query("_storage")
    .withIndex("by_creation_time", q => q.gt("_creationTime", from).lte("_creationTime", until)).take(PAGE_WRITE_SCAN);
  const complete = blobs.length < PAGE_WRITE_SCAN;
  const reached = complete ? Math.min(until, settled) : blobs[blobs.length - 1]._creationTime;
  const byType = new Map(blobs.flatMap(blob => blob.contentType ? [[blob.contentType, blob] as const] : []));
  const files = [...row.files];
  const discarded = [...row.discarded];
  const remaining: PageWrite[] = [];
  for (const write of writes) {
    const blob = byType.get(pageWriteType(write.marker));
    const windowEnd = write.claimedAt + PAGE_WRITE_WINDOW_MS;
    if (!blob) {
      if (reached < windowEnd) remaining.push({ ...write, scannedTo: Math.max(write.scannedTo, reached) });
      continue;
    }
    if (files.some(file => file.storageId === blob._id) || discarded.includes(blob._id)) continue;
    const expected = row.manifest.find(entry => entry.path === write.path);
    const usable = row.state === "staging" && expected?.sha256 === write.sha256 && expected.size === write.size
      && blob.size === write.size && blob.sha256 === hexToBase64(write.sha256) && !files.some(file => file.path === write.path);
    if (usable) files.push({ path: write.path, sha256: write.sha256, size: write.size, contentType: expected?.rasterType ?? pageContentType(write.path)!, storageId: blob._id });
    else discarded.push(blob._id);
  }
  await ctx.db.patch(row._id, {
    files, discarded, writes: remaining, writeCheckAt: remaining.length ? now + 60_000 : undefined, updatedAt: now,
    ...(discarded.length > row.discarded.length ? { reclaimAfter: row.reclaimAfter ?? now } : {}),
  });
  return (await ctx.db.get(row._id))!;
}

/** Due rows only: the normal path clears its claims when recording. */
export async function reconcileDuePageWrites(ctx: MutationCtx) {
  const rows = await ctx.db.query("ticketPages").withIndex("by_write_check", q => q.gte("writeCheckAt", 0).lte("writeCheckAt", Date.now())).take(PAGE_SWEEP_LIMIT);
  for (const row of rows) await reconcilePageWrites(ctx, row._id);
  return rows.length;
}

function stagedView(row: Doc<"ticketPages">) {
  return row.files.map(file => ({ path: file.path, sha256: file.sha256 }));
}

/** Runs before the HTTP route reads or hashes any request body. */
export const authorizePublish = mutationOperation({
  args: { token: v.string(), ticket: v.string(), requestId: v.string() },
  handler: async (ctx, args) => {
    const ticket = await ticketByReference(ctx, args.ticket);
    await requirePublishableTicket(ctx, ctx.actor, ticket._id);
    const requestId=normalizeRequestId(args.requestId);
    const row=await ctx.db.query("ticketPages").withIndex("by_request",q=>q.eq("requestId",requestId)).unique();
    if (row && !sameActor(row,ctx.actor)) throw new Error("TICKET_UNAVAILABLE");
    return { ticketId:ticket._id, digest:row?.inputDigest, published:row?.state==="published" ? publicPage(ticket,row) : null };
  },
});

export const reservePage = mutationOperation({
  args: { token: v.string(), ticket: v.string(), requestId: v.string(), entry: v.string(), manifest: manifestValidator, sourceDigest:v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { actor, session } = ctx;
    const requestId = normalizeRequestId(args.requestId);
    const located = await ticketByReference(ctx, args.ticket);
    const ticket = await requirePublishableTicket(ctx, actor, located._id);
    const bundle = validatePageBundle(args.entry, args.manifest);
    if (bundle.files.some(file => !/^[0-9a-f]{64}$/.test(file.sha256))) throw new Error("PAGE_FILE_INVALID");
    const manifest: PageManifestEntry[] = bundle.files.map(({ path, size, sha256, rasterType }) => ({ path, size, sha256, rasterType }));
    const inputDigest = args.sourceDigest ?? await sha256Hex(new TextEncoder().encode(pageFingerprintInput({ ticketId: ticket._id, entry: bundle.entry, files: manifest })));
    const now = Date.now();
    const existing = await ctx.db.query("ticketPages").withIndex("by_request", q => q.eq("requestId", requestId)).unique();
    if (existing) {
      // No content comparison or result is exposed to another actor.
      if (!sameActor(existing, actor)) throw new Error("TICKET_UNAVAILABLE");
      if (existing.ticketId !== ticket._id || existing.inputDigest !== inputDigest) throw new Error("PAGE_REQUEST_CONFLICT");
      if (existing.state === "published") return { state: "published" as const, pageId: existing._id, page: publicPage(ticket, existing) };
      if (existing.state === "revoked") throw new Error("PAGE_REVOKED");
      // Retry of an interrupted or abandoned upload: keep recorded blobs, extend staging,
      // then adopt any blob an interrupted run stored but never recorded.
      await ctx.db.patch(existing._id, { state: "staging", sessionId: session._id, expiresAt: now + STAGING_TTL_MS,
        reclaimAfter: existing.discarded.length ? existing.reclaimAfter ?? now : undefined, updatedAt: now });
      const current = (await reconcilePageWrites(ctx, existing._id))!;
      return { state: "staging" as const, pageId: existing._id, staged: stagedView(current), writes: await claimWrites(ctx, current, now) };
    }
    const published = await ctx.db.query("ticketPages").withIndex("by_ticket", q => q.eq("ticketId", ticket._id).eq("state", "published")).take(PAGE_LIMITS.maxPagesPerTicket);
    const staging = await ctx.db.query("ticketPages").withIndex("by_ticket", q => q.eq("ticketId", ticket._id).eq("state", "staging")).take(PAGE_LIMITS.maxPagesPerTicket);
    if (published.length + staging.length >= PAGE_LIMITS.maxPagesPerTicket) throw new Error("PAGE_LIMIT_REACHED");
    const pageId = await ctx.db.insert("ticketPages", {
      ticketId: ticket._id, projectId: ticket.projectId, requestId, ...actorFields(actor), sessionId: session._id,
      inputDigest, entryPath: bundle.entry, manifest, files: [], discarded: [], totalBytes: bundle.totalBytes,
      state: "staging", expiresAt: now + STAGING_TTL_MS, createdAt: now, updatedAt: now,
    });
    return { state: "staging" as const, pageId, staged: [], writes: await claimWrites(ctx, (await ctx.db.get(pageId))!, now) };
  },
});

/**
 * Records one stored blob against its reservation. Ownership is always
 * recorded, even when the blob can no longer be used, so only the gated reclaim
 * sweep ever deletes page storage.
 */
export async function recordStagedFile(ctx: MutationCtx, args: { pageId: Id<"ticketPages">; marker: string; path: string; sha256: string; size: number; storageId: Id<"_storage"> }) {
  const row = await ctx.db.get(args.pageId);
  if (!row) throw new Error("PAGE_UNAVAILABLE");
  // Reconciliation may already have recorded this exact blob.
  if (row.files.some(file => file.storageId === args.storageId) || row.discarded.includes(args.storageId)) return false;
  const now = Date.now();
  const writes = (row.writes ?? []).filter(write => write.marker !== args.marker);
  const claimed = writes.length < (row.writes ?? []).length;
  const claim = { writes, writeCheckAt: writes.length ? row.writeCheckAt : undefined };
  const expected = row.manifest.find(file => file.path === args.path);
  const usable = claimed && row.state === "staging" && expected && expected.sha256 === args.sha256 && expected.size === args.size
    && !row.files.some(file => file.path === args.path);
  if (!usable) {
    await ctx.db.patch(row._id, { ...claim, discarded: [...row.discarded, args.storageId], reclaimAfter: row.reclaimAfter ?? now, updatedAt: now });
    return false;
  }
  await ctx.db.patch(row._id, { ...claim, files: [...row.files, { path: args.path, sha256: args.sha256, size: args.size,
    contentType: expected.rasterType ?? pageContentType(args.path)!, storageId: args.storageId }], updatedAt: now });
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
  return file ? { storageId: file.storageId, contentType: file.contentType, sha256: file.sha256 } : null;
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
 * Published and staging rows lose only their discarded duplicates. Unresolved
 * writes stay on the row until reconciliation records or drops them.
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
