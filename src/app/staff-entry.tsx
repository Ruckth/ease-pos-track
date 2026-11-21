import { getRouteApi } from "@tanstack/react-router";
import { StaffWorkspace } from "@/features/tickets/staff-workspace";
import { authStore, useSignOut } from "./auth-store";
import { SessionBoundary } from "./session-boundary";

const route = getRouteApi("/staff");

/** Lazy staff chunk: the board and drag-and-drop never load for customers. */
export function StaffEntry() {
  const { session } = route.useRouteContext();
  const signOut = useSignOut(session.token, "staff");
  return (
    <SessionBoundary key={session.token} onExpired={() => authStore.clear()}>
      <StaffWorkspace token={session.token} onLogout={signOut} />
    </SessionBoundary>
  );
}
