/**
 * Private staff-only authenticated bytes HTTP route for staged LINE capture media.
 * Rechecks admitted staff, live intake enrollment, unsend fence, expiry and source
 * revision on every request and streams bytes directly with Cache-Control: no-store
 * without ever returning a public Convex storage URL.
 */
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import { errorCode } from "../shared/errors";
import { lineCaptureMediaRoutes } from "./functions";
import type { ResolvedStaffMedia } from "./line_capture_media_domain";

function allowedOrigins(): string[] {
  return (process.env.TICKET_APP_ORIGINS ?? "")
    .split(",")
    .map(origin => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

function originAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin === null || allowedOrigins().includes(origin);
}

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  return origin && allowedOrigins().includes(origin)
    ? {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "authorization",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    }
    : { Vary: "Origin" };
}

function jsonError(request: Request, status: number, code: string): Response {
  return new Response(JSON.stringify({ ok: false, code }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff",
      ...corsHeaders(request),
    },
  });
}

export async function preflightCapturedMedia(_ctx: ActionCtx, request: Request): Promise<Response> {
  const origin = request.headers.get("origin");
  if (!origin || !originAllowed(request)) {
    return new Response(null, { status: 403, headers: { Vary: "Origin" } });
  }
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

/** `GET /v1/line-capture/media/{mediaId}?revision={intakeRevision}` */
export async function serveCapturedMedia(ctx: ActionCtx, request: Request): Promise<Response> {
  if (!originAllowed(request)) return jsonError(request, 403, "ORIGIN_NOT_ALLOWED");

  const url = new URL(request.url);
  const rawId = url.pathname.slice(lineCaptureMediaRoutes.serve.pathPrefix.length);
  if (!rawId || rawId.includes("/") || rawId.length > 128) {
    return jsonError(request, 400, "INVALID_MEDIA_REQUEST");
  }
  let mediaId: string;
  try {
    mediaId = decodeURIComponent(rawId);
  } catch {
    return jsonError(request, 400, "INVALID_MEDIA_REQUEST");
  }

  let expectedRevision: number | undefined;
  const revParam = url.searchParams.get("revision");
  if (revParam !== null) {
    if (!/^[1-9]\d{0,9}$/.test(revParam)) return jsonError(request, 400, "INVALID_MEDIA_REQUEST");
    expectedRevision = Number(revParam);
  }

  if (!/^Bearer\s+\S+$/i.test(request.headers.get("authorization") ?? "")) {
    return jsonError(request, 401, "AUTH_REQUIRED");
  }
  let identity: unknown;
  try {
    identity = await ctx.auth.getUserIdentity();
  } catch {
    return jsonError(request, 401, "SESSION_EXPIRED");
  }
  if (!identity) return jsonError(request, 401, "SESSION_EXPIRED");

  let resolved: ResolvedStaffMedia;
  try {
    resolved = await ctx.runQuery(internal.line_capture_media.resolveForStaff, {
      mediaId,
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    });
  } catch (error) {
    const code = errorCode(error);
    if (code === "SESSION_EXPIRED" || code === "AUTH_REQUIRED") return jsonError(request, 401, code);
    if (code === "STAFF_ONLY" || code === "LEGACY_ACCESS_DISABLED") return jsonError(request, 403, code);
    return jsonError(request, 404, "MEDIA_UNAVAILABLE");
  }

  if (!resolved.ok) {
    return jsonError(request, resolved.status, resolved.code);
  }

  const blob = await ctx.storage.get(resolved.storageId);
  if (!blob) return jsonError(request, 404, "MEDIA_UNAVAILABLE");

  return new Response(blob, {
    status: 200,
    headers: {
      "Content-Type": resolved.contentType,
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Referrer-Policy": "no-referrer",
      ...corsHeaders(request),
    },
  });
}
