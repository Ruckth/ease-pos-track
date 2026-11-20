import type { Id } from "@convex/_generated/dataModel";
import { useWorkspaceTicket } from "./adapter";
import { TicketDetailPanel, type DetailNavigation } from "./ticket-detail-panel";

export function CustomerTicketDialog({ projectId, ticketId, ...navigation }: DetailNavigation & {
  ticketId: Id<"tickets"> | null;
  projectId: Id<"projects"> | undefined;
}) {
  const ticket = useWorkspaceTicket(ticketId, projectId);
  return <TicketDetailPanel {...navigation} role="customer" ticketId={ticketId} ticket={ticket} />;
}
