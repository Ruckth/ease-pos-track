import type { SessionRole } from "@/lib/session";

export const APP_PATHS = {
  root: "/",
  staffHome: "/staff",
  staffLogin: "/staff/login",
  customerHome: "/customer",
  customerLogin: "/customer/login",
  customerRegister: "/customer/register",
} as const;

export type RouteSession = "loading" | "signed-out" | SessionRole;

export type AppRoute =
  | { page: "loading" }
  | { page: "redirect"; to: string }
  | { page: "staff-login" }
  | { page: "customer-login" }
  | { page: "customer-register" }
  | { page: "staff-home" }
  | { page: "customer-home" };

export function homePathForRole(role: SessionRole) {
  return role === "staff" ? APP_PATHS.staffHome : APP_PATHS.customerHome;
}

export function loginPathForRole(role: SessionRole) {
  return role === "staff" ? APP_PATHS.staffLogin : APP_PATHS.customerLogin;
}

function normalizePathname(pathname: string) {
  if (!pathname.startsWith("/")) return `/${pathname}`;
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname;
}

/**
 * Resolves every URL and session combination to one renderable page or one
 * canonical redirect. Authentication role remains the authority; a URL never
 * grants access to the other role's workspace.
 */
export function resolveAppRoute(pathname: string, session: RouteSession): AppRoute {
  if (session === "loading") return { page: "loading" };

  const path = normalizePathname(pathname);
  if (session === "staff" || session === "customer") {
    const home = homePathForRole(session);
    if (path !== home) return { page: "redirect", to: home };
    return { page: session === "staff" ? "staff-home" : "customer-home" };
  }

  switch (path) {
    case APP_PATHS.staffLogin:
      return { page: "staff-login" };
    case APP_PATHS.customerLogin:
      return { page: "customer-login" };
    case APP_PATHS.customerRegister:
      return { page: "customer-register" };
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
