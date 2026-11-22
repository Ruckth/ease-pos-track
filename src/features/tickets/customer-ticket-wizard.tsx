import type { DisposableTicketDraft } from "./draft";
import { TicketComposer } from "./ticket-composer";
import type { Id } from "@convex/_generated/dataModel";

/** Keep the entry point while both roles now use the same single form. */
export function CustomerTicketWizard(props: {
  draftOwner: DisposableTicketDraft; active: boolean; onSubmitted: (id?: Id<"tickets">) => void;
}) {
  return <TicketComposer {...props} role="customer" />;
}
