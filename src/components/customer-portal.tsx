import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Toaster, toast } from "sonner";
import {
  ArrowRight,
  CheckCircle2,
  CircleDot,
  Clock3,
  Headphones,
  Images,
  Loader2,
  LogOut,
  MapPin,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  UserRound,
} from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { AnnotationActivityList } from "@/components/annotation-activity";
import { AnnotationList, DescriptionWithTags } from "@/components/annotation-notes";
import { LanguageSelector } from "@/components/auth-screens";
import { CustomerTicketWizard } from "@/components/customer-ticket-wizard";
import { FeedbackActivityList } from "@/components/feedback-activity";
import { statusMeta } from "@/components/feedback-status";
import { MediaViewer, type AnnotationUpdateInput, type MediaViewerHandle } from "@/components/media-viewer";
import { cn } from "@/lib/utils";
import { feedbackProgress, formatTicketNumber } from "@/lib/feedback-ui";
import { isActiveAnnotation, isVideoMedia, type Feedback, type FeedbackStatus } from "@/lib/types";
import { localizeError, useI18n } from "@/lib/i18n";

type CustomerTicketFilter = "all" | "active" | "waiting" | "done";

function ticketMatchesFilter(status: FeedbackStatus, filter: CustomerTicketFilter) {
  if (filter === "all") return true;
  if (filter === "active") return status !== "waiting" && status !== "done";
  return status === filter;
}

/**
 * The customer portal: only the tickets this account owns, and only the actions
 * a customer is allowed to perform — create, view, edit, annotate, delete. Status
 * changes, archive restore, and the board itself stay staff-only, enforced on the
 * server as well as hidden here.
 */
export function CustomerPortal({
  token,
  email,
  onLogout,
}: {
  token: string;
  email: string | null;
  onLogout: () => Promise<void>;
}) {
  const { language, setLanguage, t } = useI18n();
  const tickets = useQuery(api.feedback.listMyFeedback, { token });
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerBusy, setComposerBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<Id<"feedback"> | null>(null);
  const [filter, setFilter] = useState<CustomerTicketFilter>("all");
  const selected = tickets?.find((ticket) => ticket._id === selectedId) ?? null;
  const ticketCounts = useMemo(() => {
    const rows = tickets ?? [];
    return {
      all: rows.length,
      active: rows.filter((ticket) => ticketMatchesFilter(ticket.status, "active")).length,
      waiting: rows.filter((ticket) => ticket.status === "waiting").length,
      done: rows.filter((ticket) => ticket.status === "done").length,
    };
  }, [tickets]);
  const visibleTickets = useMemo(
    () => (tickets ?? []).filter((ticket) => ticketMatchesFilter(ticket.status, filter)),
    [filter, tickets],
  );
  const filters: Array<{ value: CustomerTicketFilter; label: string; count: number }> = [
    { value: "all", label: t("allTickets"), count: ticketCounts.all },
    { value: "active", label: t("activeTickets"), count: ticketCounts.active },
    { value: "waiting", label: t("awaitingReply"), count: ticketCounts.waiting },
    { value: "done", label: t("resolvedTickets"), count: ticketCounts.done },
  ];

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,hsl(var(--secondary)/0.8),transparent_32rem)]">
      <Toaster richColors position="bottom-right" />
      <header className="sticky top-0 z-20 border-b bg-card/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm">
              <Headphones className="size-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold leading-5">{t("appName")}</p>
              <p className="truncate text-xs leading-4 text-muted-foreground">{t("customerPortal")}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <LanguageSelector language={language} onChange={setLanguage} />
            <Button variant="ghost" size="icon" onClick={() => void onLogout()} aria-label={t("signOut")}>
              <LogOut />
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-4 pb-12 pt-6 sm:px-6 sm:pt-8">
        <section className="relative overflow-hidden rounded-2xl border border-primary/15 bg-primary px-5 py-7 text-primary-foreground shadow-lg shadow-primary/10 sm:px-8 sm:py-9">
          <div className="pointer-events-none absolute -right-16 -top-24 size-64 rounded-full bg-white/10 blur-2xl" />
          <div className="pointer-events-none absolute -bottom-28 right-28 size-56 rounded-full bg-cyan-300/15 blur-2xl" />
          <div className="relative flex flex-col gap-7 md:flex-row md:items-end md:justify-between">
            <div className="max-w-2xl">
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs font-medium text-white/90">
                <Sparkles className="size-3.5" aria-hidden="true" />
                {t("customerSupport")}
              </div>
              <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{t("customerPortalTitle")}</h1>
              <p className="mt-3 max-w-xl text-sm leading-6 text-white/75 sm:text-base">{t("customerPortalIntro")}</p>
              {email ? (
                <p className="mt-5 flex items-center gap-2 text-xs text-white/70 sm:text-sm">
                  <UserRound className="size-4" aria-hidden="true" />
                  {t("signedInAs", { email })}
                </p>
              ) : null}
            </div>
            <Button
              type="button"
              size="lg"
              variant="secondary"
              className="w-full shrink-0 rounded-xl bg-white text-primary shadow-md hover:bg-white/90 md:w-auto"
              aria-expanded={composerOpen}
              onClick={() => setComposerOpen(true)}
            >
              <Plus className="size-5" />
              {t("newTicket")}
            </Button>
          </div>
        </section>

        <section aria-label={t("ticketSummary")} className="mt-5 grid grid-cols-3 gap-2 sm:gap-4">
          <TicketSummary icon={CircleDot} label={t("activeTickets")} value={ticketCounts.active} tone="text-sky-700 bg-sky-50" />
          <TicketSummary icon={Clock3} label={t("awaitingReply")} mobileLabel={t("awaitingReplyShort")} value={ticketCounts.waiting} tone="text-violet-700 bg-violet-50" />
          <TicketSummary icon={CheckCircle2} label={t("resolvedTickets")} value={ticketCounts.done} tone="text-emerald-700 bg-emerald-50" />
        </section>

        <section className="mt-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-xl font-semibold tracking-tight">{t("yourTickets")}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {tickets ? t("myTicketCount", { count: tickets.length }) : t("syncing")}
              </p>
            </div>
            <div className="flex max-w-full gap-1 overflow-x-auto rounded-xl border bg-card p-1 shadow-sm" aria-label={t("filterTickets")}>
              {filters.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => setFilter(item.value)}
                  aria-pressed={filter === item.value}
                  className={cn(
                    "inline-flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    filter === item.value ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {item.label}
                  <span className={cn("rounded-full px-1.5 py-0.5 text-[11px] tabular-nums", filter === item.value ? "bg-white/20" : "bg-muted text-foreground")}>
                    {item.count}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </section>

        <div className="mt-4">
        {tickets === undefined ? (
          <div className="grid min-h-72 place-items-center rounded-2xl border bg-card shadow-sm">
            <div className="space-y-3 text-center text-sm text-muted-foreground">
              <Loader2 className="mx-auto size-7 animate-spin" />
              <p>{t("syncingTickets")}</p>
            </div>
          </div>
        ) : tickets.length === 0 ? (
          <div className="grid min-h-72 place-items-center rounded-2xl border border-dashed bg-card px-6 text-center shadow-sm">
            <div className="max-w-sm space-y-3">
              <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-secondary text-secondary-foreground">
                <Sparkles className="size-5" />
              </div>
              <p className="text-lg font-semibold">{t("myTicketsEmpty")}</p>
              <p className="text-sm leading-6 text-muted-foreground">{t("myTicketsEmptyHint")}</p>
              <Button className="mt-1 rounded-xl" type="button" onClick={() => setComposerOpen(true)}>
                <Plus /> {t("newTicket")}
              </Button>
            </div>
          </div>
        ) : visibleTickets.length === 0 ? (
          <div className="grid min-h-48 place-items-center rounded-2xl border border-dashed bg-card px-6 text-center">
            <div>
              <p className="font-semibold">{t("noFilteredTickets")}</p>
              <Button type="button" variant="ghost" className="mt-2" onClick={() => setFilter("all")}>{t("showAllTickets")}</Button>
            </div>
          </div>
        ) : (
          <ul className="grid gap-3 lg:grid-cols-2">
            {visibleTickets.map((ticket) => (
              <li key={ticket._id}>
                <CustomerTicketCard item={ticket} onSelect={setSelectedId} />
              </li>
            ))}
          </ul>
        )}
        </div>
      </div>

      <Dialog
        open={composerOpen}
        onOpenChange={(open) => {
          if (open || !composerBusy) setComposerOpen(open);
        }}
        title={t("newTicket")}
        description={t("customerPortalSubtitle")}
        keepMounted
      >
        <CustomerTicketWizard
          token={token}
          active={composerOpen}
          onSubmitted={() => setComposerOpen(false)}
          onUploadBusyChange={setComposerBusy}
        />
      </Dialog>

      <CustomerTicketDialog
        token={token}
        ticket={selected}
        onClose={() => setSelectedId(null)}
      />
    </main>
  );
}

function TicketSummary({
  icon: Icon,
  label,
  mobileLabel,
  value,
  tone,
}: {
  icon: typeof CircleDot;
  label: string;
  mobileLabel?: string;
  value: number;
  tone: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-xl border bg-card p-3 shadow-sm sm:gap-3 sm:p-4">
      <div className={cn("hidden size-10 shrink-0 place-items-center rounded-xl sm:grid", tone)}>
        <Icon className="size-5" aria-hidden="true" />
      </div>
      <div className="min-w-0">
        <p className="text-xl font-semibold tabular-nums sm:text-2xl">{value}</p>
        <p className="truncate text-[11px] text-muted-foreground sm:text-sm">
          {mobileLabel ? <><span className="sm:hidden">{mobileLabel}</span><span className="hidden sm:inline">{label}</span></> : label}
        </p>
      </div>
    </div>
  );
}

const statusHintKeys: Record<FeedbackStatus, "statusNextNew" | "statusNextAcknowledged" | "statusNextInProgress" | "statusNextWaiting" | "statusNextDone"> = {
  new: "statusNextNew",
  acknowledged: "statusNextAcknowledged",
  in_progress: "statusNextInProgress",
  waiting: "statusNextWaiting",
  done: "statusNextDone",
};

function CustomerTicketCard({ item, onSelect }: { item: Feedback; onSelect: (id: Id<"feedback">) => void }) {
  const { t, formatDate } = useI18n();
  const meta = statusMeta(item.status);
  const StatusIcon = meta.icon;
  const progress = feedbackProgress(item.status);
  const cover = item.media[0];
  const pinCount = item.annotations?.filter(isActiveAnnotation).length ?? 0;
  const ticketLabel = formatTicketNumber(item.ticketNumber);

  return (
    <article className={cn("group relative overflow-hidden rounded-2xl border bg-card shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-md", item.status === "waiting" && "border-violet-200 bg-violet-50/20")}>
      <button
        type="button"
        className="absolute inset-0 z-10 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        aria-label={t("viewTicket", { ticket: ticketLabel })}
        onClick={() => onSelect(item._id)}
      />
      <div className="flex min-h-52 flex-col sm:min-h-48 sm:flex-row">
        <div className="flex min-w-0 flex-1 flex-col p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className={cn("gap-1.5 rounded-full border px-2.5 py-1", meta.tone)}>
              <StatusIcon className="size-3.5" aria-hidden="true" />
              {t(meta.labelKey)}
            </Badge>
            <span className="font-mono text-xs font-semibold text-muted-foreground">{ticketLabel}</span>
            <span className="text-xs text-muted-foreground">· {formatDate(item.createdAt)}</span>
          </div>
          <h3 className="mt-3 line-clamp-2 text-base font-semibold leading-6 group-hover:text-primary">{item.title}</h3>
          <p className="mt-1 line-clamp-2 text-sm leading-5 text-muted-foreground">{item.description || t("noDescription")}</p>

          <div className="mt-auto pt-4">
            <div className="mb-2 flex items-center justify-between gap-3 text-xs">
              <span className={cn("font-medium", item.status === "waiting" ? "text-violet-700" : "text-muted-foreground")}>{t(statusHintKeys[item.status])}</span>
              <span className="shrink-0 font-semibold tabular-nums">{progress.percent}%</span>
            </div>
            <Progress value={progress.percent} className="h-1.5" aria-label={t("ticketProgress", { ticket: ticketLabel, step: progress.step, total: progress.total, percent: progress.percent })} />
            <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
              {item.media.length > 0 ? <span className="flex items-center gap-1"><Images className="size-3.5" />{item.media.length}</span> : null}
              {pinCount > 0 ? <span className="flex items-center gap-1"><MapPin className="size-3.5" />{pinCount}</span> : null}
              <span className="ml-auto inline-flex items-center gap-1 font-medium text-primary">{t("openTicket")}<ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" /></span>
            </div>
          </div>
        </div>
        {cover ? (
          <div className="relative h-32 shrink-0 overflow-hidden bg-black sm:h-auto sm:w-36">
            {isVideoMedia(cover) ? (
              <video className="h-full w-full object-cover opacity-85" src={cover.url} muted playsInline preload="metadata" />
            ) : (
              <img className="h-full w-full object-cover" src={cover.url} alt="" loading="lazy" />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black/25 to-transparent sm:bg-gradient-to-l" />
          </div>
        ) : null}
      </div>
    </article>
  );
}

function CustomerTicketDialog({
  token,
  ticket,
  onClose,
}: {
  token: string;
  ticket: Feedback | null;
  onClose: () => void;
}) {
  const { t, formatDate } = useI18n();
  const detail = useQuery(api.feedback.getFeedback, ticket ? { token, id: ticket._id } : "skip");
  const activity = useQuery(api.feedback.listAnnotationActivity, ticket ? { token, id: ticket._id } : "skip");
  const feedbackActivity = useQuery(api.feedback.listFeedbackActivity, ticket ? { token, id: ticket._id } : "skip");
  const editFeedback = useMutation(api.feedback.editFeedback);
  const undoFeedbackEdit = useMutation(api.feedback.undoFeedbackEdit);
  const archiveFeedback = useMutation(api.feedback.archiveFeedback);
  const addAnnotation = useMutation(api.feedback.addAnnotation);
  const updateAnnotation = useMutation(api.feedback.updateAnnotation);
  const undoAnnotationUpdate = useMutation(api.feedback.undoAnnotationUpdate);
  const removeAnnotation = useMutation(api.feedback.removeAnnotation);
  const restoreAnnotation = useMutation(api.feedback.restoreAnnotation);
  const viewerRef = useRef<MediaViewerHandle>(null);
  const item = detail ?? ticket;
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const allAnnotations = item?.annotations ?? [];
  const annotations = allAnnotations.filter(isActiveAnnotation);
  const deletedAnnotations = allAnnotations.filter((annotation) => !isActiveAnnotation(annotation));

  useEffect(() => {
    setEditing(false);
    setEditTitle(item?.title ?? "");
    setEditDescription(item?.description ?? "");
    setError("");
    setConfirmingDelete(false);
  }, [item?._id]);

  async function saveEdits() {
    if (!item) return;
    setSaving(true);
    setError("");
    try {
      const result = await editFeedback({
        token,
        id: item._id,
        title: editTitle,
        description: editDescription,
        expectedVersion: item.version ?? 0,
      });
      setEditing(false);
      if ("eventId" in result && result.eventId) {
        toast.success(t("feedbackUpdated"), {
          action: {
            label: t("undo"),
            onClick: () => {
              void undoFeedbackEdit({ token, eventId: result.eventId, expectedVersion: result.version })
                .catch((undoError) => toast.error(localizeError(undoError, t)));
            },
          },
        });
      }
    } catch (saveError) {
      setError(localizeError(saveError, t));
    } finally {
      setSaving(false);
    }
  }

  async function deleteTicket() {
    if (!item) return;
    try {
      await archiveFeedback({ token, id: item._id, expectedVersion: item.version ?? 0 });
      toast.success(t("ticketDeleted"));
      onClose();
    } catch (deleteError) {
      setError(localizeError(deleteError, t));
    }
  }

  async function handleUpdateAnnotation(input: AnnotationUpdateInput) {
    if (!item) return;
    const result = await updateAnnotation({ token, id: item._id, ...input });
    toast.success(t("commentUpdated"), {
      action: {
        label: t("undo"),
        onClick: () => {
          void undoAnnotationUpdate({ token, eventId: result.eventId })
            .catch((undoError) => toast.error(localizeError(undoError, t)));
        },
      },
    });
  }

  async function handleRestoreAnnotation(annotationId: string, announce = true) {
    if (!item) return;
    await restoreAnnotation({ token, id: item._id, annotationId });
    if (announce) toast.success(t("commentRestored"));
  }

  async function handleDeleteAnnotation(annotationId: string) {
    if (!item) return;
    await removeAnnotation({ token, id: item._id, annotationId });
    toast.success(t("commentDeleted"), {
      action: {
        label: t("undo"),
        onClick: () => {
          void handleRestoreAnnotation(annotationId, false)
            .catch((undoError) => toast.error(localizeError(undoError, t)));
        },
      },
    });
  }

  const meta = item ? statusMeta(item.status) : null;

  return (
    <Dialog
      open={Boolean(ticket)}
      onOpenChange={(open) => !open && onClose()}
      title={item ? `${formatTicketNumber(item.ticketNumber)} · ${item.title}` : t("feedback")}
    >
      {item ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/20 px-3 py-2.5">
            <div>
              <p className="text-sm font-medium leading-5 text-muted-foreground">{t("ticketStatus")}</p>
              {meta ? <Badge variant="outline" className={cn("border", meta.tone)}>{t(meta.labelKey)}</Badge> : null}
            </div>
            <p className="text-sm text-muted-foreground">{t("customerStatusHint")}</p>
          </div>

          <MediaViewer
            key={item._id}
            ref={viewerRef}
            media={item.media}
            annotations={annotations}
            onCreateAnnotation={async (input) => {
              await addAnnotation({ token, id: item._id, ...input });
            }}
            onUpdateAnnotation={handleUpdateAnnotation}
            onDeleteAnnotation={handleDeleteAnnotation}
          />

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setEditTitle(item.title);
                setEditDescription(item.description);
                setEditing(true);
              }}
            >
              <Pencil /> {t("editTicket")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => setConfirmingDelete(true)}
            >
              <Trash2 /> {t("deleteTicket")}
            </Button>
          </div>

          {editing ? (
            <div className="space-y-3 rounded-md border bg-muted/20 p-3">
              <div className="space-y-1.5">
                <label htmlFor="customer-edit-title" className="text-sm font-medium">{t("topic")}</label>
                <Input id="customer-edit-title" value={editTitle} maxLength={100} onChange={(event) => setEditTitle(event.target.value)} />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="customer-edit-description" className="text-sm font-medium">{t("description")}</label>
                <Textarea id="customer-edit-description" rows={5} maxLength={10_000} value={editDescription} onChange={(event) => setEditDescription(event.target.value)} />
                <p className="text-sm leading-5 text-muted-foreground">{t("mediaLinkHint")}</p>
              </div>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={() => setEditing(false)}>{t("cancel")}</Button>
                <Button type="button" disabled={saving || !editTitle.trim()} onClick={() => void saveEdits()}>
                  {saving ? <Loader2 className="animate-spin" /> : null} {t("save")}
                </Button>
              </div>
            </div>
          ) : item.description ? (
            <DescriptionWithTags
              text={item.description}
              annotations={annotations}
              onFocus={(annotation) => viewerRef.current?.focusAnnotation(annotation)}
            />
          ) : (
            <p className="text-sm leading-6 text-muted-foreground">{t("noDescription")}</p>
          )}

          {error ? <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}

          <AnnotationList
            annotations={annotations}
            deletedAnnotations={deletedAnnotations}
            onFocus={(annotation) => viewerRef.current?.focusAnnotation(annotation)}
            onUpdate={async (annotationId, text) => handleUpdateAnnotation({ annotationId, text })}
            onDelete={handleDeleteAnnotation}
            onRestore={handleRestoreAnnotation}
          />
          <AnnotationActivityList events={activity ?? []} />
          <FeedbackActivityList events={feedbackActivity ?? []} />
          <p className="text-sm leading-5 text-muted-foreground">{t("createdAt", { date: formatDate(item.createdAt) })}</p>
          <p className="text-sm leading-5 text-muted-foreground">{t("updatedOn", { date: formatDate(item.updatedAt) })}</p>

          <AlertDialog
            open={confirmingDelete}
            onOpenChange={setConfirmingDelete}
            title={t("deleteTicket")}
            description={t("deleteTicketConfirm")}
            confirmLabel={t("deleteTicket")}
            onConfirm={() => void deleteTicket()}
          />
        </div>
      ) : null}
    </Dialog>
  );
}
