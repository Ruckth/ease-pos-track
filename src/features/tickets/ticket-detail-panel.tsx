import { ArrowLeft, ArrowRight, Maximize2, Minimize2, ChevronDown, ChevronLeft, ChevronRight, Copy, LoaderCircle, LockKeyhole, Paperclip, Pencil, RotateCcw } from "lucide-react";
import { lazy, Suspense, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { toast } from "sonner";
import type { Id } from "@convex/_generated/dataModel";
import { AnnotationList, DescriptionWithTags } from "@/components/annotation-notes";
import type { MediaViewerHandle } from "@/components/media-viewer";
import { statuses, statusMeta } from "@/components/ticket-status";
import { TicketTagEditor } from "@/components/ticket-tag-editor";
import { TicketTagList } from "@/components/ticket-tags";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { localizeError, useI18n } from "@/lib/i18n";
import { staffTicketActions } from "@/lib/staff-ticket-queue";
import { type Annotation, isActiveAnnotation, type Ticket, type TicketStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { formatTicketNumber } from "../../../shared/ticket-numbers";
import type { MessageEvidenceInput } from "../../../shared/ticket-evidence";
import { TicketAssignment } from "@/features/routing/ticket-assignment";
import { TicketConversation, type AvailableMessageEvidence } from "./ticket-conversation";
import { DetailEdit } from "./ticket-detail-edit";
import { useTicketReplyDraft } from "./reply-drafts";
import { TicketHistory } from "./ticket-history";
import { useTicketOperations } from "./use-ticket-operations";
import { TicketReferenceCopy } from "./ticket-reference-copy";
import { TicketUrgencyEdit } from "./ticket-urgency-edit";
import { useStaffCopy } from "@/lib/staff-copy";

const MediaViewer = lazy(() => import("@/components/media-viewer").then(module => ({ default: module.MediaViewer })));
const TicketPages = lazy(() => import("./ticket-pages").then(module => ({ default: module.TicketPages })));
const customerProgress = {
  new: "statusNextNew", acknowledged: "statusNextAcknowledged", in_progress: "statusNextInProgress",
  waiting: "statusNextWaiting", done: "statusNextDone",
} as const;

export type DetailNavigation = {
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  inline?: boolean;
  focusMode?: boolean;
  onToggleFocus?: () => void;
  inResults?: boolean;
  initialSection?: "summary" | "media" | null;
};
export type StaffDetailActions = {
  statusBusy?: boolean;
  statusRecovery?: ReactNode;
  onMove: (id: Id<"tickets">, status: TicketStatus) => void;
  onArchive: (id: Id<"tickets">) => Promise<void>;
  /** Resolves false when the restore outcome is unconfirmed; the Ticket then stays open. */
  onRestore?: (id: Id<"tickets">) => Promise<boolean | void>;
};
type RoleActions = ({ role: "staff" } & StaffDetailActions) | { role: "customer"; onArchiveRequest: (ticket: Ticket) => void };
type PanelProps = DetailNavigation & RoleActions & {
  ticket: Ticket | null | undefined; ticketId: string | null;
};

export function TicketDetailPanel(props: PanelProps) {
  const { t } = useI18n();
  const { ticket, ticketId, onPrevious, onNext, onToggleFocus, inline, initialSection } = props;
  const panel = useRef<HTMLElement>(null);
  const viewer = useRef<MediaViewerHandle>(null);
  const heading = useId();
  useEffect(() => {
    if (ticketId && inline && initialSection !== "media") panel.current?.focus();
  }, [ticketId, inline, initialSection]);

  function navigate(action: () => void) {
    if (viewer.current) viewer.current.requestClose(action);
    else action();
  }
  const close = () => navigate(props.onClose);
  if (!ticketId) return null;
  const title = ticket ? formatTicketNumber(ticket.ticketNumber, ticket.projectKey) : t("ticket");
  const navigation = <nav aria-label={t("ticket")} className="flex flex-wrap items-center justify-between gap-1 border-b border-border/50 pb-2">
    {inline && <Button type="button" variant="ghost" className="min-h-11 px-2" onClick={close}><ArrowLeft />{t("detailBack")}</Button>}
    <div className="ml-auto flex flex-wrap gap-1">
      {onToggleFocus && <Button type="button" variant="ghost" className="hidden min-h-11 px-2 lg:inline-flex" aria-pressed={props.focusMode} onClick={() => navigate(onToggleFocus)}>
        {props.focusMode ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}{t("queueFocus")}
      </Button>}
      <Button type="button" variant="ghost" size="icon" className="size-11" disabled={!onPrevious} onClick={onPrevious && (() => navigate(onPrevious))} aria-label={t("detailPrevious")} title={t("detailPrevious")}><ChevronLeft /></Button>
      <Button type="button" variant="ghost" size="icon" className="size-11" disabled={!onNext} onClick={onNext && (() => navigate(onNext))} aria-label={t("detailNext")} title={t("detailNext")}><ChevronRight /></Button>
    </div>
  </nav>;
  const content = <>
    {navigation}
    {ticket && <TicketListNotice key={ticketId} inResults={props.inResults} />}
    {ticket ? <DetailContent key={ticket._id} {...props} ticket={ticket} viewer={viewer} heading={heading} />
      : <p className="py-6 text-sm text-muted-foreground" role={ticket === undefined ? "status" : "alert"}>{t(ticket === undefined ? "syncing" : "ticketMissing")}</p>}
  </>;
  if (inline) return <section id={props.role === "customer" ? "customer-ticket-detail" : "staff-ticket-detail"} tabIndex={-1} ref={panel} onKeyDown={event => {
    if (event.key === "Escape" && !event.defaultPrevented && !(event.target as Element).closest("[role=dialog], [role=alertdialog]")) {
      event.stopPropagation();
      close();
    }
  }} aria-label={ticket ? undefined : t("ticket")} aria-labelledby={ticket ? heading : undefined}
    className="aurora-ticket min-w-0 space-y-3 p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-5">{content}</section>;
  return <Dialog open mobileFullScreen placement={props.focusMode ? "fullscreen" : "side"} onOpenChange={open => { if (!open) close(); }} title={title}>{content}</Dialog>;
}

function TicketListNotice({ inResults }: { inResults?: boolean }) {
  const { t } = useI18n();
  const [wasListed, setWasListed] = useState(inResults === true);
  useEffect(() => { if (inResults) setWasListed(true); }, [inResults]);
  const leftResults = wasListed && inResults === false;
  return <p role="status" aria-live="polite" className={leftResults ? "rounded-lg bg-muted px-3 py-2 text-sm" : "sr-only"}>
    {leftResults && t("detailLeftResults")}
  </p>;
}

function Disclosure({ title, children, icon }: { title: string; children: ReactNode; icon?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <section>
    <Button variant="ghost" type="button" aria-expanded={open} aria-controls={id}
      className="h-auto min-h-11 w-full justify-start whitespace-normal px-0 text-left font-medium hover:bg-transparent" onClick={() => setOpen(!open)}>
      {icon}{title}<ChevronDown className={cn("ml-auto text-muted-foreground transition-transform", open && "rotate-180")} />
    </Button>
    <div id={id} className={open ? "pb-3" : undefined}>{open && children}</div>
  </section>;
}

function DetailContent(props: PanelProps & { ticket: Ticket; heading: string; viewer: RefObject<MediaViewerHandle | null> }) {
  const { t, formatDate } = useI18n();
  const { ticket, initialSection, onClose, viewer } = props;
  const operations = useTicketOperations();
  const staffCopy = useStaffCopy();
  const staff = props.role === "staff";
  const archived = ticket.lifecycle === "archived";
  const number = formatTicketNumber(ticket.ticketNumber, ticket.projectKey);
  const meta = statusMeta(ticket.status);
  const primary = staffTicketActions[ticket.status];
  const [edit, setEdit] = useState<"content" | "urgency" | null>(null);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(initialSection === "media");
  const [mediaIndex, setMediaIndex] = useState(0);
  const [evidenceRequest, setEvidenceRequest] = useState<{ item: MessageEvidenceInput; nonce: number } | null>(null);
  const mediaButton = useRef<HTMLButtonElement>(null);
  const mediaId = useId();
  const pendingPin = useRef<Annotation | null>(null);
  const annotations = (ticket.annotations ?? []).filter(isActiveAnnotation);
  const deleted = (ticket.annotations ?? []).filter(note => !isActiveAnnotation(note));
  const editButton = useRef<HTMLButtonElement>(null);
  const urgencyButton = useRef<HTMLButtonElement>(null);
  const replyDraft = useTicketReplyDraft(ticket._id, ticket.projectId);
  const quoteUnlocked = useSyncExternalStore(replyDraft.owner.subscribe, replyDraft.canQuote);
  const canQuoteEvidence = ticket.hasCustomerOwner && !archived && ticket.status !== "done" && quoteUnlocked;

  useEffect(() => {
    if (initialSection === "media") {
      setMediaOpen(true);
      mediaButton.current?.focus({ preventScroll: true });
      mediaButton.current?.scrollIntoView({ block: "start" });
    }
  }, [initialSection]);

  function openThreadMedia(key: string) {
    const index = ticket.media.findIndex(file => file.key === key);
    if (index < 0) return;
    setMediaIndex(index);
    setMediaOpen(true);
    if (viewer.current) viewer.current.focusMedia(index);
    requestAnimationFrame(() => {
      mediaButton.current?.focus({ preventScroll: true });
      mediaButton.current?.scrollIntoView({ block: "start" });
    });
  }

  function focusPin(note: Annotation) {
    setMediaIndex(note.mediaIndex);
    setMediaOpen(true);
    mediaButton.current?.scrollIntoView({ block: "start" });
    if (viewer.current) viewer.current.focusAnnotation(note);
    else pendingPin.current = note;
  }

  function openThreadEvidence(evidence: AvailableMessageEvidence) {
    if (evidence.kind === "media") {
      openThreadMedia(evidence.mediaKey);
      return;
    }
    const note = annotations.find(item => item.id === evidence.annotationId);
    if (note) focusPin(note);
    else openThreadMedia(evidence.mediaKey);
  }

  function quoteEvidence(item: MessageEvidenceInput) {
    if (!canQuoteEvidence || !replyDraft.canQuote()) return;
    setEvidenceRequest(previous => ({ item, nonce: (previous?.nonce ?? 0) + 1 }));
  }

  function finishEdit() {
    const trigger = edit === "content" ? editButton : urgencyButton;
    setEdit(null);
    requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
  }

  async function changeLifecycle() {
    if (props.role !== "staff" || busy) return;
    setBusy(true);
    setError("");
    try {
      if (archived) {
        if (props.onRestore) {
          if (await props.onRestore(ticket._id) === false) return;
        } else {
          await operations.restore(ticket);
        }
      } else await props.onArchive(ticket._id);
      if (!props.inline) onClose();
    } catch (err) { setError(localizeError(err, t)); }
    finally { setBusy(false); }
  }

  const description = <>
    <TicketTagList tags={ticket.tags} />
    {archived && <p className="text-sm font-medium">{t("archivedOn", { date: formatDate(ticket.archivedAt ?? ticket.updatedAt) })}</p>}
    {ticket.description ? <DescriptionWithTags text={ticket.description} annotations={annotations} onFocus={focusPin} />
      : <p className="text-sm text-muted-foreground">{t("noDescription")}</p>}
  </>;

  const StatusIcon = meta.icon;
  const statusLabel = t(!staff && ticket.status === "waiting" ? "customerQueueWaiting" : meta.labelKey);
  const statusBadge = <Badge variant="outline" className={cn("min-h-8 gap-1.5 rounded-full px-2.5 text-sm font-medium", meta.tone)}>
    <StatusIcon aria-hidden className="size-3.5" />{statusLabel}
  </Badge>;

  return <div className="min-w-0 space-y-3 [overflow-wrap:anywhere] [&_button:not(.absolute)]:min-h-11">
    <header className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        {staff ? <TicketReferenceCopy reference={number} /> : <button type="button" className="-ms-1 inline-flex min-h-11 items-center gap-1.5 rounded-md px-1 font-mono text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`${t("copy")} ${number}`} onClick={async () => {
          try { await navigator.clipboard.writeText(number); toast.success(t("ticketCopied")); }
          catch { toast.error(t("ticketCopyFailed")); }
        }}>{number}<Copy className="size-3.5" /></button>}
        {props.role === "staff" && !archived
          ? <StatusMenu status={ticket.status} busy={props.statusBusy} number={number} onSelect={status => props.onMove(ticket._id, status)} />
          : statusBadge}
      </div>
      <h2 id={props.heading} tabIndex={-1} className="text-xl font-semibold leading-tight tracking-tight">{ticket.title}</h2>
      {!staff && !archived && <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-muted-foreground">
        <p className="text-sm">{t(ticket.status === "waiting" && ticket.latestReply?.answeredCustomerRequest && !ticket.latestReply.awaitingCustomer
          ? "detailCustomerWaiting" : customerProgress[ticket.status])}</p>
        <span className="inline-flex items-center gap-1 text-xs"><LockKeyhole className="size-3" aria-hidden />{t("threadPrivate")}</span>
      </div>}
      {staff && description}
    </header>
    {!staff && <TicketConversation ticket={ticket} role="customer" onOpenMedia={openThreadMedia} onOpenEvidence={openThreadEvidence} evidenceRequest={evidenceRequest}>{description}</TicketConversation>}
    {error && !staff && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {archived ? staff && <div className="space-y-1">
      <Button disabled={busy} onClick={changeLifecycle}><RotateCcw />{busy ? staffCopy.restoring : t("restore")}</Button>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div> : <>
      <div className="flex flex-wrap items-center gap-2">
        {props.role === "staff" && <Button aria-disabled={props.statusBusy || undefined} className={busyControl} aria-label={t(primary.label) + " · " + number} onClick={() => {
          if (!props.statusBusy) props.onMove(ticket._id, primary.status);
        }}>{t(primary.label)}<ArrowRight /></Button>}
        {edit === "content" && !staff
          ? <h3 className="text-sm font-semibold">{t("editTicket")}</h3>
          : <Button type="button" variant="outline" ref={editButton} onClick={() => setEdit("content")}><Pencil />{t(staff ? "edit" : "editTicket")}</Button>}
      </div>
      {props.role === "staff" && props.statusRecovery}
      {edit === "content" && <DetailEdit item={ticket} mode={edit} staff={staff} operations={operations} onClose={finishEdit} />}
      {staff && <TicketConversation ticket={ticket} role="staff" onOpenMedia={openThreadMedia} onOpenEvidence={openThreadEvidence} evidenceRequest={evidenceRequest} />}
    </>}
    {staff && <TicketAssignment ticket={ticket} />}
    <div className="aurora-inset rounded-xl px-3 [&>section+section]:border-t [&>section+section]:border-border/60">
      {ticket.media.length > 0 && <section>
        <Button ref={mediaButton} type="button" variant="ghost" aria-expanded={mediaOpen} aria-controls={mediaId}
          className="min-h-11 w-full justify-start px-0 font-medium hover:bg-transparent" onClick={() => {
            if (mediaOpen && viewer.current) viewer.current.requestClose(() => setMediaOpen(false));
            else setMediaOpen(!mediaOpen);
          }}>
          <Paperclip />{t("detailMedia", { count: ticket.media.length })}<ChevronDown className={cn("ml-auto text-muted-foreground transition-transform", mediaOpen && "rotate-180")} />
        </Button>
        <div id={mediaId} className={mediaOpen ? "pb-3" : undefined}>{mediaOpen && <Suspense fallback={<p role="status">{t("syncing")}</p>}>
          <MediaViewer ref={handle => {
            viewer.current = handle;
            if (handle && pendingPin.current) { handle.focusAnnotation(pendingPin.current); pendingPin.current = null; }
          }} media={ticket.media} initialIndex={mediaIndex} annotations={annotations} readOnly={archived}
            onQuoteMedia={canQuoteEvidence ? index => { const file = ticket.media[index]; if (file) quoteEvidence({ kind: "media", mediaKey: file.key }); } : undefined}
            onQuoteAnnotation={canQuoteEvidence ? note => quoteEvidence({ kind: "annotation", annotationId: note.id }) : undefined}
            onCreateAnnotation={async input => { await operations.addAnnotation(ticket, input); }}
            onUpdateAnnotation={async input => { await operations.updateAnnotation(ticket, input); }}
            onDeleteAnnotation={id => operations.removeAnnotation(ticket, id)} />
          <AnnotationList annotations={annotations} deletedAnnotations={deleted} readOnly={archived} onFocus={focusPin}
            onQuote={canQuoteEvidence ? note => quoteEvidence({ kind: "annotation", annotationId: note.id }) : undefined}
            onUpdate={async (annotationId, text) => { await operations.updateAnnotation(ticket, { annotationId, text }); }}
            onDelete={id => operations.removeAnnotation(ticket, id)} onRestore={id => operations.restoreAnnotation(ticket, id)} />
        </Suspense>}</div>
      </section>}
      <Disclosure title={t("pagesTitle")}><Suspense fallback={<p role="status">{t("syncing")}</p>}>
        <TicketPages ticket={ticket} staff={staff} />
      </Suspense></Disclosure>
      <TicketHistory key={ticket._id} id={ticket._id} staff={staff} />
      {!archived && <Disclosure title={t("detailActions")}>
        <div className="space-y-4">
          {props.role === "staff" && <>
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>{ticket.urgencyScore === undefined ? t("urgencyUnscored") : t("urgencyScoreValue", { score: ticket.urgencyScore })}</span>
              <Button type="button" ref={urgencyButton} variant="outline" onClick={() => setEdit("urgency")}>{t("detailUrgency")}</Button>
            </div>
            {edit === "urgency" && <TicketUrgencyEdit item={ticket} operations={operations} onClose={finishEdit} />}
            <Disclosure title={t("ticketTags")}><TicketTagEditor item={ticket} /></Disclosure>
          </>}
          <Button type="button" variant="outline" disabled={busy || (!staff && edit === "content")} className="text-destructive" onClick={() => {
            if (props.role === "staff") setConfirming(true);
            else {
              const request = () => props.onArchiveRequest(ticket);
              if (viewer.current) viewer.current.requestClose(request);
              else request();
            }
          }}>{t("archive")}</Button>
          {staff && error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
      </Disclosure>}
    </div>
    <footer className="px-1 text-xs leading-5 text-muted-foreground">
      {staff && <>{staffCopy.origin[ticket.origin]}{ticket.createdVia ? ` ${staffCopy.via[ticket.createdVia]}` : ""} · </>}
      {t("createdAt", { date: formatDate(ticket.createdAt) })} · {t("updatedOn", { date: formatDate(ticket.updatedAt) })}
    </footer>
    {staff && <AlertDialog open={confirming} onOpenChange={setConfirming} title={staffCopy.archiveTitle(number)}
      description={t("archiveConfirm")} confirmLabel={t("archive")}
      onConfirm={() => {
        if (viewer.current) viewer.current.requestClose(() => { void changeLifecycle(); });
        else void changeLifecycle();
      }} />}
  </div>;
}

/** Keep the busy controls focusable. The handlers block writes while aria-disabled announces the state. */
const busyControl = "aria-disabled:cursor-progress aria-disabled:opacity-60";

/** Staff status popup: every workflow state, current one checked. Moves go
 * through the caller so busy, conflict and undo rules stay shared. */
function StatusMenu({ status, busy, number, onSelect }: { status: TicketStatus; busy?: boolean; number: string; onSelect: (status: TicketStatus) => void }) {
  const { t } = useI18n();
  const meta = statusMeta(status);
  const Icon = meta.icon;
  const label = t(meta.labelKey);
  return <DropdownMenu onOpenChange={(open, details) => { if (open && busy) details.cancel(); }}>
    <DropdownMenuTrigger aria-disabled={busy || undefined} aria-label={`${t("detailStatus")} · ${label} · ${number}`} title={t("detailStatus")}
      className={cn("aurora-control inline-flex min-h-11 items-center gap-1.5 rounded-full ps-3 pe-2.5 text-sm font-medium transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:border-primary/60", busyControl, meta.text)}>
      <Icon aria-hidden className="size-4 shrink-0" />{label}
      {busy ? <LoaderCircle aria-hidden className="size-4 animate-spin text-muted-foreground" /> : <ChevronDown aria-hidden className="size-4 text-muted-foreground" />}
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-60">
      <DropdownMenuRadioGroup value={status} onValueChange={value => {
        const next = statuses.find(option => option.value === value);
        if (next && next.value !== status && !busy) onSelect(next.value);
      }}>
        <DropdownMenuLabel>{t("detailStatus")}</DropdownMenuLabel>
        {statuses.map(option => {
          const OptionIcon = option.icon;
          return <DropdownMenuRadioItem key={option.value} value={option.value} closeOnClick>
            <OptionIcon aria-hidden className={option.text} />{t(option.labelKey)}
          </DropdownMenuRadioItem>;
        })}
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>;
}
