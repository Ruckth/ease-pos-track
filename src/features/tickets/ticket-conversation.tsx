import { ExternalLink, FileCode2, Link2, MessageCircle, Paperclip, PlayCircle } from "lucide-react";
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import type { Id } from "@convex/_generated/dataModel";
import type { MediaItem, Ticket } from "@/lib/types";
import { cn } from "@/lib/utils";
import { TicketReplyForm } from "./ticket-reply-form";
import { useConversation, type TicketMessage as Message } from "./adapters/conversation";
import { DisposableTicketDraft } from "./draft";

type Props = { ticket: Ticket; onOpenMedia: (key: string) => void } & (
  { role: "staff"; children?: never } | { role: "customer"; children: ReactNode }
);

export function TicketConversation(props: Props) {
  if (!props.ticket.hasCustomerOwner || props.ticket.lifecycle !== "active") return props.children;
  return props.role === "customer"
    ? <ConversationThread key={props.ticket._id} {...props} />
    : <ConversationDisclosure key={props.ticket._id} {...props} />;
}

function ConversationDisclosure(props: Extract<Props, { role: "staff" }>) {
  const { t } = useI18n();
  const customerReplied = props.ticket.status !== "done" && props.ticket.latestReply?.role === "customer";
  const [open, setOpen] = useState(props.ticket.status === "waiting" || customerReplied);
  const [visited, setVisited] = useState(open);
  const id = useId();
  return <section className="aurora-inset rounded-xl px-3">
    <Button type="button" variant="ghost" className="w-full justify-start px-0" aria-controls={id}
      aria-expanded={open} onClick={() => { setVisited(true); setOpen(!open); }}>
      <MessageCircle aria-hidden />{t("ticketConversation")}
      {customerReplied && !open && <span className="ml-auto text-xs text-primary">{t("threadCustomerReplied")}</span>}
    </Button>
    <div id={id} hidden={!open} className="pb-3">
      {visited && <ConversationThread {...props} />}
    </div>
  </section>;
}

function ConversationThread({ ticket, role, children, onOpenMedia }: Props) {
  const { t, formatDate } = useI18n();
  const id = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const { messages, send } = useConversation(ticket._id, true);
  const [replyTo, setReplyTo] = useState<Message>();
  const [owner] = useState(() => new DisposableTicketDraft(ticket.projectId));
  const lifetime = useRef({ generation: 0 });
  useEffect(() => {
    const active = lifetime.current;
    const generation = ++active.generation;
    return () => queueMicrotask(() => {
      if (generation === active.generation) owner.dispose();
    });
  }, [owner]);
  const draft = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  const loading = messages.status === "LoadingFirstPage";
  const writable = ticket.status !== "done";
  const canQuote = writable && draft.progress === null && !draft.retryLocked;
  const mediaFromReplies = new Set(ticket.replyMediaKeys ?? []);
  const openingMedia = role === "customer" ? ticket.media.filter(file => !mediaFromReplies.has(file.key)) : [];
  const visibleIds = new Set(messages.results.map(message => message._id));

  function focusReply(message: Message) {
    setReplyTo(message);
    textarea.current?.focus();
  }

  function focusMessage(messageId: Id<"ticketMessages">) {
    const target = list.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);
    target?.focus();
  }

  return <div className="min-w-0 space-y-4">
    {role === "customer" && <article className="aurora-inset min-w-0 space-y-3 rounded-xl p-3 sm:p-4">
      <PostAuthor label={t(ticket.origin === "staff" ? "threadTeam" : "threadYou")} role={ticket.origin} time={formatDate(ticket.createdAt)} />
      {children}
      {openingMedia.length > 0 && <Button type="button" variant="outline" className="h-auto whitespace-normal"
        onClick={() => onOpenMedia(openingMedia[0].key)}>
        <Paperclip aria-hidden />{t("detailMedia", { count: openingMedia.length })}
      </Button>}
    </article>}
    <section aria-labelledby={id} className="space-y-2">
      <h3 id={id} className="text-sm font-semibold">{t("threadReplies")}</h3>
      {loading ? <p className="text-sm text-muted-foreground" role="status">{t("syncing")}</p> : <>
        {(messages.status === "CanLoadMore" || messages.status === "LoadingMore") &&
          <Button type="button" size="sm" variant="outline" disabled={messages.status === "LoadingMore"}
            onClick={() => messages.loadMore(10)}>{t("loadOlderMessages")}</Button>}
        {messages.results.length
          ? <ol ref={list} className="divide-y divide-border/70">
            {[...messages.results].reverse().map(message => <ThreadMessage key={message._id}
              message={message} viewerRole={role} onReply={canQuote ? () => focusReply(message) : undefined}
              onJump={message.inReplyTo && visibleIds.has(message.inReplyTo) ? () => focusMessage(message.inReplyTo!) : undefined}
              onOpenMedia={onOpenMedia} />)}
          </ol>
          : <p className="text-sm text-muted-foreground">{t("noTicketMessages")}</p>}
      </>}
      {!loading && <TicketReplyForm owner={owner} state={draft} ticket={ticket} role={role} writable={writable}
        replyTo={replyTo} clearReply={() => setReplyTo(undefined)} textarea={textarea} send={send} />}
    </section>
  </div>;
}

function PostAuthor({ label, role, time }: { label: string; role: Message["role"]; time: string }) {
  const { t } = useI18n();
  return <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
    <span aria-hidden className={cn("grid size-8 shrink-0 place-items-center rounded-full font-semibold",
      role === "staff" ? "bg-primary/10 text-primary" : "bg-muted text-foreground")}>{[...label][0]}</span>
    <span className="font-semibold">{label}</span>
    {role === "staff" && <span className="text-xs text-muted-foreground">{t("threadStaff")}</span>}
    <span className="ml-auto text-xs text-muted-foreground">{time}</span>
  </div>;
}

function ThreadMessage({ message, viewerRole, onReply, onJump, onOpenMedia }: {
  message: Message; viewerRole: Message["role"]; onReply?: () => void;
  onJump?: () => void; onOpenMedia: (key: string) => void;
}) {
  const { t, formatDate } = useI18n();
  const author = (role: Message["role"]) => t(role === viewerRole && role === "customer" ? "threadYou" : role === "staff" ? "threadTeam" : "threadCustomer");
  const quote = message.quote;
  const quoteText = quote && [
    author(quote.role),
    quote.link?.kind === "page" ? quote.link.title : quote.body || quote.link?.url || (quote.hasMedia && t("feedAttachmentReply")),
  ].filter(Boolean).join(" · ");
  return <li data-message-id={message._id} tabIndex={-1}
    className="min-w-0 space-y-2 py-3 focus-visible:rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
    <PostAuthor label={author(message.role)} role={message.role} time={formatDate(message._creationTime)} />
    <div className="min-w-0 space-y-2 pl-2 sm:pl-10">
      {quoteText && (onJump
        ? <button type="button" onClick={onJump} className="block w-full rounded-md border-l-2 border-primary/40 bg-muted/60 px-2 py-1 text-start text-xs text-muted-foreground hover:text-foreground">
          <span className="line-clamp-2">{quoteText}</span>
        </button>
        : <p className="line-clamp-2 rounded-md border-l-2 border-primary/40 bg-muted/60 px-2 py-1 text-xs text-muted-foreground">{quoteText}</p>)}
      {message.body && <p className="whitespace-pre-wrap break-words text-sm leading-6">{message.body}</p>}
      {message.link && <MessageLink link={message.link} onQuote={onReply} />}
      {message.media.length > 0 && <ul className="flex flex-wrap gap-2" aria-label={t("detailMedia", { count: message.media.length })}>
        {message.media.map(file => <li key={file.key} className="min-w-0 max-w-full">
          <ReplyMedia file={file} open={() => onOpenMedia(file.key)} />
        </li>)}
      </ul>}
      {onReply && <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" onClick={onReply}
        aria-label={t("threadReplyTo", { name: author(message.role), date: formatDate(message._creationTime) })}>
        <MessageCircle aria-hidden />{t("threadReply")}
      </Button>}
    </div>
  </li>;
}

function MessageLink({ link, onQuote }: { link: NonNullable<Message["link"]>; onQuote?: () => void }) {
  const { t } = useI18n();
  const hosted = link.kind === "page";
  const external = link.kind === "external" ? new URL(link.url) : undefined;
  const title = external?.hostname || (link.kind === "page" && link.title) || t("threadHostedPage");
  return <div className={cn("min-w-0 rounded-lg border p-2.5", hosted ? "border-primary/20 bg-primary/5" : "bg-muted/40")}>
    <div className="flex min-w-0 items-start gap-2">
      {hosted ? <FileCode2 className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden /> : <Link2 className="mt-0.5 size-4 shrink-0" aria-hidden />}
      <div className="min-w-0">
        <p className="text-sm font-medium [overflow-wrap:anywhere]">{title}</p>
        <p className="text-xs text-muted-foreground">{t(hosted ? "threadHostedPage" : "threadExternalLink")}</p>
        {external && external.pathname !== "/" && <p className="truncate text-xs text-muted-foreground" title={external.pathname}>{external.pathname}</p>}
      </div>
    </div>
    <div className="flex flex-wrap items-center gap-1">
      {link.url ? <a className={buttonVariants({ variant: "ghost", size: "sm" }) + " min-h-11 max-w-full"}
        href={link.url} target="_blank" rel="noopener noreferrer"
        aria-label={t(hosted ? "openPageNamed" : "threadOpenLinkNamed", { name: title })}>
        {t(hosted ? "openPage" : "threadOpenLink")}<ExternalLink aria-hidden />
      </a> : <p className="py-2 text-xs text-muted-foreground">{t("threadPageUnavailable")}</p>}
      {hosted && link.url && onQuote && <Button type="button" variant="ghost" size="sm" onClick={onQuote} aria-label={t("threadQuoteLinkNamed", { name: title })}>{t("threadQuoteLink")}</Button>}
    </div>
  </div>;
}

function ReplyMedia({ file, open }: { file: MediaItem; open: () => void }) {
  const { t } = useI18n();
  return <Button type="button" variant="outline" className="h-auto max-w-full justify-start whitespace-normal text-start" onClick={open} aria-label={t("threadOpenAttachment", { name: file.name })}>
    {file.type.startsWith("image/") ? <img src={file.url} width={56} height={40} loading="lazy" alt="" className="h-10 w-14 shrink-0 rounded object-cover" />
      : <PlayCircle aria-hidden />}
    <span className="min-w-0 [overflow-wrap:anywhere]">{file.name}</span>
  </Button>;
}
