/**
 * HTTP edges for hosted Ticket pages. Publishing reserves, stages and commits
 * through internal mutations; serving resolves every request against the
 * committed row before reading bytes. Neither route writes the database itself.
 */
import { packImage, unpackImage } from "./image_transfer";
import { ConvexError } from "convex/values";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { errorCode } from "../shared/errors";
import { localFixturesEnabled } from "./local_fixtures";
import { pageFingerprintInput, isPageHtml, pageContentType, PAGE_LIMITS, pageSecurityHeaders, parseServedPath, sha256Hex, validatePageBundle, encodePagePath } from "../shared/ticket-pages";

const STATUS: Record<string, number> = {
  AUTH_REQUIRED: 401, SESSION_EXPIRED: 401, ORIGIN_NOT_ALLOWED: 403, LEGACY_ACCESS_DISABLED: 403,
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
    "Access-Control-Allow-Headers": "authorization, content-type, idempotency-key, x-ticket-image-policy",
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

/** Count multipart bytes as the parser consumes them, including requests without a length. */
async function boundedForm(request: Request) {
  const type = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data;/i.test(type)) throw reject("PAGE_FORM_INVALID");
  if (Number(request.headers.get("content-length")) > PAGE_LIMITS.maxRequestBytes) throw reject("PAGE_TOO_LARGE");
  if (!request.body) throw reject("PAGE_FILES_REQUIRED");
  const reader = request.body.getReader();
  let total = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) return controller.close();
      total += value.byteLength;
      if (total > PAGE_LIMITS.maxRequestBytes) {
        controller.error(reject("PAGE_TOO_LARGE"));
        await reader.cancel();
      } else {
        controller.enqueue(value);
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  try {
    return await new Response(body, { headers: { "content-type": type } }).formData();
  } catch {
    throw reject(total > PAGE_LIMITS.maxRequestBytes ? "PAGE_TOO_LARGE" : "PAGE_FORM_INVALID");
  }
}

async function readBundle(request: Request) {
  const form = await boundedForm(request);
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
  const sources = [];
  for (const file of bundle.files) {
    sources.push({ ...file, sha256: await sha256Hex(await file.blob.arrayBuffer()) });
  }
  return { entry: bundle.entry, files: sources };
}

/**
 * `X-Ticket-Image-Policy: v1` declares images already prepared by an official
 * client: they are validated, not re-encoded. Without it, each raster and each
 * literal base64 `img src` goes through the Sharp pipeline once.
 */
type SourceFile = Awaited<ReturnType<typeof readBundle>>["files"][number];
type PreparedFile = Awaited<ReturnType<typeof prepareFile>>;

async function prepareFiles(ctx: ActionCtx, remaining: SourceFile[], prepared: boolean) {
  const files: PreparedFile[] = [];
  let totalBytes = 0;
  // Consume the queue so each source can be collected after conversion. Small
  // assets share a batch; a large file gets the transfer budget to itself.
  while (remaining.length) {
    let count = 1;
    let batchBytes = remaining[0].size;
    while (count < 3 && count < remaining.length && batchBytes + remaining[count].size <= 1024 * 1024) {
      batchBytes += remaining[count].size;
      count++;
    }
    const batch = await Promise.all(remaining.splice(0, count).map(file => prepareFile(ctx, file, prepared)));
    for (const file of batch) {
      totalBytes += file.size;
      if (totalBytes > PAGE_LIMITS.maxTotalBytes) throw reject("PAGE_TOO_LARGE");
      files.push(file);
    }
  }
  return files;
}

async function prepareFile(ctx: ActionCtx, file: SourceFile, prepared: boolean) {
  let blob: Blob = file.blob;
  let sha256 = file.sha256;
  let rasterType: string | undefined;
  const raster = pageContentType(file.path).startsWith("image/");
  if (raster || isPageHtml(file.path)) {
    const bytes = await blob.arrayBuffer();
    if (raster || /data:image\//i.test(new TextDecoder().decode(bytes))) {
      const output = await ctx.runAction(internal.page_image_actions.prepare, { path: file.path, bytes: await packImage(ctx, bytes), prepared });
      rasterType = output.rasterType;
      if (output.bytes) {
        const result = await unpackImage(ctx, output.bytes);
        blob = new Blob([result]);
        sha256 = await sha256Hex(result);
      }
    }
  }
  return { ...file, blob, size: blob.size, rasterType, sha256 };
}

type PublishedPage = { _id: Id<"ticketPages">; ticket?: string; url: string; entryPath: string; fileCount: number; totalBytes: number; publishedAt: number };
function published(page: PublishedPage, created: boolean, requestId: string) {
  return { ok: true, ticket: page.ticket, url: page.url, pageId: page._id, entry: page.entryPath,
    fileCount: page.fileCount, totalBytes: page.totalBytes, publishedAt: page.publishedAt, created, requestId: requestId.trim() };
}

/**
 * Convex verifies the `Authorization: Bearer` Convex Auth JWT and forwards the
 * identity to every internal mutation below, which rechecks the live session.
 */
async function requireIdentity(ctx: ActionCtx, request: Request) {
  if (!/^Bearer\s+\S+$/i.test(request.headers.get("authorization") ?? "")) throw reject("AUTH_REQUIRED");
  let identity: unknown;
  try { identity = await ctx.auth.getUserIdentity(); } catch { throw reject("SESSION_EXPIRED"); }
  if (!identity) throw reject("SESSION_EXPIRED");
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
    await requireIdentity(ctx, request);
    const requestId = request.headers.get("idempotency-key");
    if (!requestId) throw reject("REQUIRED_REQUEST_ID");
    let ticket: string;
    try { ticket = decodeURIComponent(match[1]); } catch { throw reject("TICKET_UNAVAILABLE"); }
    // Session, Ticket write access, Project access and lifecycle come before any
    // body is read or hashed; reserve and commit check them again.
    const previous = await ctx.runMutation(internal.pages.authorize, { ticket, requestId });
    const source = await readBundle(request);
    const prepared = request.headers.get("x-ticket-image-policy") === "v1";
    const sourceDigest = await sha256Hex(new TextEncoder().encode(pageFingerprintInput({
      ticketId: previous.ticketId, entry: source.entry, files: source.files, ...(prepared ? {} : { imagePolicy: "server" as const }),
    })));
    if (previous.digest && previous.digest !== sourceDigest) throw reject("PAGE_REQUEST_CONFLICT");
    if (previous.published) return json(request, 200, published(previous.published, false, requestId));
    let files: PreparedFile[] = [];
    let manifest = previous.manifest;
    if (!manifest) {
      files = await prepareFiles(ctx, source.files, prepared);
      manifest = files.map(({ path, size, sha256, rasterType }) => ({ path, size, sha256, rasterType }));
    }
    const reservation = await ctx.runMutation(internal.pages.reserve, { ticket, requestId, entry: source.entry, manifest, sourceDigest });
    if (reservation.state === "published") {
      return json(request, 200, published(reservation.page, false, requestId));
    }
    pageId = reservation.pageId;
    if (previous.manifest) {
      const missing = new Set(reservation.writes.map(write => write.path));
      const remaining = source.files.splice(0).filter(file => missing.has(file.path));
      files = await prepareFiles(ctx, remaining, prepared);
    }
    // A codec update during an interrupted publish may produce different bytes.
    // Fail before storing new blobs or mixing outputs from different manifests.
    for (const file of files) {
      const expected = reservation.manifest.find(item => item.path === file.path);
      if (!expected || expected.sha256 !== file.sha256 || expected.size !== file.size) throw reject("PAGE_REQUEST_CONFLICT");
    }
    for (const write of reservation.writes) {
      const file = files.find(item => item.path === write.path)!;
      const storageId = await ctx.storage.store(new Blob([file.blob], { type: write.contentType }));
      await ctx.runMutation(internal.pages.recordStaged, { pageId, marker: write.marker, path: file.path, sha256: file.sha256, size: file.size, storageId });
    }
    const page = await ctx.runMutation(internal.pages.commit, { pageId });
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
      console.error({ route: "pages:publish", errorClass: error instanceof Error ? error.constructor.name : typeof error,
        ...(localFixturesEnabled() && error instanceof Error ? { message: error.message } : {}) });
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
  if (resolved.contentType.startsWith("image/") && resolved.sha256) {
    const tag = '"' + resolved.sha256 + '"';
    headers["ETag"] = tag;
    headers["Cache-Control"] = "private, no-cache, must-revalidate";
    if (request.headers.get("if-none-match")?.split(",").some(value => value.trim().replace(/^W\//, "") === tag)) {
      return new Response(null, {status:304, headers});
    }
  }
  const blob = await ctx.storage.get(resolved.storageId);
  if (!blob) return unavailable(headers);
  return new Response(blob, { status: 200, headers: { ...headers, "Content-Type": resolved.contentType } });
}
