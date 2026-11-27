import { getRouteApi } from "@tanstack/react-router";
import { CustomerPortal } from "@/features/tickets/customer-portal";
import { TicketReplyDraftProvider } from "@/features/tickets/reply-drafts";
import { loginPathForRole } from "@/lib/app-routes";
import { useLeave, useSessionExpiry } from "./auth-store";
import { SessionBoundary } from "./session-boundary";

const route = getRouteApi("/customer");

/** Lazy customer chunk, independent of the staff board. */
export function CustomerEntry() {
  const { viewer } = route.useRouteContext();
  const leave = useLeave();
  const onExpired = useSessionExpiry(loginPathForRole("customer"));
  if (viewer?.kind !== "customer") return null;
  const onLogout = () => leave(loginPathForRole("customer"));
  return (
    <SessionBoundary key={viewer.customerId} onExpired={onExpired}>
      <TicketReplyDraftProvider>
        <CustomerPortal viewer={viewer} onLogout={onLogout} />
      </TicketReplyDraftProvider>
    </SessionBoundary>
  );
}
