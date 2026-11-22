import type { Ticket } from "@/lib/types";
import { TicketDetailPanel, type DetailNavigation, type StaffDetailActions } from "./ticket-detail-panel";

export function StaffTicketDialog(props: DetailNavigation & StaffDetailActions & {
  ticket: Ticket | null | undefined;
  ticketId: string | null;
}) {
  return <TicketDetailPanel {...props} role="staff" />;
}
