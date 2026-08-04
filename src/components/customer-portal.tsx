import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Toaster, toast } from "sonner";
import { Loader2, LogOut, Pencil, PlusCircle, Trash2 } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AnnotationActivityList } from "@/components/annotation-activity";
import { AnnotationList, DescriptionWithTags } from "@/components/annotation-notes";
import { LanguageSelector } from "@/components/auth-screens";
import { CustomerTicketWizard } from "@/components/customer-ticket-wizard";
import { FeedbackActivityList } from "@/components/feedback-activity";
import { FeedbackCard } from "@/components/feedback-card";
import { statusMeta } from "@/components/feedback-status";
import { MediaViewer, type AnnotationUpdateInput, type MediaViewerHandle } from "@/components/media-viewer";
import { cn } from "@/lib/utils";
import { formatTicketNumber } from "@/lib/feedback-ui";
import { isActiveAnnotation, type Feedback } from "@/lib/types";
import { localizeError, useI18n } from "@/lib/i18n";

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
  const selected = tickets?.find((ticket) => ticket._id === selectedId) ?? null;

  return (
    <main className="min-h-screen">
      <Toaster richColors position="bottom-right" />
      <header className="border-b bg-card/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-normal">{t("customerPortal")}</h1>
            <p className="text-sm text-muted-foreground">
              {tickets ? t("myTicketCount", { count: tickets.length }) : t("syncing")}
              {email ? ` · ${t("signedInAs", { email })}` : ""}
            </p>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 lg:w-auto lg:flex-nowrap">
            <Button type="button" aria-expanded={composerOpen} onClick={() => setComposerOpen(true)}>
              <PlusCircle />
              {t("newTicket")}
            </Button>
            <LanguageSelector language={language} onChange={setLanguage} />
            <Button variant="outline" size="icon" onClick={() => void onLogout()} aria-label={t("signOut")}>
              <LogOut />
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-4 py-5 sm:px-6">
        {tickets === undefined ? (
          <div className="grid min-h-72 place-items-center rounded-lg border bg-card">
            <Loader2 className="size-7 animate-spin text-muted-foreground" />
          </div>
        ) : tickets.length === 0 ? (
          <div className="grid min-h-72 place-items-center rounded-lg border border-dashed bg-card px-6 text-center">
            <div className="space-y-2">
              <p className="text-base font-semibold">{t("myTicketsEmpty")}</p>
              <p className="text-sm text-muted-foreground">{t("myTicketsEmptyHint")}</p>
              <Button type="button" onClick={() => setComposerOpen(true)}>
                <PlusCircle /> {t("newTicket")}
              </Button>
            </div>
          </div>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {tickets.map((ticket) => {
              const meta = statusMeta(ticket.status);
              return (
                <li key={ticket._id} className="space-y-2">
                  <FeedbackCard item={ticket} onSelect={setSelectedId} />
                  <Badge variant="outline" className={cn("border", meta.tone)}>{t(meta.labelKey)}</Badge>
                </li>
              );
            })}
          </ul>
        )}
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
