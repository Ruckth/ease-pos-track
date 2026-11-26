import { useId, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { localizeError, useI18n } from "@/lib/i18n";
import type { Id } from "@convex/_generated/dataModel";
import type { Ticket } from "@/lib/types";
import { useConversation } from "./adapters/conversation";

type Props = { ticket: Ticket } & ({ role: "staff"; children?: never } | { role: "customer"; children: ReactNode });

export function TicketConversation(props: Props) {
  if (props.ticket.origin !== "customer" || props.ticket.lifecycle !== "active") return props.children;
  if (props.role === "customer") return <ConversationThread key={props.ticket._id} {...props} />;
  return <ConversationDisclosure key={props.ticket._id} {...props} />;
}

function ConversationDisclosure(props: Extract<Props, { role: "staff" }>) {
  const { t } = useI18n();
  const [open, setOpen] = useState(props.ticket.status === "waiting");
  // Preserve the draft while collapsing this section. Subscribe only after first opening it.
  const [visited, setVisited] = useState(open);
  return <section className="space-y-2 rounded-lg border border-transparent bg-muted/40 p-3">
    <button type="button" className="min-h-10 w-full text-left font-semibold underline-offset-4 hover:underline"
      aria-expanded={open} onClick={() => { setVisited(true); setOpen(!open); }}>
      {t(props.ticket.status !== "done" && !open ? "askCustomer" : "ticketConversation")}
    </button>
    {visited && <div hidden={!open}><ConversationThread {...props} /></div>}
  </section>;
}

function ConversationThread({ ticket, role, children }: Props) {
  const { t, formatDate } = useI18n();
  const historyId = useId();
  const messageId = useId();
  const [historyOpen, setHistoryOpen] = useState<boolean>();
  const [answeredQuestion, setAnsweredQuestion] = useState<Id<"ticketMessages">>();
  const [body, setBody] = useState("");
  const [draftQuestion, setDraftQuestion] = useState<Id<"ticketMessages">>();
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const writing = useRef(false);
  const attempt = useRef<{ requestId: string; body: string; replyTo?: string } | null>(null);
  const waiting = ticket.status === "waiting";
  const { messages, send } = useConversation(ticket._id, role === "staff" || waiting || historyOpen !== undefined || Boolean(body));
  const latest = messages.results[0];
  const replyTo = role === "customer" && latest?.role === "staff" ? latest._id : undefined;
  const canSend = role === "staff" ? ticket.status !== "done" : waiting && Boolean(replyTo) && answeredQuestion !== replyTo;

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
      setAnsweredQuestion(draftQuestion);
      attempt.current = null;
    } catch (err) {
      setError(localizeError(err, t));
    } finally {
      setSending(false);
      writing.current = false;
    }
  }
  const pendingQuestion = role === "customer" && canSend ? latest : undefined;
  const history = pendingQuestion ? messages.results.slice(1) : messages.results;
  const loading = messages.status === "LoadingFirstPage";
  const historyContent = (role === "staff" || historyOpen) && (loading ? <p role="status">{t("loadingWorkspace")}</p> : <>
    {history.length ? <ol className="space-y-3">
      {history.map(message => <Message key={message._id} message={message} />)}
    </ol> : <p className="text-sm text-muted-foreground">{t("noTicketMessages")}</p>}
    {messages.status !== "Exhausted" && <Button variant="outline" size="sm" disabled={messages.status === "LoadingMore"} onClick={() => messages.loadMore(10)}>{t(role === "staff" ? "olderMessages" : "loadOlderMessages")}</Button>}
  </>);
  const composer = (canSend || body) && <form className="space-y-2" onSubmit={submit}>
    <label htmlFor={messageId} className="block text-sm font-medium">{t(role === "staff" ? "questionLabel" : "replyLabel")}</label>
    <Textarea id={messageId} className="min-h-16" maxLength={2000} required disabled={sending} value={body}
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
  </form>;
  const feedback = <>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {sent && !pendingQuestion && <p role="status" className="text-sm">{t(role === "staff" ? "questionSent" : "replySent")}</p>}
  </>;
  if (role === "staff") return <div className="space-y-3">
    {historyContent}
    {!loading && composer}
    {feedback}
  </div>;
  return <>
    {(pendingQuestion || body || error || sent || (waiting && latest?.role === "customer")) && <section
      aria-label={t("ticketConversation")} className="space-y-3 rounded-lg border bg-muted/40 p-3">
      {pendingQuestion && <div>
        <p className="text-sm font-semibold">{t("staffQuestion")}</p>
        <p className="text-xs text-muted-foreground">{formatDate(pendingQuestion._creationTime)}</p>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm">{pendingQuestion.body}</p>
      </div>}
      {composer}
      {waiting && latest?.role === "customer" && !sent && <p className="text-sm">{t("replyWithTeam")}</p>}
      {feedback}
    </section>}
    {children}
    {(!waiting || history.length > 0 || historyOpen) && <section className="rounded-lg bg-muted/40 px-3">
      <button type="button" className="w-full text-left font-semibold underline-offset-4 hover:underline"
        aria-controls={historyId} aria-expanded={Boolean(historyOpen)} onClick={() => setHistoryOpen(!historyOpen)}>
        {t(pendingQuestion ? "olderMessages" : "ticketConversation")}
      </button>
      <div id={historyId} hidden={!historyOpen} className="space-y-3 pb-3">{historyContent}</div>
    </section>}
  </>;
}

function Message({ message }: { message: ReturnType<typeof useConversation>["messages"]["results"][number] }) {
  const { t, formatDate } = useI18n();
  return <li className="border-l-2 pl-3">
    <p className="text-xs text-muted-foreground">{t(message.role === "staff" ? "staffQuestion" : "customerReply")} · {formatDate(message._creationTime)}</p>
    <p className="whitespace-pre-wrap break-words text-sm">{message.body}</p>
  </li>;
}
