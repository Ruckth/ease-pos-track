import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { localizeError, useI18n } from "@/lib/i18n";
import type { Id } from "@convex/_generated/dataModel";
import type { Ticket } from "@/lib/types";
import { useConversation } from "./adapters/conversation";

type Props = { ticket: Ticket; role: "staff" | "customer" };

export function TicketConversation(props: Props) {
  if (props.ticket.origin !== "customer" || props.ticket.lifecycle !== "active") return null;
  return <ConversationDisclosure key={props.ticket._id} {...props} />;
}

function ConversationDisclosure(props: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(props.ticket.status === "waiting");
  // Preserve the draft while collapsing this section. Subscribe only after first opening it.
  const [visited, setVisited] = useState(open);
  return <section className="space-y-2 rounded-lg border border-transparent bg-muted/40 p-3">
    <button type="button" className="min-h-10 w-full text-left font-semibold underline-offset-4 hover:underline"
      aria-expanded={open} onClick={() => { setVisited(true); setOpen(!open); }}>
      {t(props.role === "staff" && props.ticket.status !== "done" && !open ? "askCustomer" : "ticketConversation")}
    </button>
    {visited && <div hidden={!open}><ConversationThread {...props} /></div>}
  </section>;
}

function ConversationThread({ ticket, role }: Props) {
  const { t, formatDate } = useI18n();
  const { messages, send } = useConversation(ticket._id);
  const [body, setBody] = useState("");
  const [draftQuestion, setDraftQuestion] = useState<Id<"ticketMessages">>();
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const writing = useRef(false);
  const attempt = useRef<{ requestId: string; body: string; replyTo?: string } | null>(null);
  const latest = messages.results[0];
  const replyTo = role === "customer" && latest?.role === "staff" ? latest._id : undefined;
  const canSend = role === "staff" ? ticket.status !== "done" : ticket.status === "waiting" && Boolean(replyTo);

  const questionChanged = Boolean(body && role === "customer" && draftQuestion !== replyTo);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (writing.current || !body.trim() || !canSend || questionChanged) return;
    writing.current = true;
    setSending(true);
    setError("");
    if (!attempt.current || attempt.current.body !== body || attempt.current.replyTo !== replyTo) {
      attempt.current = { requestId: crypto.randomUUID(), body, replyTo };
    }
    try {
      await send({ id: ticket._id, expectedVersion: ticket.version, body, requestId: attempt.current.requestId, inReplyTo: draftQuestion });
      setBody("");
      setDraftQuestion(undefined);
      setSent(true);
      attempt.current = null;
    } catch (err) {
      setError(localizeError(err, t));
    } finally {
      setSending(false);
      writing.current = false;
    }
  }
  return <div className="space-y-3">
    {messages.status === "LoadingFirstPage" ? <p role="status">{t("loadingWorkspace")}</p> : <>
      {messages.results.length ? <ol className="space-y-3">
        {messages.results.map(message => <li key={message._id} className="border-l-2 pl-3">
          <p className="text-xs text-muted-foreground">{t(message.role === "staff" ? "staffQuestion" : "customerReply")} · {formatDate(message._creationTime)}</p>
          <p className="whitespace-pre-wrap break-words text-sm">{message.body}</p>
        </li>)}
      </ol> : <p className="text-sm text-muted-foreground">{t("noTicketMessages")}</p>}
      {messages.status !== "Exhausted" && <Button variant="outline" size="sm" disabled={messages.status === "LoadingMore"} onClick={() => messages.loadMore(10)}>{t("olderMessages")}</Button>}
      {role === "customer" && ticket.status === "waiting" && latest?.role === "customer" &&
        <p className="text-sm">{t("replyWithTeam")}</p>}
      {(canSend || body) && <form className="space-y-2" onSubmit={submit}>
        <label htmlFor="ticket-message" className="block text-sm font-medium">{t(role === "staff" ? "questionLabel" : "replyLabel")}</label>
        <Textarea id="ticket-message" className="min-h-16" maxLength={2000} required disabled={sending} value={body}
          onChange={e => {
            if (!body) setDraftQuestion(replyTo);
            setBody(e.target.value);
            setSent(false);
          }} />
        {questionChanged && canSend && <div role="status" className="space-y-2 text-sm">
          <p>{t("newQuestionArrived")}</p>
          <Button type="button" variant="outline" onClick={() => setDraftQuestion(replyTo)}>{t("answerLatestQuestion")}</Button>
        </div>}
        {!canSend && body && <p role="status" className="text-sm">{t("threadClosed")}</p>}
        <Button size="sm" disabled={sending || !canSend || questionChanged || !body.trim()}>{t(role === "staff" ? "sendQuestion" : "sendReply")}</Button>
      </form>}
    </>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {sent && <p role="status" className="text-sm">{t(role === "staff" ? "questionSent" : "replySent")}</p>}
  </div>;
}
