import type { DisposableTicketDraft } from "./draft";
import { TicketComposer } from "./ticket-composer";
import type { Id } from "@convex/_generated/dataModel";

/** Both the direct form and the optional guide use the shared Ticket draft. */
export function CustomerTicketWizard(props: {
  draftOwner: DisposableTicketDraft; active: boolean; onSubmitted: (id?: Id<"tickets">) => void;
}) {
  return <TicketComposer {...props} role="customer" />;
}
