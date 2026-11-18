import type { DisposableTicketDraft } from "./draft";
import { TicketComposer } from "./ticket-composer";
import type { Id } from "@convex/_generated/dataModel";

export function SubmitTicket({ onSubmissionComplete, ...props }: {
  token: string; draftOwner: DisposableTicketDraft; active: boolean; onSubmissionComplete: (id?: Id<"tickets">) => void;
}) {
  return <TicketComposer {...props} role="staff" onSubmitted={onSubmissionComplete} />;
}
