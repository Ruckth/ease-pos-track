import { getRouteApi } from "@tanstack/react-router";
import { CustomerPortal } from "@/features/tickets/customer-portal";
import { authStore, useSignOut } from "./auth-store";
import { SessionBoundary } from "./session-boundary";

const route = getRouteApi("/customer");

/** Lazy customer chunk, independent of the staff board. */
export function CustomerEntry() {
  const { session } = route.useRouteContext();
  const signOut = useSignOut(session.token, "customer");
  return (
    <SessionBoundary key={session.token} onExpired={() => authStore.clear()}>
      <CustomerPortal token={session.token} email={session.email} onLogout={signOut} />
    </SessionBoundary>
  );
}
