import type { Ticket } from "@/lib/types";
import type { Id } from "@convex/_generated/dataModel";
import { TicketDetailPanel, type DetailNavigation, type StaffDetailActions } from "./ticket-detail-panel";

export function StaffTicketDialog(props: DetailNavigation & StaffDetailActions & {
  ticket: Ticket | null | undefined;
  ticketId: Id<"tickets"> | null;
}) {
  return <TicketDetailPanel {...props} role="staff" />;
}
