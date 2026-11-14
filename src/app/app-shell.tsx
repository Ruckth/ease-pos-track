import { SessionBoundary } from "./session-boundary";
import { AuthPage } from "@/components/auth-screens";
import { CustomerPortal } from "@/features/tickets/customer-portal";
import { StaffWorkspace } from "@/features/tickets/staff-workspace";
import { loginPathForRole, resolveAppRoute } from "@/lib/app-routes";
import { clearToken, getStoredToken, storeToken } from "@/lib/session";
import { api } from "@convex/_generated/api";
import { useMutation, useQuery } from "convex/react";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

function useAppPathname() {
  const [pathname, setPathname] = useState(() => window.location.pathname);

  useEffect(() => {
    const updatePathname = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", updatePathname);
    return () => window.removeEventListener("popstate", updatePathname);
  }, []);

  const navigate = useCallback((path: string, replace = false) => {
    if (window.location.pathname === path) return;
    window.history[replace ? "replaceState" : "pushState"](null, "", path);
    setPathname(path);
  }, []);

  return { pathname, navigate };
}

/** Routes by both URL namespace and the server-validated session role. */
export function AppShell() {
  const [token, setToken] = useState(getStoredToken);
  const { pathname, navigate } = useAppPathname();
  const logout = useMutation(api.auth.logout);
  const session = useQuery(api.auth.currentSession, { token: token || undefined });
  const route = resolveAppRoute(
    pathname,
    token && session === undefined
      ? "loading"
      : session?.role ?? "signed-out",
  );
  const redirectTo = route.page === "redirect" ? route.to : null;

  useEffect(() => {
    if (token && session === null) {
      clearToken();
      setToken("");
    }
  }, [session, token]);

  useEffect(() => {
    if (redirectTo) navigate(redirectTo, true);
  }, [navigate, redirectTo]);

  function expire(role: "staff" | "customer") {
    clearToken();
    setToken("");
    navigate(loginPathForRole(role), true);
  }

  async function signOut(role: "staff" | "customer") {
    try {
      await logout({ token });
    } finally {
      expire(role);
    }
  }

  if (route.page === "loading" || route.page === "redirect") {
    return (
      <main className="grid min-h-screen place-items-center">
        <Loader2 className="size-7 animate-spin text-muted-foreground" />
      </main>
    );
  }

  if (route.page === "staff-login" || route.page === "customer-login" || route.page === "customer-register") {
    return (
      <AuthPage
        page={route.page}
        onNavigate={(path) => navigate(path)}
        onSignedIn={(nextToken) => {
          storeToken(nextToken);
          setToken(nextToken);
        }}
      />
    );
  }

  if (route.page === "customer-home" && session?.role === "customer") {
    return <SessionBoundary key={token} onExpired={() => expire("customer")}><CustomerPortal token={token} email={session.email} onLogout={() => signOut("customer")} /></SessionBoundary>;
  }

  if (route.page === "staff-home" && session?.role === "staff") {
    return <SessionBoundary key={token} onExpired={() => expire("staff")}><StaffWorkspace token={token} onLogout={() => signOut("staff")} /></SessionBoundary>;
  }

  return (
    <main className="grid min-h-screen place-items-center">
      <Loader2 className="size-7 animate-spin text-muted-foreground" />
    </main>
  );
}
