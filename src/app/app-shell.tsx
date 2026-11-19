import { Button } from "@/components/ui/button";
import { SessionBoundary } from "./session-boundary";
import { CustomerJoinPage, CustomerRecoverPage, CustomerSignInPage, PendingIdentityPage, StaffInvitePage, StaffSignInPage } from "@/components/auth-screens";
import { APP_PATHS, homePathForRole, loginPathForRole, resolveAppRoute } from "@/lib/app-routes";
import { useSessionActions, useViewer } from "./adapter";
import { Loader2 } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { readFragmentSecret } from "@/lib/session";

const StaffWorkspace = lazy(() => import("@/features/tickets/staff-workspace").then(m => ({ default: m.StaffWorkspace })));
const RecoveryCodePanel = lazy(() => import("@/components/account-dialogs").then(m => ({ default: m.RecoveryCodePanel })));
const CustomerPortal = lazy(() => import("@/features/tickets/customer-portal").then(m => ({ default: m.CustomerPortal })));

function focusHeading(node: HTMLHeadingElement | null) { node?.focus(); }

function LoadingPage() {
  const { t } = useI18n();
  return <main className="grid min-h-screen place-items-center" role="status">
    <Loader2 aria-hidden="true" className="size-7 animate-spin text-muted-foreground" /><span className="sr-only">{t("loadingWorkspace")}</span>
  </main>;
}

function useAppPathname() {
  function readLocation(previousInvitation = "") {
    const pathname = window.location.pathname;
    const path = pathname.replace(/\/$/, "");
    const invitation = path === APP_PATHS.customerJoin ? readFragmentSecret() : "";
    const inJoinFlow = path === APP_PATHS.customerJoin || path === APP_PATHS.customerLogin || path === APP_PATHS.customerRecover;
    return {
      pathname,
      invitation: inJoinFlow ? invitation || previousInvitation : "",
    };
  }
  const [location, setLocation] = useState(() => readLocation());

  useLayoutEffect(() => {
    if (location.pathname.replace(/\/$/, "") === APP_PATHS.customerJoin && readFragmentSecret()) {
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    }
  }, [location]);
  useEffect(() => {
    const updateLocation = () => setLocation(previous => readLocation(previous.invitation));
    window.addEventListener("popstate", updateLocation);
    window.addEventListener("hashchange", updateLocation);
    return () => {
      window.removeEventListener("popstate", updateLocation);
      window.removeEventListener("hashchange", updateLocation);
    };
  }, []);

  const navigate = useCallback((path: string, replace = false) => {
    if (window.location.pathname + window.location.search === path) return;
    window.history[replace ? "replaceState" : "pushState"](null, "", path);
    setLocation(previous => readLocation(previous.invitation));
  }, []);

  return { ...location, navigate };
}

/** Routes by both URL namespace and the server-validated principal. */
export function AppShell() {
  return <Suspense fallback={<LoadingPage />}><RoutedApp /></Suspense>;
}

function RoutedApp() {
  const { t } = useI18n();
  const viewer = useViewer();
  const { signOut } = useSessionActions();
  const { pathname, invitation, navigate } = useAppPathname();
  const route = resolveAppRoute(pathname, viewer === undefined ? "loading" : viewer === null ? "signed-out" : viewer.kind);
  const redirectTo = route.page === "redirect"
    ? viewer?.kind === "customer" && pathname.replace(/\/$/, "") === APP_PATHS.customerLogin && invitation
      ? APP_PATHS.customerJoin : route.to
    : null;

  useEffect(() => {
    if (!redirectTo) return;
    const sameRole = pathname.split("/")[1] === redirectTo.split("/")[1];
    navigate(redirectTo + (sameRole ? window.location.search : ""), true);
  }, [navigate, pathname, redirectTo]);

  /**
   * Revoke the session, then reload: a full navigation drops every live
   * subscription, cached Ticket data and draft before another account signs in.
   */
  const leave = useCallback(async (path: string) => {
    void import("sonner").then(({ toast }) => toast.dismiss());
    try { await signOut(); } finally { window.location.replace(path); }
  }, [signOut]);

  if (route.page === "loading" || route.page === "redirect") return <LoadingPage />;
  if (route.page === "staff-login") return <StaffSignInPage />;
  if (route.page === "customer-login") return <CustomerSignInPage onForgotPassword={() => navigate(APP_PATHS.customerRecover)}
    onReturnToJoin={invitation ? () => navigate(APP_PATHS.customerJoin) : undefined} />;
  if (route.page === "customer-recover") return <CustomerRecoverPage onSignIn={() => navigate(APP_PATHS.customerLogin)} />;
  if (viewer?.kind === "customer" && viewer.recoveryEnrollmentRequired) {
    return <main className="mx-auto max-w-lg space-y-5 px-4 py-8">
      <h1 className="text-xl font-semibold" tabIndex={-1} ref={focusHeading}>{t("recoveryEnrollmentTitle")}</h1>
      <p className="text-sm text-muted-foreground">{t("recoveryEnrollmentDescription")}</p>
      <RecoveryCodePanel hasCode={!viewer.needsRecoveryCode} requireConfirmation />
      <Button type="button" variant="outline" onClick={() => void leave(APP_PATHS.customerLogin)}>{t("signOut")}</Button>
    </main>;
  }
  if (route.page === "customer-join") {
    return <CustomerJoinPage invitation={invitation} signedInAs={viewer?.kind ?? null} onSignOut={signOut}
      onExistingAccount={() => navigate(APP_PATHS.customerLogin)}
      onDone={() => navigate(homePathForRole("customer"))} />;
  }
  if (route.page === "staff-invite") return <StaffInvitePage pending={viewer?.kind === "pending"} onSignOut={() => leave(APP_PATHS.staffLogin)} />;
  if (route.page === "pending-identity" && viewer?.kind === "pending") {
    return <PendingIdentityPage email={viewer.email} googleSubject={viewer.googleSubject} onSignOut={() => leave(APP_PATHS.staffLogin)} />;
  }
  if (route.page === "customer-home" && viewer?.kind === "customer") {
    return <SessionBoundary key={viewer.customerId} onExpired={() => void leave(loginPathForRole("customer"))}>
      <CustomerPortal viewer={viewer} onLogout={() => leave(loginPathForRole("customer"))} />
    </SessionBoundary>;
  }
  if (route.page === "staff-home" && viewer?.kind === "staff") {
    return <SessionBoundary key={viewer.staffId} onExpired={() => void leave(loginPathForRole("staff"))}>
      <StaffWorkspace viewer={viewer} onLogout={() => leave(loginPathForRole("staff"))}
        t3Settings={route.settings === "t3"} onT3Settings={open => navigate(open ? APP_PATHS.staffT3Settings : APP_PATHS.staffHome)} />
    </SessionBoundary>;
  }
  return <LoadingPage />;
}
