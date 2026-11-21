import { APP_PATHS, homePathForRole, normalizePathname, resolveAppRoute } from "@/lib/app-routes";
import type { SessionRole } from "@/lib/session";

export type GuardAuth = { status: "signed-out" } | { status: "signed-in"; role: SessionRole };

const MAX_REDIRECT_LENGTH = 2048;
const PROBE_ORIGIN = "https://app.invalid";
const AUTH_PAGES = new Set(["staff-login", "customer-login", "customer-register"]);

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
  const home = homePathForRole(role);
  if (normalizePathname(url.pathname) !== home) return null;
  return `${home}${url.search}`;
}

/**
 * The single redirect decision for a location, or null when it renders.
 * Signed-out deep links into a workspace keep their path and query as
 * `?redirect=`; signing in honours it only for the same role.
 */
export function guardRedirect(pathname: string, searchStr: string, auth: GuardAuth): string | null {
  const session = auth.status === "signed-in" ? auth.role : "signed-out";
  const route = resolveAppRoute(pathname, session);
  if (route.page !== "redirect") return null;

  const path = normalizePathname(pathname);
  const search = searchStr && !searchStr.startsWith("?") ? `?${searchStr}` : searchStr;
  if (auth.status === "signed-in") {
    const page = resolveAppRoute(path, "signed-out").page;
    if (!AUTH_PAGES.has(page)) return route.to;
    return safeReturnTarget(new URLSearchParams(search).get("redirect"), auth.role) ?? route.to;
  }
  if (path === APP_PATHS.staffHome || path === APP_PATHS.customerHome) {
    return `${route.to}?${new URLSearchParams({ redirect: `${path}${search}` })}`;
  }
  return route.to;
}
