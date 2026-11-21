import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
  RouterProvider,
} from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { Toaster } from "sonner";
import { z } from "zod";
import { AuthPage } from "@/components/auth-screens";
import { APP_PATHS, loginPathForRole } from "@/lib/app-routes";
import type { SessionRole } from "@/lib/session";
import { authStore, useAuthState, type AuthState } from "./auth-store";
import { guardRedirect } from "./route-guards";
import {
  customerWorkspaceSearch,
  parseWorkspaceSearch,
  staffWorkspaceSearch,
  stringifyWorkspaceSearch,
} from "./workspace-search";

export type RouterContext = { auth: AuthState };

function Pending() {
  return (
    <main className="grid min-h-screen place-items-center">
      <Loader2 className="size-7 animate-spin text-muted-foreground" />
    </main>
  );
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  // One guard for every location, unknown paths included.
  beforeLoad: ({ context, location }) => {
    const href = guardRedirect(location.pathname, location.searchStr, context.auth);
    if (href) throw redirect({ href, replace: true });
  },
  component: Outlet,
  notFoundComponent: Pending,
});

/** Guards already redirected; this narrows the context for the workspace. */
function requireRole(auth: AuthState, role: SessionRole) {
  if (auth.status !== "signed-in" || auth.role !== role) throw redirect({ href: loginPathForRole(role), replace: true });
  return { session: auth };
}

const authSearch = z.object({ redirect: z.string().max(2048).optional().catch(undefined) });
const signIn = (token: string) => authStore.signIn(token);

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: APP_PATHS.root, component: Pending });
const staffLoginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: APP_PATHS.staffLogin,
  validateSearch: authSearch,
  component: () => <AuthPage page="staff-login" onSignedIn={signIn} />,
});
const customerLoginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: APP_PATHS.customerLogin,
  validateSearch: authSearch,
  component: () => <AuthPage page="customer-login" onSignedIn={signIn} />,
});
const customerRegisterRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: APP_PATHS.customerRegister,
  validateSearch: authSearch,
  component: () => <AuthPage page="customer-register" onSignedIn={signIn} />,
});
// No pendingComponent: the workspace owns the draft and must stay mounted.
const staffRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: APP_PATHS.staffHome,
  validateSearch: staffWorkspaceSearch,
  beforeLoad: ({ context }) => requireRole(context.auth, "staff"),
  component: lazyRouteComponent(() => import("./staff-entry"), "StaffEntry"),
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
  staffLoginRoute,
  customerLoginRoute,
  customerRegisterRoute,
  staffRoute,
  customerRoute,
]);

export const router = createRouter({
  routeTree,
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
 * valid deep link while the token is still being validated.
 */
export function AppRouter() {
  const auth = useAuthState();
  const settled = useRef<AuthState | null>(null);

  useEffect(() => {
    if (auth === "loading") return;
    const previous = settled.current;
    settled.current = auth;
    if (previous === null || previous === auth) return;
    const href = authStore.takeAfterSignOut();
    void (href && auth.status === "signed-out" ? router.navigate({ href, replace: true, ignoreBlocker: true }) : router.invalidate());
  }, [auth]);

  return (
    <>
      <Toaster richColors position="bottom-right" />
      {auth === "loading" ? <Pending /> : <RouterProvider router={router} context={{ auth }} />}
    </>
  );
}
