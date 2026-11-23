/**
 * HTTP edges for hosted Ticket pages. Publishing reserves, stages and commits
 * through internal mutations; serving resolves every request against the
 * committed row before reading bytes. Neither route writes the database itself.
 */
import { ConvexError } from "convex/values";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { errorCode } from "../shared/errors";
import { PAGE_LIMITS, pageSecurityHeaders, parseServedPath, sha256Hex, validatePageBundle, encodePagePath } from "../shared/ticket-pages";

const STATUS: Record<string, number> = {
  AUTH_REQUIRED: 401, SESSION_EXPIRED: 401, ORIGIN_NOT_ALLOWED: 403,
  TICKET_UNAVAILABLE: 404, PROJECT_NOT_FOUND: 404,
  PAGE_REQUEST_CONFLICT: 409, PAGE_REVOKED: 409, PAGE_LIMIT_REACHED: 409,
  PAGE_UPLOAD_EXPIRED: 409, PAGE_UPLOAD_INCOMPLETE: 409, PAGE_UPLOAD_BUSY: 409,
  PAGE_TOO_LARGE: 413, PAGE_HOST_NOT_CONFIGURED: 500, PAGE_PUBLISH_UNKNOWN: 503,
};

/** Outcomes a client resolves by retrying with the same Idempotency-Key. */
const RETRYABLE = new Set(["PAGE_PUBLISH_UNKNOWN", "PAGE_UPLOAD_INCOMPLETE", "PAGE_UPLOAD_EXPIRED", "PAGE_UPLOAD_BUSY"]);

/** Exact browser origins allowed to publish, from TICKET_APP_ORIGINS. */
function allowedOrigins() {
  return (process.env.TICKET_APP_ORIGINS ?? "").split(",").map(origin => origin.trim().replace(/\/+$/, "")).filter(Boolean);
}

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  return origin && allowedOrigins().includes(origin) ? {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type, idempotency-key",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  } : { Vary: "Origin" };
}

function json(request: Request, status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    ...corsHeaders(request),
  } });
}

function failure(request: Request, code: string) {
  const status = STATUS[code] ?? (code.startsWith("PAGE_") || code.endsWith("REQUEST_ID") || code === "REQUEST_ID_TOO_LONG" || code === "INVALID_INPUT" ? 400 : 500);
  const retryable = RETRYABLE.has(code);
  const response = json(request, status, { ok: false, code, ...(retryable ? { retryable } : {}) });
  if (status === 503) response.headers.set("Retry-After", "2");
  return response;
}

class PublishError extends Error {}
const reject = (code: string) => new PublishError(code);

/** Browser writes come only from the Ticket app; non-browser clients send no Origin. */
function originAllowed(request: Request) {
  const origin = request.headers.get("origin");
  return origin === null || allowedOrigins().includes(origin);
}

export async function publishPreflight(_ctx: ActionCtx, request: Request) {
  if (!originAllowed(request) || request.headers.get("origin") === null) return new Response(null, { status: 403, headers: { Vary: "Origin" } });
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

async function boundedBody(request: Request) {
  const declared = Number(request.headers.get("content-length") ?? NaN);
  if (declared > PAGE_LIMITS.maxRequestBytes) throw reject("PAGE_TOO_LARGE");
  if (!request.body) throw reject("PAGE_FILES_REQUIRED");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > PAGE_LIMITS.maxRequestBytes) { await reader.cancel(); throw reject("PAGE_TOO_LARGE"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** Parses `entry`, `manifest` and exactly the file parts the manifest names. */
async function readBundle(request: Request) {
  const type = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data;/i.test(type)) throw reject("PAGE_FORM_INVALID");
  const body = await boundedBody(request);
  let form: FormData;
  try { form = await new Response(body, { headers: { "content-type": type } }).formData(); }
  catch { throw reject("PAGE_FORM_INVALID"); }
  // Every field appears once: a repeated part could otherwise smuggle unhashed bytes.
  const keys: string[] = [];
  form.forEach((_value, key) => { keys.push(key); });
  if (keys.length > PAGE_LIMITS.maxFiles + 2 || new Set(keys).size !== keys.length) throw reject("PAGE_FORM_INVALID");
  const entry = form.get("entry");
  const manifestText = form.get("manifest");
  if (typeof entry !== "string" || typeof manifestText !== "string") throw reject("PAGE_FORM_INVALID");
  let manifest: unknown;
  try { manifest = JSON.parse(manifestText); } catch { throw reject("PAGE_FORM_INVALID"); }
  if (!Array.isArray(manifest) || manifest.length > PAGE_LIMITS.maxFiles) throw reject(Array.isArray(manifest) ? "PAGE_FILE_LIMIT" : "PAGE_FORM_INVALID");
  const parts = new Set<string>();
  const files = manifest.map(item => {
    if (!item || typeof item !== "object" || typeof item.part !== "string" || typeof item.path !== "string"
      || item.part.length > 16 || ["entry", "manifest"].includes(item.part) || parts.has(item.part)) throw reject("PAGE_FORM_INVALID");
    parts.add(item.part);
    const blob = form.get(item.part);
    if (!blob || typeof blob === "string") throw reject("PAGE_FORM_INVALID");
    return { path: item.path as string, size: blob.size, blob };
  });
  if (keys.some(key => key !== "entry" && key !== "manifest" && !parts.has(key))) throw reject("PAGE_FORM_INVALID");
  const bundle = validatePageBundle(entry, files);
  const hashed = await Promise.all(bundle.files.map(async file => ({ ...file, sha256: await sha256Hex(await file.blob.arrayBuffer()) })));
  return { entry: bundle.entry, files: hashed };
}

type PublishedPage = { _id: Id<"ticketPages">; ticket?: string; url: string; entryPath: string; fileCount: number; totalBytes: number; publishedAt: number };
function published(page: PublishedPage, created: boolean, requestId: string) {
  return { ok: true, ticket: page.ticket, url: page.url, pageId: page._id, entry: page.entryPath,
    fileCount: page.fileCount, totalBytes: page.totalBytes, publishedAt: page.publishedAt, created, requestId: requestId.trim() };
}

function bearer(request: Request) {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!match) throw reject("AUTH_REQUIRED");
  return match[1];
}

/**
 * `POST /v1/tickets/{ticket}/pages`. A replay with the same Idempotency-Key and
 * content returns the original URL; a retry after interruption stages only the
 * files not yet recorded. A link exists only after the commit mutation.
 */
export async function publishPage(ctx: ActionCtx, request: Request) {
  let pageId: Id<"ticketPages"> | undefined;
  try {
    if (!originAllowed(request)) throw reject("ORIGIN_NOT_ALLOWED");
    const match = /^\/v1\/tickets\/([^/]+)\/pages\/?$/.exec(new URL(request.url).pathname);
    if (!match) return json(request, 404, { ok: false, code: "NOT_FOUND" });
    const token = bearer(request);
    const requestId = request.headers.get("idempotency-key");
    if (!requestId) throw reject("REQUIRED_REQUEST_ID");
    let ticket: string;
    try { ticket = decodeURIComponent(match[1]); } catch { throw reject("TICKET_UNAVAILABLE"); }
    // Session, Ticket write access, Project access and lifecycle come before any
    // body is read or hashed; reserve and commit check them again.
    await ctx.runMutation(internal.pages.authorize, { token, ticket });
    const bundle = await readBundle(request);
    const manifest = bundle.files.map(({ path, size, sha256 }) => ({ path, size, sha256 }));
    const reservation = await ctx.runMutation(internal.pages.reserve, { token, ticket, requestId, entry: bundle.entry, manifest });
    if (reservation.state === "published") {
      return json(request, 200, published(reservation.page, false, requestId));
    }
    pageId = reservation.pageId;
    // Each write was claimed before storage; the blob carries its private marker
    // until it is recorded, so an interruption here stays recoverable.
    for (const write of reservation.writes) {
      const file = bundle.files.find(item => item.path === write.path)!;
      const storageId = await ctx.storage.store(new Blob([file.blob], { type: write.contentType }));
      await ctx.runMutation(internal.pages.recordStaged, { pageId, marker: write.marker, path: file.path, sha256: file.sha256, size: file.size, storageId });
    }
    const page = await ctx.runMutation(internal.pages.commit, { token, pageId });
    return json(request, 201, published(page, true, requestId));
  } catch (error) {
    const code = error instanceof PublishError ? error.message : errorCode(error);
    // Only a definitive domain rejection ends staging. An unknown outcome keeps the
    // reservation for a same-key retry, then expiry reconciles it.
    if (pageId && error instanceof ConvexError && code && code !== "INTERNAL_ERROR") {
      try { await ctx.runMutation(internal.pages.abandon, { pageId }); } catch { /* Expiry reconciles it. */ }
    }
    // Storage or transport failures and internal errors have an unknown outcome:
    // report them as retryable, never as a client mistake.
    if (!code || code === "INTERNAL_ERROR") {
      console.error({ route: "pages:publish", errorClass: error instanceof Error ? error.constructor.name : typeof error });
      return failure(request, "PAGE_PUBLISH_UNKNOWN");
    }
    return failure(request, code);
  }
}

function unavailable(headers: Record<string, string>) {
  return new Response("This page is not available.", { status: 404, headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } });
}

/** `GET /p/{shareKey}/{path}`: anyone with the link, while published and the Ticket is active. */
export async function servePage(ctx: ActionCtx, request: Request) {
  const site = process.env.CONVEX_SITE_URL ?? new URL(request.url).origin;
  const parsed = parseServedPath(new URL(request.url).pathname);
  const headers = pageSecurityHeaders(site, parsed?.shareKey ?? "invalid");
  if (!parsed) return unavailable(headers);
  const resolved = await ctx.runQuery(internal.pages.resolve, { shareKey: parsed.shareKey, path: parsed.path });
  if (!resolved) return unavailable(headers);
  if (resolved.redirect !== undefined) {
    return new Response(null, { status: 302, headers: { ...headers, Location: `/p/${parsed.shareKey}/${encodePagePath(resolved.redirect)}` } });
  }
  if (!resolved.storageId || !resolved.contentType) return unavailable(headers);
  const blob = await ctx.storage.get(resolved.storageId);
  if (!blob) return unavailable(headers);
  return new Response(blob, { status: 200, headers: { ...headers, "Content-Type": resolved.contentType } });
}
