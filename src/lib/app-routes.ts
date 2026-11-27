import type { SessionRole } from "@/lib/session";

export const APP_PATHS = {
  root: "/",
  staffHome: "/staff",
  staffLogin: "/staff/login",
  staffInvite: "/staff/invite",
  /** Signed T3 kits link here (`settingsUrl`); keep both in step. */
  staffT3Settings: "/staff/settings/t3",
  staffLineSettings: "/staff/settings/line",
  customerHome: "/customer",
  customerLogin: "/customer/login",
  customerJoin: "/customer/join",
  customerRecover: "/customer/recover",
} as const;

type RouteSession = "loading" | "signed-out" | "pending" | SessionRole;

type AppRoute =
  | { page: "loading" }
  | { page: "redirect"; to: string }
  | { page: "staff-login" }
  | { page: "staff-invite" }
  | { page: "pending-identity" }
  | { page: "customer-login" }
  | { page: "customer-join" }
  | { page: "customer-recover" }
  | { page: "staff-home"; settings?: "t3" | "line" }
  | { page: "customer-home" };

export function homePathForRole(role: SessionRole) {
  return role === "staff" ? APP_PATHS.staffHome : APP_PATHS.customerHome;
}

export function loginPathForRole(role: SessionRole) {
  return role === "staff" ? APP_PATHS.staffLogin : APP_PATHS.customerLogin;
}

export function normalizePathname(pathname: string) {
  if (!pathname.startsWith("/")) return `/${pathname}`;
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname;
}

/**
 * Resolves every URL and session combination to one renderable page or one
 * canonical redirect. The server-validated principal remains the authority; a
 * URL never grants access to the other role's workspace.
 */
export function resolveAppRoute(pathname: string, session: RouteSession): AppRoute {
  if (session === "loading") return { page: "loading" };

  const path = normalizePathname(pathname);
  // The join page itself explains when the active account must switch.
  if (path === APP_PATHS.customerJoin) return { page: "customer-join" };
  if (session === "pending") {
    return path === APP_PATHS.staffInvite ? { page: "staff-invite" } : { page: "pending-identity" };
  }
  if (session === "staff" && path === APP_PATHS.staffLineSettings) return { page: "staff-home", settings: "line" };
  if (session === "staff" && path === APP_PATHS.staffT3Settings) return { page: "staff-home", settings: "t3" };
  if (session === "staff" || session === "customer") {
    const home = homePathForRole(session);
    if (path !== home) return { page: "redirect", to: home };
    return { page: session === "staff" ? "staff-home" : "customer-home" };
  }

  switch (path) {
    case APP_PATHS.staffLogin:
      return { page: "staff-login" };
    case APP_PATHS.staffInvite:
      return { page: "staff-invite" };
    case APP_PATHS.customerLogin:
      return { page: "customer-login" };
    case APP_PATHS.customerRecover:
      return { page: "customer-recover" };
    case APP_PATHS.customerHome:
      return { page: "redirect", to: APP_PATHS.customerLogin };
    case APP_PATHS.staffHome:
    case APP_PATHS.root:
      return { page: "redirect", to: APP_PATHS.staffLogin };
    default:
      return {
        page: "redirect",
        to: path.startsWith(`${APP_PATHS.customerHome}/`)
          ? APP_PATHS.customerLogin
          : APP_PATHS.staffLogin,
      };
  }
}
