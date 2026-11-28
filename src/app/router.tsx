import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
  RouterProvider,
  useLocation,
  useRouteContext,
} from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { WorkspaceError } from "@/components/error-boundary";
import { AppToaster } from "@/components/ui/sonner";
import { CustomerJoinPage, CustomerRecoverPage, CustomerSignInPage, PendingIdentityPage, StaffInvitePage, StaffSignInPage } from "@/components/auth-screens";
import { APP_PATHS, homePathForRole, loginPathForRole, normalizePathname } from "@/lib/app-routes";
import { useI18n } from "@/lib/i18n";
import type { SessionRole } from "@/lib/session";
import {
  currentInvitation, guardSession, userIsSigningOut, syncInvitation, takeReturnTarget, useAuthState, useLeave, type AuthState,
} from "./auth-store";
import { useSessionActions } from "./adapter";
import { guardRedirect } from "./route-guards";
import { customerWorkspaceSearch, parseWorkspaceSearch, staffWorkspaceSearch, stringifyWorkspaceSearch } from "./workspace-search";

export type RouterContext = { auth: AuthState };

const RecoveryCodePanel = lazy(() => import("@/components/account-dialogs").then(m => ({ default: m.RecoveryCodePanel })));

function Pending({ session = false }: { session?: boolean }) {
  const { t } = useI18n();
  return <main className="aurora-canvas flex min-h-screen flex-col items-center justify-center gap-3" role="status">
    <Loader2 aria-hidden="true" className="size-7 motion-safe:animate-spin text-muted-foreground" /><span>{t(session ? "checkingSession" : "loadingWorkspace")}</span>
  </main>;
}

function focusHeading(node: HTMLHeadingElement | null) { node?.focus(); }

/**
 * Principal-wide pages that replace whatever the URL would render: a pending
 * Google identity outside its invitation, and a customer who must save a
 * recovery code first. Both mirror main's shell without changing the URL.
 */
function Gate({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const { auth } = useRouteContext({ from: rootRoute.id });
  const pathname = useLocation({ select: location => normalizePathname(location.pathname) });
  const leave = useLeave();
  if (auth.status !== "signed-in") return children;
  const { viewer } = auth;
  if (viewer.kind === "pending" && pathname !== APP_PATHS.staffInvite && pathname !== APP_PATHS.customerJoin) {
    return <PendingIdentityPage email={viewer.email} googleSubject={viewer.googleSubject} onSignOut={() => leave(APP_PATHS.staffLogin)} />;
  }
  if (viewer.kind === "customer" && viewer.recoveryEnrollmentRequired) {
    return <main className="aurora-canvas grid min-h-screen place-items-center px-4 py-8">
      <div className="aurora-ticket w-full max-w-lg space-y-5 p-5 sm:p-7">
        <h1 className="text-xl font-semibold" tabIndex={-1} ref={focusHeading}>{t("recoveryEnrollmentTitle")}</h1>
        <p className="text-sm text-muted-foreground">{t("recoveryEnrollmentDescription")}</p>
        <Suspense fallback={<Pending />}><RecoveryCodePanel hasCode={!viewer.needsRecoveryCode} requireConfirmation /></Suspense>
        <Button type="button" variant="outline" onClick={() => void leave(APP_PATHS.customerLogin)}>{t("signOut")}</Button>
      </div>
    </main>;
  }
  return children;
}

function UnavailableRoute() {
  const { t } = useI18n();
  const path = useLocation({ select: location => location.pathname });
  const customer = path.startsWith("/customer/");
  useEffect(() => { document.title = t("pageUnavailable"); }, [t]);
  return <main className="aurora-canvas grid min-h-screen place-items-center px-4">
    <section className="aurora-panel space-y-3 p-6">
      <h1 ref={focusHeading} tabIndex={-1} className="text-xl font-semibold">{t("pageUnavailable")}</h1>
      <a className="text-primary underline" href={customer ? APP_PATHS.customerLogin : APP_PATHS.staffLogin}>{t(customer ? "customerSignIn" : "staffSignIn")}</a>
    </section>
  </main>;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  // One guard for every location, unknown paths included.
  beforeLoad: ({ context, location }) => {
    const session = guardSession(context.auth);
    const invitation = syncInvitation(location.pathname, location.hash);
    const href = guardRedirect(location.pathname, location.searchStr, session, {
      invitation: Boolean(invitation),
      takeStoredReturn: takeReturnTarget,
    });
    if (href) throw redirect({ href, replace: true });
  },
  component: () => <Gate><Outlet /></Gate>,
  notFoundComponent: () => <Gate><UnavailableRoute /></Gate>,
});

/**
 * Guards already redirected; this narrows the context for the workspace. A
 * pending identity stays on the URL behind the Gate, so it gets no viewer.
 */
function requireRole(auth: AuthState, role: SessionRole) {
  if (auth.status !== "signed-in" || (auth.viewer.kind !== role && auth.viewer.kind !== "pending")) {
    throw redirect({ href: auth.status === "signed-in" && auth.viewer.kind !== "pending" ? homePathForRole(auth.viewer.kind) : loginPathForRole(role), replace: true });
  }
  return { viewer: auth.viewer.kind === role ? auth.viewer : null };
}

const authSearch = z.object({ redirect: z.string().max(2048).optional().catch(undefined) });

function StaffLogin() {
  return <StaffSignInPage />;
}

declare module "@tanstack/react-router" {
  interface HistoryState { customerUsername?: string }
}

function CustomerLogin() {
  const username = useLocation({ select: location => location.state.customerUsername });
  const navigate = customerLoginRoute.useNavigate();
  return <CustomerSignInPage initialUsername={username} onForgotPassword={() => void navigate({ to: APP_PATHS.customerRecover, search: true })}
    onReturnToJoin={currentInvitation() ? value => void navigate({ to: APP_PATHS.customerJoin, state: { customerUsername: value } }) : undefined} />;
}

function CustomerRecover() {
  const navigate = customerRecoverRoute.useNavigate();
  return <CustomerRecoverPage onSignIn={() => void navigate({ to: APP_PATHS.customerLogin, search: true })} />;
}

function CustomerJoin() {
  const username = useLocation({ select: location => location.state.customerUsername });
  const navigate = customerJoinRoute.useNavigate();
  const { auth } = customerJoinRoute.useRouteContext();
  const { signOut } = useSessionActions();
  return <CustomerJoinPage initialUsername={username} invitation={currentInvitation()} signedInAs={auth.status === "signed-in" ? auth.viewer.kind : null}
    onSignOut={signOut}
    onExistingAccount={value => void navigate({ to: APP_PATHS.customerLogin, state: { customerUsername: value } })}
    onDone={projectKey => void navigate({ to: APP_PATHS.customerHome, search: projectKey ? { project: projectKey } : {} })} />;
}

function StaffInvite() {
  const { auth } = staffInviteRoute.useRouteContext();
  const leave = useLeave();
  return <StaffInvitePage pending={auth.status === "signed-in" && auth.viewer.kind === "pending"} onSignOut={() => leave(APP_PATHS.staffLogin)} />;
}

const unavailableRoute = createRoute({ getParentRoute: () => rootRoute, path: "$", component: UnavailableRoute });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: APP_PATHS.root, component: Pending });
const staffLoginRoute = createRoute({ getParentRoute: () => rootRoute, path: APP_PATHS.staffLogin, validateSearch: authSearch, component: StaffLogin });
const staffInviteRoute = createRoute({ getParentRoute: () => rootRoute, path: APP_PATHS.staffInvite, component: StaffInvite });
const customerLoginRoute = createRoute({ getParentRoute: () => rootRoute, path: APP_PATHS.customerLogin, validateSearch: authSearch, component: CustomerLogin });
const customerRecoverRoute = createRoute({ getParentRoute: () => rootRoute, path: APP_PATHS.customerRecover, validateSearch: authSearch, component: CustomerRecover });
const customerJoinRoute = createRoute({ getParentRoute: () => rootRoute, path: APP_PATHS.customerJoin, component: CustomerJoin });

// No pendingComponent: the workspace owns the draft and must stay mounted.
// The layout keeps one workspace instance across `/staff` and its T3 settings.
const staffRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: APP_PATHS.staffHome,
  validateSearch: staffWorkspaceSearch,
  beforeLoad: ({ context }) => requireRole(context.auth, "staff"),
  component: lazyRouteComponent(() => import("./staff-entry"), "StaffEntry"),
});
const staffHomeRoute = createRoute({ getParentRoute: () => staffRoute, path: "/" });
const staffT3SettingsRoute = createRoute({
  getParentRoute: () => staffRoute,
  // Signed T3 kits link to APP_PATHS.staffT3Settings; tests pin the full path.
  path: "settings/t3",
});
const staffLineSettingsRoute = createRoute({
  getParentRoute: () => staffRoute,
  path: "settings/line",
  validateSearch: (search: Record<string, unknown>) => ({
    bot: typeof search.bot === "string" && /^[a-z0-9]{1,64}$/.test(search.bot) ? search.bot : undefined,
  }),
});
const customerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: APP_PATHS.customerHome,
  validateSearch: customerWorkspaceSearch,
  beforeLoad: ({ context }) => requireRole(context.auth, "customer"),
  component: lazyRouteComponent(() => import("./customer-entry"), "CustomerEntry"),
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  unavailableRoute,
  staffLoginRoute,
  staffInviteRoute,
  customerLoginRoute,
  customerRecoverRoute,
  customerJoinRoute,
  staffRoute.addChildren([staffHomeRoute, staffT3SettingsRoute, staffLineSettingsRoute]),
  customerRoute,
]);

export const router = createRouter({
  routeTree,
  defaultErrorComponent: WorkspaceError,
  scrollRestoration: true,
  context: { auth: { status: "signed-out" } },
  parseSearch: parseWorkspaceSearch,
  stringifySearch: stringifyWorkspaceSearch,
});

declare module "@tanstack/react-router" {
  interface Register { router: typeof router }
}

/**
 * Renders routes only once the session is settled, so guards never bounce a
 * valid deep link while the session is still being validated.
 */
export function AppRouter() {
  const auth = useAuthState();
  const { t } = useI18n();
  const [expired, setExpired] = useState(() => new URLSearchParams(window.location.search).get("expired") === "1");
  const previous = useRef<AuthState | null>(null);
  const pathname = useSyncExternalStore(router.history.subscribe, () => router.history.location.pathname);
  const customerRoute = pathname === APP_PATHS.customerHome || pathname.startsWith(APP_PATHS.customerHome + "/");
  const viewer = auth !== "loading" && auth.status === "signed-in" ? auth.viewer : undefined;
  const customerTheme = normalizePathname(pathname) === APP_PATHS.customerJoin
    || (viewer && viewer.kind !== "pending" ? viewer.kind === "customer" : customerRoute);

  useEffect(() => {
    if (!viewer || viewer.kind === "pending") return;
    if (pathname === APP_PATHS.customerHome) document.title = t("yourTickets");
    if (pathname === APP_PATHS.staffHome) document.title = t("internalBoard");
    if (pathname === APP_PATHS.staffT3Settings) document.title = "T3 Code";
    if (pathname === APP_PATHS.staffLineSettings) document.title = "LINE";
  }, [pathname, viewer, t]);

  // Portalled dialogs, drag previews and native form controls share the workspace palette.
  useLayoutEffect(() => {
    document.documentElement.classList.toggle("dark", !customerTheme);
  }, [customerTheme]);

  useEffect(() => {
    if (auth === "loading") return;
    const before = previous.current;
    previous.current = auth;
    if (auth.status === "signed-in") setExpired(false);
    else if (before?.status === "signed-in" && !userIsSigningOut()) setExpired(true);
    if (before !== null && before !== auth) void router.invalidate();
  }, [auth]);

  return (
    <>
      {expired && auth !== "loading" && auth.status === "signed-out" &&
        (pathname === APP_PATHS.staffLogin || pathname === APP_PATHS.customerLogin) &&
        <p role="status" className="bg-muted px-4 py-2 text-center text-sm">{t("sessionExpired")}</p>}
      <AppToaster theme={customerTheme ? "light" : "dark"} />
      {auth === "loading" ? <Pending session /> : <RouterProvider router={router} context={{ auth }} />}
    </>
  );
}
