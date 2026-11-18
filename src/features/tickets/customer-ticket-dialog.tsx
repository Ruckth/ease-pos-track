import type { Id } from "@convex/_generated/dataModel";
import { useWorkspaceTicket } from "./adapter";
import { TicketDetailPanel, type DetailNavigation } from "./ticket-detail-panel";

export function CustomerTicketDialog({ token, projectId, ticketId, ...navigation }: DetailNavigation & {
  token: string;
  ticketId: Id<"tickets"> | null;
  projectId: Id<"projects"> | undefined;
}) {
  const ticket = useWorkspaceTicket(token, ticketId, projectId);
  return <TicketDetailPanel {...navigation} role="customer" token={token} ticketId={ticketId} ticket={ticket} />;
}
