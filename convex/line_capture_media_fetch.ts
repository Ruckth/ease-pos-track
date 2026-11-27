import { imageSize } from "image-size";
import { localLineFixtureToken } from "./adapters/line";
import { localFixturesEnabled, requireLocalFixtures } from "./local_fixtures";
import { isLoopbackOrigin } from "../shared/pilot-settings";
import type { IntakeMediaContentType, IntakeMediaWarningCode } from "./line_capture_media_schema";

export const LINE_CAPTURE_MAX_IMAGES = 2;
export const LINE_CAPTURE_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
export const LINE_CAPTURE_MAX_IMAGE_PIXELS = 32_000_000;
export const LINE_CAPTURE_STAGING_TTL_MS = 24 * 60 * 60 * 1000;
export const LINE_CAPTURE_FETCH_TIMEOUT_MS = 10_000;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_END = [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const JPEG_END = [0xff, 0xd9];
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];

// Minimal valid 16x16 PNG and JPEG fixtures for local/preview synthesis without real LINE credentials.
const FIXTURE_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVR4nGNQTX5NEmIY1ZA8GkqqwzVpAAB2SXMQw3lX6AAAAABJRU5ErkJggg==";
const FIXTURE_JPEG_B64 =
  "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAQABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABQf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCQAHTd/9k=";

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function fixturePngBytes(): Uint8Array<ArrayBuffer> {
  return fromBase64(FIXTURE_PNG_B64);
}

export function fixtureJpegBytes(): Uint8Array<ArrayBuffer> {
  return fromBase64(FIXTURE_JPEG_B64);
}

function matches(bytes: Uint8Array, pattern: number[], offset = 0): boolean {
  return offset >= 0 && bytes.length >= offset + pattern.length && pattern.every((byte, i) => bytes[offset + i] === byte);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function hexToBase64(hex: string): string {
  let binary = "";
  for (let index = 0; index < hex.length; index += 2) {
    binary += String.fromCharCode(parseInt(hex.slice(index, index + 2), 16));
  }
  return btoa(binary);
}

export type ParsedImageSet =
  | { kind: "none" }
  | { kind: "valid"; id: string; index: number; total: number }
  | { kind: "overflow"; id: string; index: number; total: number; warning: "IMAGE_SET_OVERFLOW" }
  | { kind: "invalid"; warning: "IMAGE_SET_METADATA_INCOMPLETE"; rawId?: string };

/**
 * Parses LINE's optional `message.imageSet`. Rejects incomplete metadata and
 * sets exceeding two images with explicit warnings so callers never silently select a subset.
 */
export function parseLineImageSet(raw: unknown): ParsedImageSet {
  if (raw === undefined || raw === null) return { kind: "none" };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { kind: "invalid", warning: "IMAGE_SET_METADATA_INCOMPLETE" };
  }
  const fields = raw as Record<string, unknown>;
  const id = typeof fields.id === "string" && fields.id.length > 0 && fields.id.length <= 128 ? fields.id : undefined;
  const index = fields.index;
  const total = fields.total;
  if (!id || typeof index !== "number" || !Number.isSafeInteger(index)
    || typeof total !== "number" || !Number.isSafeInteger(total)
    || index < 1 || total < 1 || index > total) {
    return { kind: "invalid", warning: "IMAGE_SET_METADATA_INCOMPLETE", ...(id ? { rawId: id } : {}) };
  }
  if (total > LINE_CAPTURE_MAX_IMAGES) {
    return { kind: "overflow", id, index, total, warning: "IMAGE_SET_OVERFLOW" };
  }
  return { kind: "valid", id, index, total };
}

export type ValidatedCapturedImage =
  | {
    ok: true;
    contentType: IntakeMediaContentType;
    width: number;
    height: number;
    size: number;
    sha256: string;
  }
  | {
    ok: false;
    warningCode: IntakeMediaWarningCode;
  };

/**
 * M1 stages JPEG and PNG images only. PDFs and unrecognized/malformed files
 * return explicit warnings rather than being stored or silently dropped.
 */
export async function validateCapturedImage(
  bytes: Uint8Array,
  declaredMime?: string,
): Promise<ValidatedCapturedImage> {
  if (!bytes.length) return { ok: false, warningCode: "MEDIA_MALFORMED" };
  if (bytes.length > LINE_CAPTURE_MAX_TOTAL_BYTES) return { ok: false, warningCode: "MEDIA_SIZE_LIMIT_EXCEEDED" };

  if (matches(bytes, PDF_MAGIC)) return { ok: false, warningCode: "UNSUPPORTED_FILE_PDF" };

  let contentType: IntakeMediaContentType;
  if (matches(bytes, PNG_MAGIC)) contentType = "image/png";
  else if (matches(bytes, JPEG_MAGIC)) contentType = "image/jpeg";
  else return { ok: false, warningCode: "UNSUPPORTED_MEDIA_TYPE" };

  const declared = declaredMime?.split(";", 1)[0].trim().toLowerCase();
  if (declared && declared !== "application/octet-stream" && declared !== contentType) {
    return { ok: false, warningCode: "MEDIA_CONTENT_TYPE_MISMATCH" };
  }

  const trailer = contentType === "image/png" ? PNG_END : JPEG_END;
  if (!matches(bytes, trailer, bytes.length - trailer.length)) {
    return { ok: false, warningCode: "MEDIA_MALFORMED" };
  }

  let width: number;
  let height: number;
  try {
    const info = imageSize(bytes);
    const expected = contentType === "image/png" ? "png" : "jpg";
    if (info.type !== expected || !info.width || !info.height || info.width < 1 || info.height < 1) {
      return { ok: false, warningCode: "MEDIA_MALFORMED" };
    }
    width = info.width;
    height = info.height;
  } catch {
    return { ok: false, warningCode: "MEDIA_MALFORMED" };
  }

  if (width * height > LINE_CAPTURE_MAX_IMAGE_PIXELS) {
    return { ok: false, warningCode: "MEDIA_PIXEL_LIMIT_EXCEEDED" };
  }

  return {
    ok: true,
    contentType,
    width,
    height,
    size: bytes.byteLength,
    sha256: await sha256Hex(bytes),
  };
}

/**
 * Streams a fetch Response with a hard byte ceiling regardless of whether
 * Content-Length is present or accurate.
 */
export async function readBoundedResponse(
  response: Response,
  maxBytes = LINE_CAPTURE_MAX_TOTAL_BYTES,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; mimeType?: string }> {
  if (response.status === 404 || response.status === 410) throw new Error("MEDIA_UPSTREAM_EXPIRED");
  if (response.status !== 200 || !response.body) throw new Error("MEDIA_DOWNLOAD_UNAVAILABLE");
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body.cancel().catch(() => {});
    throw new Error("MEDIA_SIZE_LIMIT_EXCEEDED");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("MEDIA_SIZE_LIMIT_EXCEEDED");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof Error && error.message === "MEDIA_SIZE_LIMIT_EXCEEDED") throw error;
    throw new Error("MEDIA_DOWNLOAD_UNAVAILABLE");
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(new ArrayBuffer(size));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, mimeType: response.headers.get("content-type") ?? undefined };
}

/**
 * Deterministic built-in fixture content responses keyed by messageId prefix,
 * allowing local preview and tests to stage JPEG/PNG and warning scenarios with no credentials.
 */
export function fixtureContentResponse(messageId: string): Response {
  if (messageId.startsWith("fixture-expired-")) return new Response(null, { status: 410 });
  if (messageId.startsWith("fixture-error-")) return new Response(null, { status: 503 });
  if (messageId.startsWith("fixture-oversized-")) {
    return new Response(new Uint8Array(LINE_CAPTURE_MAX_TOTAL_BYTES + 1), {
      status: 200,
      headers: { "Content-Type": "image/png" },
    });
  }
  if (messageId.startsWith("fixture-pdf-")) {
    return new Response("%PDF-1.4\n%fixture\n", {
      status: 200,
      headers: { "Content-Type": "application/pdf" },
    });
  }
  if (messageId.startsWith("fixture-bad-")) {
    return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00]), {
      status: 200,
      headers: { "Content-Type": "image/png" },
    });
  }
  if (messageId.startsWith("fixture-mismatch-")) {
    return new Response(fixturePngBytes(), {
      status: 200,
      headers: { "Content-Type": "image/jpeg" },
    });
  }
  if (messageId.startsWith("fixture-jpeg-") || messageId.startsWith("fixture-jpg-")) {
    return new Response(fixtureJpegBytes(), {
      status: 200,
      headers: { "Content-Type": "image/jpeg" },
    });
  }
  if (messageId.startsWith("fixture-png-") || messageId.startsWith("fixture-")) {
    return new Response(fixturePngBytes(), {
      status: 200,
      headers: { "Content-Type": "image/png" },
    });
  }
  return new Response(null, { status: 404 });
}

export async function fetchCapturedLineContent(input: {
  messageId: string;
  token: string;
  maxBytes?: number;
  transport?: typeof fetch;
}): Promise<{ bytes: Uint8Array<ArrayBuffer>; mimeType?: string }> {
  const maxBytes = Math.min(input.maxBytes ?? LINE_CAPTURE_MAX_TOTAL_BYTES, LINE_CAPTURE_MAX_TOTAL_BYTES);
  const fetchFn = input.transport ?? fetch;

  if (input.token === localLineFixtureToken) {
    requireLocalFixtures();
    const fixtureBase = process.env.LINE_CAPTURE_FIXTURE_MEDIA_BASE_URL?.trim();
    if (fixtureBase) {
      if (!isLoopbackOrigin(fixtureBase)) throw new Error("LINE_FIXTURE_LOOPBACK_REQUIRED");
      const url = `${fixtureBase.replace(/\/+$/, "")}/${encodeURIComponent(input.messageId)}`;
      let response: Response;
      try {
        response = await fetchFn(url, {
          method: "GET",
          redirect: "error",
          headers: { Authorization: `Bearer ${localLineFixtureToken}` },
          signal: AbortSignal.timeout(LINE_CAPTURE_FETCH_TIMEOUT_MS),
        });
      } catch {
        throw new Error("MEDIA_DOWNLOAD_UNAVAILABLE");
      }
      return readBoundedResponse(response, maxBytes);
    }
    if (input.transport) {
      let response: Response;
      try {
        response = await input.transport(`http://127.0.0.1/fixture/line-content/${encodeURIComponent(input.messageId)}`, {
          method: "GET",
          redirect: "error",
          headers: { Authorization: `Bearer ${localLineFixtureToken}` },
          signal: AbortSignal.timeout(LINE_CAPTURE_FETCH_TIMEOUT_MS),
        });
      } catch {
        throw new Error("MEDIA_DOWNLOAD_UNAVAILABLE");
      }
      return readBoundedResponse(response, maxBytes);
    }
    return readBoundedResponse(fixtureContentResponse(input.messageId), maxBytes);
  }

  // Never send real credentials or contact api-data.line.me in local/preview mode or without explicit opt-in.
  if (localFixturesEnabled() || process.env.TICKET_LOCAL_PREVIEW === "true") {
    throw new Error("LINE_FIXTURE_REQUIRED");
  }
  if (process.env.LINE_CAPTURE_LIVE_FETCH_ENABLED !== "true") {
    throw new Error("LINE_LIVE_FETCH_DISABLED");
  }

  let response: Response;
  try {
    response = await fetchFn(`https://api-data.line.me/v2/bot/message/${encodeURIComponent(input.messageId)}/content`, {
      method: "GET",
      redirect: "error",
      headers: { Authorization: `Bearer ${input.token}` },
      signal: AbortSignal.timeout(LINE_CAPTURE_FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new Error("MEDIA_DOWNLOAD_UNAVAILABLE");
  }
  return readBoundedResponse(response, maxBytes);
}
