import { SessionBoundary } from "./session-boundary";
import { AuthPage } from "@/components/auth-screens";
import { loginPathForRole, resolveAppRoute } from "@/lib/app-routes";
import { clearToken, getStoredToken, storeToken } from "@/lib/session";
import { useSession } from "./adapter";
import { Loader2 } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";

const StaffWorkspace = lazy(() => import("@/features/tickets/staff-workspace").then(m => ({ default: m.StaffWorkspace })));
const CustomerPortal = lazy(() => import("@/features/tickets/customer-portal").then(m => ({ default: m.CustomerPortal })));

function LoadingPage() {
  const { t } = useI18n();
  return <main className="aurora-canvas grid min-h-screen place-items-center" role="status">
    <Loader2 aria-hidden="true" className="size-7 animate-spin text-muted-foreground" /><span className="sr-only">{t("loadingWorkspace")}</span>
  </main>;
}

function useAppPathname() {
  const [pathname, setPathname] = useState(() => window.location.pathname);

  useEffect(() => {
    const updatePathname = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", updatePathname);
    return () => window.removeEventListener("popstate", updatePathname);
  }, []);

  const navigate = useCallback((path: string, replace = false) => {
    if (window.location.pathname + window.location.search === path) return;
    window.history[replace ? "replaceState" : "pushState"](null, "", path);
    setPathname(window.location.pathname);
  }, []);

  return { pathname, navigate };
}

/** Routes by both URL namespace and the server-validated session role. */
export function AppShell() {
  return <Suspense fallback={<LoadingPage />}><RoutedApp /></Suspense>;
}

function RoutedApp() {
  const [token, setToken] = useState(getStoredToken);
  const { pathname, navigate } = useAppPathname();
  const { logout, session } = useSession(token);
  const route = resolveAppRoute(
    pathname,
    token && session === undefined
      ? "loading"
      : session?.role ?? "signed-out",
  );
  const dark = session?.role ? session.role === "staff" : pathname.startsWith("/staff");
  useLayoutEffect(() => { document.documentElement.classList.toggle("dark", dark); }, [dark]);
  const redirectTo = route.page === "redirect" ? route.to : null;

  useEffect(() => {
    if (token && session === null) {
      clearToken();
      setToken("");
    }
  }, [session, token]);

  useEffect(() => {
    if (!redirectTo) return;
    const sameRole = pathname.split("/")[1] === redirectTo.split("/")[1];
    navigate(redirectTo + (sameRole ? window.location.search : ""), true);
  }, [navigate, pathname, redirectTo]);

  function expire(role: "staff" | "customer") {
    clearToken();
    setToken("");
    void import("sonner").then(({ toast }) => toast.dismiss());
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
    return <LoadingPage />;
  }

  if (route.page === "staff-login" || route.page === "customer-login" || route.page === "customer-register") {
    return (
      <AuthPage
        page={route.page}
        onNavigate={(path) => navigate(path + (path.split("/")[1] === pathname.split("/")[1] ? window.location.search : ""))}
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

  return <LoadingPage />;
}
