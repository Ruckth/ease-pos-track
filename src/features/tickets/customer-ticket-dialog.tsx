import type { Ticket } from "@/lib/types";
import { TicketDetailPanel, type DetailNavigation } from "./ticket-detail-panel";

export function CustomerTicketDialog(props: DetailNavigation & {
  ticket: Ticket | null | undefined;
  ticketId: string | null;
}) {
  return <TicketDetailPanel {...props} role="customer" />;
}
