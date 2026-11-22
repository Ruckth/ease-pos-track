import { ConvexReactClient } from "convex/react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import type { ReactNode } from "react";
import { api } from "@convex/_generated/api";

const url = import.meta.env.VITE_CONVEX_URL;
const client = url ? new ConvexReactClient(url) : null;
// Per-tab storage: closing the tab on a shared device ends the browser session.
const storage = typeof window === "undefined" ? undefined : window.sessionStorage;
const authApi = { refreshSession: api.auth.refreshSession, signOut: api.auth.signOut, isAuthenticated: api.auth.isAuthenticated };

/** Convex Auth 2.0.0: the verified JWT is the only browser credential. */
export function BackendProvider({ children }: { children: ReactNode }) {
  return client ? <ConvexAuthProvider client={client} api={authApi} storage={storage}>{children}</ConvexAuthProvider> : null;
}
