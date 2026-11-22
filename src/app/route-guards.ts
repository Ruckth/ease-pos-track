import { APP_PATHS, homePathForRole, normalizePathname, resolveAppRoute } from "@/lib/app-routes";
import type { SessionRole } from "@/lib/session";

/** The server-validated principal kind, or signed-out. Loading never reaches guards. */
export type GuardSession = "signed-out" | "pending" | SessionRole;

export type GuardOptions = {
  /** A customer invitation is held in memory for the join flow. */
  invitation?: boolean;
  /** Consumes a return target stashed before a Google redirect, which cannot carry a query. */
  takeStoredReturn?: () => string | null;
};

const MAX_REDIRECT_LENGTH = 2048;
const PROBE_ORIGIN = "https://app.invalid";
const AUTH_PAGES = new Set(["staff-login", "customer-login"]);
const RETURN_PATHS: Record<SessionRole, readonly string[]> = {
  staff: [APP_PATHS.staffHome, APP_PATHS.staffT3Settings],
  customer: [APP_PATHS.customerHome],
};

/**
 * A post-sign-in return target: a same-origin path to the signed-in role's own
 * workspace, with its query. Anything else (other role, /api, protocol-relative,
 * absolute or malformed URLs) is rejected.
 */
export function safeReturnTarget(raw: unknown, role: SessionRole): string | null {
  if (typeof raw !== "string" || raw.length > MAX_REDIRECT_LENGTH) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(raw)) return null;
  let url: URL;
  try { url = new URL(raw, PROBE_ORIGIN); } catch { return null; }
  if (url.origin !== PROBE_ORIGIN) return null;
  const path = normalizePathname(url.pathname);
  if (!RETURN_PATHS[role].includes(path)) return null;
  return `${path}${url.search}`;
}

const namespace = (path: string) => path.split("/")[1];

/**
 * The single redirect decision for a location, or null when it renders.
 * Signed-out deep links into a workspace keep their path and query as
 * `?redirect=`; signing in honours it only for the same role.
 */
export function guardRedirect(pathname: string, searchStr: string, session: GuardSession, options: GuardOptions = {}): string | null {
  const route = resolveAppRoute(pathname, session);
  if (route.page !== "redirect") return null;

  const path = normalizePathname(pathname);
  const search = searchStr && !searchStr.startsWith("?") ? `?${searchStr}` : searchStr;
  if (session === "staff" || session === "customer") {
    if (session === "customer" && path === APP_PATHS.customerLogin && options.invitation) return APP_PATHS.customerJoin;
    if (!AUTH_PAGES.has(resolveAppRoute(path, "signed-out").page)) {
      // Main's shell kept the query within the same role's namespace.
      return namespace(path) === namespace(route.to) ? `${route.to}${search}` : route.to;
    }
    const stored = options.takeStoredReturn?.() ?? null;
    return safeReturnTarget(new URLSearchParams(search).get("redirect"), session)
      ?? safeReturnTarget(stored, session)
      ?? route.to;
  }
  if (RETURN_PATHS.staff.includes(path) || RETURN_PATHS.customer.includes(path)) {
    return `${route.to}?${new URLSearchParams({ redirect: `${path}${search}` })}`;
  }
  return route.to;
}
