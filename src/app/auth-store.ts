import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { loginPathForRole } from "@/lib/app-routes";
import { clearToken, getStoredToken, storeToken, type SessionRole } from "@/lib/session";
import { useLogout, useSession } from "./adapter";

/** Settled authentication handed to the router. The token never enters a URL. */
export type AuthState =
  | { status: "signed-out" }
  | { status: "signed-in"; token: string; role: SessionRole; email: string | null };

let token: string | null = null;
let afterSignOut: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());

/** The one writer of the session token; storage stays in `@/lib/session`. */
export const authStore = {
  getToken: () => (token ??= getStoredToken()),
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  signIn(next: string) {
    storeToken(next);
    token = next;
    emit();
  },
  /** `href` is where an explicit sign-out lands; without it guards decide. */
  clear(href?: string) {
    toast.dismiss();
    clearToken();
    afterSignOut = href ?? null;
    token = "";
    emit();
  },
  takeAfterSignOut() {
    const href = afterSignOut;
    afterSignOut = null;
    return href;
  },
};

/**
 * Three states: `loading` while a stored token is validated, then the settled
 * role or signed-out. A token the server stops accepting is cleared reactively.
 */
export function useAuthState(): "loading" | AuthState {
  const current = useSyncExternalStore(authStore.subscribe, authStore.getToken);
  const session = useSession(current);
  useEffect(() => {
    if (current && session === null && authStore.getToken() === current) authStore.clear();
  }, [current, session]);
  return useMemo(() => {
    if (!current) return { status: "signed-out" };
    if (!session) return "loading";
    return { status: "signed-in", token: current, role: session.role, email: session.email };
  }, [current, session]);
}

/** Revokes the session, dismisses undo toasts and lands on the role's sign-in. */
export function useSignOut(token: string, role: SessionRole) {
  const logout = useLogout();
  return useCallback(async () => {
    // Leave first: the reactive session would otherwise clear without a target.
    authStore.clear(loginPathForRole(role));
    await logout({ token });
  }, [logout, role, token]);
}
