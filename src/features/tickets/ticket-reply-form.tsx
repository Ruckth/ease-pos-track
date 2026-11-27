import { FileCode2, Link2, Paperclip, Send, X } from "lucide-react";
import { lazy, Suspense, useId, useRef, useState, useSyncExternalStore, type FormEvent, type RefObject } from "react";
import { toast } from "sonner";
import { useAccessToken } from "@/app/adapter";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { localizeError, useI18n } from "@/lib/i18n";
import type { Ticket } from "@/lib/types";
import { IMAGE_SOURCE_BYTES } from "../../../shared/image-optimization";
import { validateFiles } from "../../../shared/media-policy";
import { MEDIA_POLICY } from "../../../shared/ticket-contracts";
import { MAX_TICKET_REPLY_LINK_LENGTH, normalizeTicketReplyUrl } from "../../../shared/ticket-reply-link";
import { useDraftAdapter, useTicketCapabilities } from "./adapter";
import type { useConversation, TicketMessage as Message } from "./adapters/conversation";
import { useConversationPages } from "./adapters/pages";
import type { DraftSnapshot } from "./draft";
import type { ReplyLink, TicketReplyDraft } from "./reply-drafts";

const TicketPages = lazy(() => import("./ticket-pages").then(module => ({ default: module.TicketPages })));

const replyNoReceiptErrors = new Set([
  "INVALID_INPUT", "PAGE_UNAVAILABLE", "TICKET_RESOLVED", "VERSION_CONFLICT",
]);

export function TicketReplyForm({ draft, state, ticket, role, writable, textarea, send }: {
  draft: TicketReplyDraft; state: DraftSnapshot; ticket: Ticket; role: Message["role"]; writable: boolean;
  textarea: RefObject<HTMLTextAreaElement | null>; send: ReturnType<typeof useConversation>["send"];
}) {
  const { t, formatDate } = useI18n();
  const { createUploadIntent } = useDraftAdapter();
  const accessToken = useAccessToken();
  const mediaEnabled = useTicketCapabilities()?.mediaEnabled === true;
  const messageId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const { owner } = draft;
  const { replyTo, link, requestReply } = useSyncExternalStore(draft.subscribe, draft.getSelection);
  const setLink = (next?: ReplyLink) => draft.update({ link: next });
  const [linkField, setLinkField] = useState<string>();
  const [pickingPage, setPickingPage] = useState(false);
  const [publishingPage, setPublishingPage] = useState(false);
  const [pageUploadBusy, setPageUploadBusy] = useState(false);
  const [sent, setSent] = useState<"replySent" | "questionSent">();
  const pages = useConversationPages(ticket._id, role === "staff" && mediaEnabled && (pickingPage || link?.kind === "page"));
  const progress = state.progress;
  const busy = progress !== null;
  const locked = busy || state.retryLocked;
  const canEdit = writable && !locked;
  const canSubmit = writable || state.retryLocked;
  const hasReply = Boolean(state.description.trim() || link || state.items.length);
  const quoteLabel = replyTo && (replyTo.link?.kind === "page" ? replyTo.link.title : replyTo.body || replyTo.link?.url || t("threadReply"));

  function addFiles(files: FileList) {
    if (!canEdit || !mediaEnabled || !files.length) return;
    try {
      const next = Array.from(files);
      if (next.some(file => /\.html?$/i.test(file.name))) throw new Error("IMAGE_VIDEO_ONLY");
      const pending = [...state.items.map(item => item.file), ...next];
      if (pending.some(file => file.type.startsWith("image/") && file.size > IMAGE_SOURCE_BYTES)) throw new Error("IMAGE_SOURCE_TOO_LARGE");
      // The draft optimizes source images before applying the stored-byte limit.
      validateFiles([...ticket.media, ...pending.map(({ name, type, size }) => ({
        name, type, size: type.startsWith("image/") ? Math.min(size, MEDIA_POLICY.image.maxBytes) : size,
      }))]);
      owner.addFiles(next);
      owner.setError(null);
      setSent(undefined);
    } catch (error) { owner.setError(error); }
  }

  function addLink(value: string) {
    try {
      setLink({ kind: "external", url: normalizeTicketReplyUrl(value) });
      setLinkField(undefined);
      setPickingPage(false);
      owner.setError(null);
      setSent(undefined);
      return true;
    } catch { owner.setError(new Error("INVALID_LINK")); return false; }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit || busy || !hasReply || linkField !== undefined || pickingPage) return;
    setSent(undefined);
    const ok = await owner.submit({
      token: accessToken ?? "",
      mediaEnabled: mediaEnabled && state.items.length > 0,
      createUploadIntent,
      noReceiptErrors: replyNoReceiptErrors,
      createTicket: ({ requestId, description, media, uploadIntentId, uploadIntentSecret }) =>
        send({
          id: ticket._id, expectedVersion: ticket.version, body: description, requestId,
          inReplyTo: replyTo?._id, requestReply: role === "staff" ? requestReply : undefined, link,
          ...(media.length ? { media, uploadIntentId, uploadIntentSecret } : {}),
        }),
      onCleanupError: error => toast.error(localizeError(error, t)),
    });
    if (ok) {
      draft.clear();
      setSent(requestReply ? "questionSent" : "replySent");
    }
  }

  if (!writable && !hasReply && !state.retryLocked) return <p className="text-sm text-muted-foreground">{t("threadResolved")}</p>;
  return <form onSubmit={submit} onKeyDown={event => {
    if (event.key !== "Escape" || publishingPage || (linkField === undefined && !pickingPage)) return;
    event.preventDefault();
    event.stopPropagation();
    setLinkField(undefined);
    setPickingPage(false);
    owner.setError(null);
    textarea.current?.focus();
  }} className="aurora-inset min-w-0 space-y-2 rounded-xl border border-border/70 p-3">
    <label htmlFor={messageId} className="block text-sm font-medium">{t("replyLabel")}</label>
    {quoteLabel && <div className="flex min-w-0 items-center gap-2 rounded-md border-l-2 border-primary/50 bg-muted/60 px-2">
      <p className="line-clamp-2 flex-1 text-xs">{t("threadQuoting", { quote: quoteLabel })}</p>
      <Button type="button" variant="ghost" size="icon" disabled={!canEdit} onClick={() => draft.update({ replyTo: undefined })} aria-label={t("threadRemoveQuote")}><X aria-hidden /></Button>
    </div>}
    <Textarea id={messageId} ref={textarea} className="min-h-16 resize-y" maxLength={2000} placeholder={t("threadWriteReply")} readOnly={!canEdit}
      value={state.description} onChange={event => { owner.setDescription(event.target.value); setSent(undefined); }}
      onPaste={event => {
        if (!canEdit) return;
        const files = event.clipboardData.files;
        if (files.length && mediaEnabled) { event.preventDefault(); addFiles(files); return; }
        const text = event.clipboardData.getData("text").trim();
        if (!state.description && !link && /^https:\/\/\S+$/i.test(text) && addLink(text)) event.preventDefault();
      }} />
    {(link || state.items.length > 0) && <ul className="flex flex-wrap gap-2">
      {link && <li className="flex max-w-full min-w-0 items-center gap-1 rounded-md border bg-background/60 pl-2 text-xs">
        <span className="min-w-0 [overflow-wrap:anywhere]">{link.kind === "external" ? link.url : pages?.find(page => page._id === link.pageId)?.entryPath ?? t("threadHostedPage")}</span>
        <Button type="button" size="icon" variant="ghost" disabled={!canEdit} onClick={() => setLink(undefined)} aria-label={t("threadRemoveLink")}><X aria-hidden /></Button>
      </li>}
      {state.items.map(file => <li key={file.id} className="flex max-w-full min-w-0 items-center gap-1 rounded-md border bg-background/60 pl-2 text-xs">
        {!file.isVideo && <img src={file.previewUrl} width={28} height={28} alt="" className="size-7 rounded object-cover" />}
        <span className="min-w-0 [overflow-wrap:anywhere]">{file.file.name}</span>
        <Button type="button" size="icon" variant="ghost" disabled={!canEdit} aria-label={t("removeFile", { name: file.file.name })}
          onClick={() => owner.remove(file)}><X aria-hidden /></Button>
      </li>)}
    </ul>}
    {linkField !== undefined && <div className="space-y-1">
      <label htmlFor={messageId + "-link"} className="text-xs font-medium">{t("threadLinkAddress")}</label>
      <div className="flex flex-wrap gap-1.5">
        <Input id={messageId + "-link"} value={linkField} type="url" maxLength={MAX_TICKET_REPLY_LINK_LENGTH} placeholder="https://" className="min-w-32 flex-1"
          onChange={event => setLinkField(event.target.value)} onKeyDown={event => {
            if (event.key === "Enter") { event.preventDefault(); addLink(linkField); }
          }} />
        <Button type="button" variant="outline" onClick={() => addLink(linkField)}>{t("threadAddLink")}</Button>
        <Button type="button" variant="ghost" onClick={() => { setLinkField(undefined); owner.setError(null); }}>{t("cancel")}</Button>
      </div>
    </div>}
    {pickingPage && <div className="flex flex-wrap items-center gap-2">
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-medium">
        {t("threadAttachPage")}
        <select className="min-h-11 min-w-0 rounded-md border bg-background px-2 text-sm" value=""
          onChange={event => {
            const page = pages?.find(item => item._id === event.target.value);
            if (!page) return;
            setLink({ kind: "page", pageId: page._id });
            setPickingPage(false);
            owner.setError(null);
            setSent(undefined);
          }}>
          <option value="">{t(!pages ? "syncing" : pages.length ? "threadSelectPage" : "threadPublishFirst")}</option>
          {pages?.map(page => <option key={page._id} value={page._id}>{page.entryPath} · {formatDate(page.publishedAt)}</option>)}
        </select>
      </label>
      <Button type="button" variant="outline" onClick={() => setPublishingPage(true)}>{t("publishPage")}</Button>
      <Button type="button" variant="ghost" onClick={() => setPickingPage(false)}>{t("cancel")}</Button>
    </div>}
    {role === "staff" && publishingPage && <Dialog open title={t("publishPage")} onOpenChange={open => {
      if (!open && !pageUploadBusy) setPublishingPage(false);
    }}>
      <Suspense fallback={<p role="status">{t("syncing")}</p>}>
        <TicketPages ticket={ticket} staff onPublishingChange={setPageUploadBusy} onPublished={pageId => {
          setLink({ kind: "page", pageId });
          setPublishingPage(false);
          setPickingPage(false);
          owner.setError(null);
        }} />
      </Suspense>
    </Dialog>}
    {role === "staff" && <label className="flex min-h-11 items-center gap-2 text-sm text-muted-foreground">
      <input type="checkbox" className="size-4 accent-primary" checked={requestReply} disabled={!canEdit}
        onChange={event => draft.update({ requestReply: event.target.checked })} />{t("threadRequestReply")}
    </label>}
    <div className="flex flex-wrap items-center gap-1">
      {mediaEnabled && <><input ref={fileInput} data-slot="ticket-reply-files" type="file" accept="image/*,video/*" hidden multiple
        onChange={event => { if (event.target.files) addFiles(event.target.files); event.target.value = ""; }} />
        <Button type="button" size="sm" variant="ghost" disabled={!canEdit} onClick={() => fileInput.current?.click()}>
          <Paperclip aria-hidden />{t("threadAddMedia")}
        </Button></>}
      {linkField === undefined && !pickingPage && <>
        <Button type="button" size="sm" variant="ghost" disabled={!canEdit} onClick={() => setLinkField(link?.kind === "external" ? link.url : "")}>
          <Link2 aria-hidden />{t("threadLink")}
        </Button>
        {role === "staff" && mediaEnabled && <Button type="button" size="sm" variant="ghost" disabled={!canEdit} onClick={() => setPickingPage(true)}>
          <FileCode2 aria-hidden />{t("threadAttachPage")}
        </Button>}
      </>}
      <Button type="submit" size="sm" className="ml-auto" disabled={!canSubmit || busy || !hasReply || linkField !== undefined || pickingPage}>
        <Send aria-hidden />{t(requestReply ? "sendQuestion" : "sendReply")}
      </Button>
      {busy && state.items.length > 0 && <Button type="button" variant="ghost" size="sm" onClick={owner.cancel}>{t("cancelUpload")}</Button>}
    </div>
    {state.retryLocked && !busy && <Button type="button" variant="outline" size="sm" onClick={() => {
      if (!window.confirm(t("threadDiscardReplyConfirm"))) return;
      owner.discard();
      draft.clear();
    }}>{t("discardDraft")}</Button>}
    {state.error != null && <p role="alert" className="text-sm text-destructive">{localizeError(state.error, t)}</p>}
    {busy && state.items.length > 0 && <progress className="w-full" aria-label={t("submitting")} value={progress} max={100} />}
    <p role="status" className="text-sm text-muted-foreground">
      {state.retryLocked ? t("threadRetry") : !writable ? t("threadClosed") : sent ? t(sent) : null}
    </p>
  </form>;
}
