import { ArrowLeft, ArrowRight, Maximize2, Minimize2, ChevronDown, ChevronLeft, ChevronRight, Copy, Paperclip, Pencil, RotateCcw } from "lucide-react";
import { lazy, Suspense, useEffect, useId, useRef, useState, type ReactNode } from "react";
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
import { localizeError, useI18n } from "@/lib/i18n";
import { staffTicketActions } from "@/lib/staff-ticket-queue";
import { type Annotation, isActiveAnnotation, type Ticket, type TicketStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { formatTicketNumber } from "../../../shared/ticket-numbers";
import { TicketAssignment } from "@/features/routing/ticket-assignment";
import { TicketConversation } from "./ticket-conversation";
import { DetailEdit } from "./ticket-detail-edit";
import { TicketHistory } from "./ticket-history";
import { useTicketOperations } from "./use-ticket-operations";

const MediaViewer = lazy(() => import("@/components/media-viewer").then(module => ({ default: module.MediaViewer })));
const customerProgress = {
  new: "statusNextNew", acknowledged: "statusNextAcknowledged", in_progress: "statusNextInProgress",
  waiting: "detailCustomerWaiting", done: "statusNextDone",
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
  onRestore?: (id: Id<"tickets">) => Promise<void>;
};
type RoleActions = ({ role: "staff" } & StaffDetailActions) | { role: "customer" };
type PanelProps = DetailNavigation & RoleActions & {
  ticket: Ticket | null | undefined; ticketId: string | null;
};

export function TicketDetailPanel(props: PanelProps) {
  const { t } = useI18n();
  const { ticket, ticketId, onPrevious, onNext, inline, initialSection } = props;
  const panel = useRef<HTMLElement>(null);
  const heading = useId();
  useEffect(() => {
    if (ticketId && inline && initialSection !== "media") panel.current?.focus();
  }, [ticketId, inline, initialSection]);

  const close = props.onClose;
  if (!ticketId) return null;
  const title = ticket ? formatTicketNumber(ticket.ticketNumber, ticket.projectKey) : t("ticket");
  const navigation = <nav aria-label={t("ticket")} className="flex flex-wrap items-center justify-between gap-1 border-b pb-2">
    {inline && <Button type="button" variant="ghost" className="min-h-11 px-2" onClick={close}><ArrowLeft />{t("detailBack")}</Button>}
    <div className="ml-auto flex flex-wrap gap-1">
      {props.onToggleFocus && <Button type="button" variant="ghost" className="hidden min-h-11 px-2 lg:inline-flex" aria-pressed={props.focusMode} onClick={props.onToggleFocus}>
        {props.focusMode ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}{t("queueFocus")}
      </Button>}
      <Button type="button" variant="ghost" size="icon" className="size-11" disabled={!onPrevious} onClick={onPrevious} aria-label={t("detailPrevious")} title={t("detailPrevious")}><ChevronLeft /></Button>
      <Button type="button" variant="ghost" size="icon" className="size-11" disabled={!onNext} onClick={onNext} aria-label={t("detailNext")} title={t("detailNext")}><ChevronRight /></Button>
    </div>
  </nav>;
  const content = <>
    {navigation}
    {ticket && <TicketListNotice key={ticketId} inResults={props.inResults} />}
    {ticket ? <DetailContent key={ticket._id} {...props} ticket={ticket} onClose={close} heading={heading} />
      : <p className="py-6 text-sm text-muted-foreground" role={ticket === undefined ? "status" : "alert"}>{t(ticket === undefined ? "syncing" : "ticketMissing")}</p>}
  </>;
  if (inline) return <section tabIndex={-1} ref={panel} onKeyDown={event => {
    if (event.key === "Escape" && !event.defaultPrevented && !(event.target as Element).closest("[role=dialog], [role=alertdialog]")) {
      event.stopPropagation();
      close();
    }
  }} aria-label={ticket ? undefined : t("ticket")} aria-labelledby={ticket ? heading : undefined}
    className="min-w-0 space-y-4 rounded-xl border bg-background p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-5">{content}</section>;
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
  return <section className="border-t">
    <Button variant="ghost" type="button" aria-expanded={open} aria-controls={id}
      className="h-auto min-h-11 w-full justify-start whitespace-normal px-0 text-left" onClick={() => setOpen(!open)}>
      {icon}{title}<ChevronDown className={cn("ml-auto", open && "rotate-180")} />
    </Button>
    <div id={id} className={open ? "pb-3" : undefined}>{open && children}</div>
  </section>;
}

function DetailContent(props: PanelProps & { ticket: Ticket; heading: string }) {
  const { t, formatDate } = useI18n();
  const { ticket, initialSection, onClose } = props;
  const operations = useTicketOperations();
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
  const mediaButton = useRef<HTMLButtonElement>(null);
  const mediaId = useId();
  const viewer = useRef<MediaViewerHandle>(null);
  const pendingPin = useRef<Annotation | null>(null);
  const annotations = (ticket.annotations ?? []).filter(isActiveAnnotation);
  const deleted = (ticket.annotations ?? []).filter(note => !isActiveAnnotation(note));
  const editButton = useRef<HTMLButtonElement>(null);
  const urgencyButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (initialSection === "media") {
      setMediaOpen(true);
      mediaButton.current?.focus({ preventScroll: true });
      mediaButton.current?.scrollIntoView({ block: "start" });
    }
  }, [initialSection]);

  function focusPin(note: Annotation) {
    setMediaOpen(true);
    mediaButton.current?.scrollIntoView({ block: "start" });
    if (viewer.current) viewer.current.focusAnnotation(note);
    else pendingPin.current = note;
  }

  function finishEdit() {
    const trigger = edit === "content" ? editButton : urgencyButton;
    setEdit(null);
    requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
  }

  async function changeLifecycle() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (archived && props.role === "staff") {
        if (props.onRestore) await props.onRestore(ticket._id);
        else await operations.restore(ticket);
      } else if (props.role === "staff") await props.onArchive(ticket._id);
      else await operations.archive(ticket, true);
      if (!props.inline || props.role === "customer") onClose();
    } catch (err) { setError(localizeError(err, t)); }
    finally { setBusy(false); }
  }

  return <div className="min-w-0 space-y-4 [overflow-wrap:anywhere] [&_button:not(.absolute)]:min-h-11">
    <header className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="inline-flex min-h-11 items-center gap-1.5 rounded font-mono text-sm text-muted-foreground hover:text-foreground focus-visible:ring-2" aria-label={`${t("copy")} ${number}`} onClick={async () => {
          try { await navigator.clipboard.writeText(number); toast.success(t("ticketCopied")); }
          catch { toast.error(t("ticketCopyFailed")); }
        }}>{number}<Copy className="size-3.5" /></button>
        <Badge variant="outline" className={meta.tone}>{t(meta.labelKey)}</Badge>
      </div>
      <h2 id={props.heading} className="text-xl font-semibold leading-tight">{ticket.title}</h2>
      <TicketTagList tags={ticket.tags} />
      {archived && <p className="text-sm font-medium">{t("archivedOn", { date: formatDate(ticket.archivedAt ?? ticket.updatedAt) })}</p>}
      {ticket.description ? <DescriptionWithTags text={ticket.description} annotations={annotations} onFocus={focusPin} />
        : <p className="text-sm text-muted-foreground">{t("noDescription")}</p>}
    </header>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {archived ? staff && <Button disabled={busy} onClick={changeLifecycle}><RotateCcw />{t("restore")}</Button> : <>
      <div className="flex flex-wrap items-center gap-2">
        {props.role === "staff" && <Button disabled={props.statusBusy} aria-label={t(primary.label) + " · " + number} onClick={() => props.onMove(ticket._id, primary.status)}>{t(primary.label)}<ArrowRight /></Button>}
        {!staff && <p className="w-full text-sm text-muted-foreground">{t(customerProgress[ticket.status])}</p>}
        <Button type="button" variant="outline" ref={editButton} onClick={() => setEdit("content")}><Pencil />{t(staff ? "edit" : "editTicket")}</Button>
      </div>
      {props.role === "staff" && props.statusRecovery}
      {edit === "content" && <DetailEdit item={ticket} mode={edit} staff={staff} operations={operations} onClose={finishEdit} />}
      <TicketConversation ticket={ticket} role={props.role} />
    </>}
    {staff && <TicketAssignment ticket={ticket} />}
    <div>
      {ticket.media.length > 0 && <section className="border-t">
        <Button ref={mediaButton} type="button" variant="ghost" aria-expanded={mediaOpen} aria-controls={mediaId}
          className="min-h-11 w-full justify-start px-0" onClick={() => setMediaOpen(!mediaOpen)}>
          <Paperclip />{t("detailMedia", { count: ticket.media.length })}<ChevronDown className={cn("ml-auto", mediaOpen && "rotate-180")} />
        </Button>
        <div id={mediaId}>{mediaOpen && <Suspense fallback={<p role="status">{t("syncing")}</p>}>
          <MediaViewer ref={handle => {
            viewer.current = handle;
            if (handle && pendingPin.current) { handle.focusAnnotation(pendingPin.current); pendingPin.current = null; }
          }} media={ticket.media} annotations={annotations} readOnly={archived}
            onCreateAnnotation={async input => { await operations.addAnnotation(ticket, input); }}
            onUpdateAnnotation={async input => { await operations.updateAnnotation(ticket, input); }}
            onDeleteAnnotation={id => operations.removeAnnotation(ticket, id)} />
          <AnnotationList annotations={annotations} deletedAnnotations={deleted} readOnly={archived} onFocus={focusPin}
            onUpdate={async (annotationId, text) => { await operations.updateAnnotation(ticket, { annotationId, text }); }}
            onDelete={id => operations.removeAnnotation(ticket, id)} onRestore={id => operations.restoreAnnotation(ticket, id)} />
        </Suspense>}</div>
      </section>}
      <Disclosure title={t("detailHistory")}><TicketHistory id={ticket._id} staff={staff} /></Disclosure>
      {!archived && <Disclosure title={t("detailActions")}>
        <div className="space-y-4">
          {props.role === "staff" && <>
            <label className="flex flex-wrap items-center justify-between gap-2 text-sm">{t("detailStatus")}
              <select className="min-h-11 rounded-md border bg-background px-2" value={ticket.status} disabled={props.statusBusy} onChange={event => {
                const status = statuses.find(value => value.value === event.target.value);
                if (status) props.onMove(ticket._id, status.value);
              }}>{statuses.map(status => <option key={status.value} value={status.value}>{t(status.labelKey)}</option>)}</select>
            </label>
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>{ticket.urgencyScore === undefined ? t("urgencyUnscored") : t("urgencyScoreValue", { score: ticket.urgencyScore })}</span>
              <Button type="button" ref={urgencyButton} variant="outline" onClick={() => setEdit("urgency")}>{t("detailUrgency")}</Button>
            </div>
            {edit === "urgency" && <DetailEdit item={ticket} mode={edit} staff operations={operations} onClose={finishEdit} />}
            <Disclosure title={t("ticketTags")}><TicketTagEditor item={ticket} /></Disclosure>
          </>}
          <Button type="button" variant="outline" disabled={busy} className="text-destructive" onClick={() => setConfirming(true)}>{t(staff ? "archive" : "deleteTicket")}</Button>
        </div>
      </Disclosure>}
    </div>
    <footer className="border-t pt-3 text-xs leading-5 text-muted-foreground">
      {t("createdAt", { date: formatDate(ticket.createdAt) })} · {t("updatedOn", { date: formatDate(ticket.updatedAt) })}
    </footer>
    <AlertDialog open={confirming} onOpenChange={setConfirming} title={t(staff ? "archive" : "deleteTicket")}
      description={t(staff ? "archiveConfirm" : "deleteTicketConfirm")} confirmLabel={t(staff ? "archive" : "deleteTicket")}
      onConfirm={() => { void changeLifecycle(); }} />
  </div>;
}
