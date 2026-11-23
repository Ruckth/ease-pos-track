import type { AnnotationUpdateInput } from "@/lib/types";
import { AnnotationActivityList } from "@/components/annotation-activity";
import { AnnotationList, DescriptionWithTags } from "@/components/annotation-notes";
import { MediaViewer, type MediaViewerHandle } from "@/components/media-viewer";
import { TicketActivityList } from "@/components/ticket-activity";
import { statusMeta } from "@/components/ticket-status";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { localizeError, useI18n } from "@/lib/i18n";
import { formatTicketNumber } from "../../../shared/ticket-numbers";
import { isActiveAnnotation, type Ticket } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { Id } from "@convex/_generated/dataModel";
import {
  Loader2,
  Pencil,
  Trash2
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useSelectedTicket, useTicketActivity } from "./adapter";
import { TicketPages } from "./ticket-pages";
import { useTicketOperations } from "./use-ticket-operations";

export function CustomerTicketDialog({
  token,
  ticketId,
  onClose,
}: {
  token: string;
  ticketId: Id<"tickets"> | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const detail = useSelectedTicket(token, ticketId);
  const previous = useRef(detail);
  useEffect(() => { if (detail) previous.current = detail; }, [detail]);
  const item = ticketId ? detail : previous.current;
  return (
    <Dialog open={Boolean(ticketId)} onOpenChange={open => !open && onClose()}
      title={item ? `${formatTicketNumber(item.ticketNumber, item.projectKey)} · ${item.title}` : t("ticket")}>
      {item ? <CustomerTicketContent key={item._id} ticket={item} token={token} onClose={onClose} /> : null}
    </Dialog>
  );
}

function CustomerTicketContent({ ticket, token, onClose }: { ticket: Ticket; token: string; onClose: () => void }) {
  const { t, formatDate } = useI18n();
  const { activity, ticketActivity } = useTicketActivity(token, ticket._id);
  const operations = useTicketOperations(token);
  const viewerRef = useRef<MediaViewerHandle>(null);
  const item = ticket;
  const [editVersion, setEditVersion] = useState<number | null>(null);
  const editing = editVersion !== null;
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const allAnnotations = item?.annotations ?? [];
  const annotations = allAnnotations.filter(isActiveAnnotation);
  const deletedAnnotations = allAnnotations.filter((annotation) => !isActiveAnnotation(annotation));

  async function saveEdits() {
    if (!item) return;
    setSaving(true);
    setError("");
    try {
      await operations.edit({ ...item, version: editVersion ?? item.version }, editTitle, editDescription);
      setEditVersion(null);
    } catch (saveError) {
      setError(localizeError(saveError, t));
    } finally {
      setSaving(false);
    }
  }

  async function deleteTicket() {
    if (!item) return;
    try {
      await operations.archive(item, true);
      onClose();
    } catch (deleteError) {
      setError(localizeError(deleteError, t));
    }
  }

  async function handleUpdateAnnotation(input: AnnotationUpdateInput) {
    if (item) await operations.updateAnnotation(item, input);
  }
  async function handleRestoreAnnotation(annotationId: string) {
    if (item) await operations.restoreAnnotation(item, annotationId);
  }
  async function handleDeleteAnnotation(annotationId: string) {
    if (item) await operations.removeAnnotation(item, annotationId);
  }

  const meta = item ? statusMeta(item.status) : null;

  return (
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
          await operations.addAnnotation(item, input);
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
            setEditVersion(item.version);
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
            <Button type="button" variant="ghost" onClick={() => setEditVersion(null)}>{t("cancel")}</Button>
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
      <TicketPages ticket={item} token={token} />
      <AnnotationActivityList events={activity ?? []} />
      <TicketActivityList events={ticketActivity ?? []} />
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
  );
}
