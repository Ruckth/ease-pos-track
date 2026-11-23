/**
 * Hosted Ticket page contract shared by the Ticket UI, the CLI and the Convex
 * HTTP routes: limits, path safety, served media types and response headers.
 * Every rule is enforced again on the server; clients only fail earlier.
 */

export const PAGE_LIMITS = {
  maxFiles: 50,
  maxTotalBytes: 10 * 1024 * 1024,
  /** Multipart framing on top of the file bytes. Convex accepts 20 MiB. */
  maxRequestBytes: 11 * 1024 * 1024,
  maxPathLength: 240,
  maxDepth: 12,
  /** Published plus in-flight pages on one Ticket. */
  maxPagesPerTicket: 20,
} as const;

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
};

export const PAGE_FILE_EXTENSIONS = Object.keys(TYPES);

function extension(path: string) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** The served media type, decided by the file extension only. */
export function pageContentType(path: string) {
  return TYPES[extension(path)];
}

export function isPageHtml(path: string) {
  return ["html", "htm"].includes(extension(path));
}

/** Hidden files such as `.DS_Store` are skipped by folder clients, never served. */
export function isHiddenPagePath(path: string) {
  return path.split("/").some(segment => segment.startsWith("."));
}

/**
 * A relative POSIX path inside the page. NFC-normalized so a file named on
 * macOS matches the URL a browser requests.
 */
export function normalizePagePath(raw: string) {
  const path = raw.normalize("NFC");
  const segments = path.split("/");
  if (!path || path.length > PAGE_LIMITS.maxPathLength || segments.length > PAGE_LIMITS.maxDepth
    || /[\u0000-\u001f\u007f\\?#]/.test(path)
    || segments.some(segment => !segment || segment.startsWith(".") || segment.trim() !== segment)) {
    throw new Error("PAGE_PATH_INVALID");
  }
  return path;
}

export type PageFileInput = { path: string; size: number };

/** Validates one bundle; returns normalized paths in input order. */
export function validatePageBundle<T extends PageFileInput>(entry: string, files: T[]) {
  if (files.length === 0) throw new Error("PAGE_FILES_REQUIRED");
  if (files.length > PAGE_LIMITS.maxFiles) throw new Error("PAGE_FILE_LIMIT");
  const seen = new Set<string>();
  let total = 0;
  const normalized = files.map(file => {
    const path = normalizePagePath(file.path);
    if (seen.has(path)) throw new Error("PAGE_PATH_DUPLICATE");
    seen.add(path);
    if (!pageContentType(path)) throw new Error("PAGE_FILE_TYPE_UNSUPPORTED");
    if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error("PAGE_FILE_INVALID");
    total += file.size;
    return { ...file, path };
  });
  if (total > PAGE_LIMITS.maxTotalBytes) throw new Error("PAGE_TOO_LARGE");
  const entryPath = normalizePagePath(entry);
  if (!seen.has(entryPath) || !isPageHtml(entryPath)) throw new Error("PAGE_ENTRY_INVALID");
  return { entry: entryPath, files: normalized, totalBytes: total };
}

/** The only HTML file, else a root `index.html`; otherwise the uploader must choose. */
export function defaultPageEntry(paths: string[]) {
  const html = paths.filter(isPageHtml);
  if (html.length === 1) return html[0];
  return html.find(path => path === "index.html" || path === "index.htm");
}

export async function sha256Hex(bytes: ArrayBuffer | Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export type PageManifestEntry = { path: string; size: number; sha256: string };

/** Canonical retry fingerprint: Ticket, entry and every path, size and content hash. */
export function pageFingerprintInput(input: { ticketId: string; entry: string; files: PageManifestEntry[] }) {
  const files = [...input.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    .map(file => [file.path, file.size, file.sha256]);
  return JSON.stringify({ v: 1, ticketId: input.ticketId, entry: input.entry, files });
}

export function encodePagePath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}

export const SHARE_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function pageUrl(siteUrl: string, shareKey: string, entry: string) {
  return `${siteUrl.replace(/\/+$/, "")}/p/${shareKey}/${encodePagePath(entry)}`;
}

/**
 * Splits `/p/<key>/<path>` from a request URL. A missing path means the entry
 * page; a trailing slash means that folder's `index.html`.
 */
export function parseServedPath(pathname: string) {
  const match = /^\/p\/([^/]+)(?:\/(.*))?$/.exec(pathname);
  if (!match || !SHARE_KEY_PATTERN.test(match[1])) return null;
  const rest = match[2] ?? "";
  if (!rest) return { shareKey: match[1], path: undefined };
  let decoded: string;
  try { decoded = rest.split("/").map(decodeURIComponent).join("/"); } catch { return null; }
  if (decoded.endsWith("/")) decoded += "index.html";
  try { return { shareKey: match[1], path: normalizePagePath(decoded) }; } catch { return null; }
}

/**
 * Uploaded pages run in an opaque-origin sandbox on the Convex HTTP host. Only
 * inline code, embedded data and files under this page's own URL prefix load.
 */
export function pageSecurityHeaders(siteUrl: string, shareKey: string): Record<string, string> {
  const prefix = `${siteUrl.replace(/\/+$/, "")}/p/${shareKey}/`;
  const csp = [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src 'unsafe-inline' ${prefix}`,
    `style-src 'unsafe-inline' ${prefix}`,
    `img-src data: blob: ${prefix}`,
    `font-src data: ${prefix}`,
    `media-src data: blob: ${prefix}`,
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  return {
    "Content-Security-Policy": csp,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "X-Frame-Options": "DENY",
    // The sandboxed document has an opaque origin, so fonts and module scripts
    // are cross-origin CORS loads. No credentials are ever involved.
    "Access-Control-Allow-Origin": "*",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  };
}

/**
 * The one multipart body every client sends to `POST /v1/tickets/{ticket}/pages`:
 * `entry`, a `manifest` mapping part names to relative paths, and one part per file.
 */
export function pageFormData(entry: string, files: Array<{ path: string; blob: Blob }>) {
  const form = new FormData();
  form.set("entry", entry);
  form.set("manifest", JSON.stringify(files.map((file, index) => ({ part: `f${index}`, path: file.path }))));
  files.forEach((file, index) => form.set(`f${index}`, file.blob, file.path.split("/").at(-1)));
  return form;
}
