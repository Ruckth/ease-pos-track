import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { APP_PATHS, normalizePathname } from "@/lib/app-routes";
import { safeReturnTarget, type GuardSession } from "./route-guards";
import { useSessionActions, useViewer } from "./adapter";

export type Viewer = NonNullable<ReturnType<typeof useViewer>>;

/** Settled authentication handed to the router. Credentials never enter a URL. */
export type AuthState = { status: "signed-out" } | { status: "signed-in"; viewer: Viewer };

export function guardSession(auth: AuthState): GuardSession {
  return auth.status === "signed-out" ? "signed-out" : auth.viewer.kind;
}

/** Protected pages require a settled result from the current viewer subscription. */
export function useAuthState(): "loading" | AuthState {
  const viewer = useViewer();
  return useMemo(() => {
    if (viewer === undefined) return "loading";
    return viewer === null ? { status: "signed-out" } : { status: "signed-in", viewer };
  }, [viewer]);
}

/**
 * Revoke the session, then reload: a full navigation drops every live
 * subscription, cached Ticket data and draft before another account signs in.
 */
export function useLeave() {
  const { signOut } = useSessionActions();
  return useCallback(async (path: string) => {
    toast.dismiss();
    try { await signOut(); } finally { window.location.replace(path); }
  }, [signOut]);
}

/** An expired session already lost server access. Clear its local credentials;
 * the viewer guard restores sign-in with the current workspace return target. */
export function useSessionExpiry(loginPath: string) {
  const { signOut } = useSessionActions();
  return useCallback(() => {
    toast.dismiss();
    void signOut().catch(() => window.location.replace(loginPath));
  }, [signOut, loginPath]);
}

const JOIN_FLOW = new Set<string>([APP_PATHS.customerJoin, APP_PATHS.customerLogin, APP_PATHS.customerRecover]);
let invitation = "";

/**
 * Captures a customer invitation from the `/customer/join` fragment, strips it
 * from the address bar, and keeps it in memory only while the visitor stays in
 * the join, sign-in and recovery flow.
 */
export function syncInvitation(pathname: string, hash: string) {
  const path = normalizePathname(pathname);
  const fresh = path === APP_PATHS.customerJoin ? new URLSearchParams(hash.replace(/^#/, "")).get("invite") ?? "" : "";
  invitation = JOIN_FLOW.has(path) ? fresh || invitation : "";
  if (fresh && typeof window !== "undefined" && window.location.hash) {
    window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  }
  return invitation;
}

export const currentInvitation = () => invitation;

const RETURN_KEY = "track-ease.staff-sign-in-return";

/** Google's redirect URL carries no query, so the return target waits per tab. */
export function stashReturnTarget(target: string | null, role: "customer" | "staff" = "staff") {
  try {
    const href = safeReturnTarget(target, role);
    if (href) sessionStorage.setItem(RETURN_KEY, href);
    else sessionStorage.removeItem(RETURN_KEY);
  } catch { /* storage unavailable: sign-in still lands on the role home */ }
}

export function takeReturnTarget() {
  try {
    const target = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    return target;
  } catch { return null; }
}
