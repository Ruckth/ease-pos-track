import type { AnnotationUpdateInput } from "@/lib/types";
import { AnnotationActivityList } from "@/components/annotation-activity";
import { AnnotationList, DescriptionWithTags } from "@/components/annotation-notes";
import {
  MediaViewer,
  type MediaViewerHandle
} from "@/components/media-viewer";
import { TicketActivityList } from "@/components/ticket-activity";
import { statuses, statusMeta } from "@/components/ticket-status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { localizeError, useI18n } from "@/lib/i18n";
import { formatTicketNumber } from "@/lib/ticket-ui";
import { isActiveAnnotation, type Ticket, type TicketStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { Id } from "@convex/_generated/dataModel";
import { MAX_URGENCY_SCORE, MIN_URGENCY_SCORE } from "@convex/ticket_state";
import {
  Archive,
  Copy,
  Loader2,
  Pencil
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useTicketActivity } from "./adapter";
import { useTicketOperations } from "./use-ticket-operations";

export function StaffTicketDialog({
  ticket,
  token,
  onClose,
  onMove,
  onArchive,
}: {
  ticket: Ticket | null;
  token: string;
  onClose: () => void;
  onMove: (id: Id<"tickets">, status: TicketStatus) => void;
  onArchive: (id: Id<"tickets">) => Promise<void>;
}) {
  const { t } = useI18n();
  const previous = useRef(ticket);
  useEffect(() => { if (ticket) previous.current = ticket; }, [ticket]);
  const item = ticket ?? previous.current;
  return (
    <Dialog open={Boolean(ticket)} onOpenChange={open => !open && onClose()}
      title={item ? `${formatTicketNumber(item.ticketNumber, item.projectKey)} · ${item.title}` : t("ticket")}>
      {item ? <StaffTicketContent key={item._id} ticket={item} token={token} onMove={onMove} onArchive={onArchive} /> : null}
    </Dialog>
  );
}

function StaffTicketContent({ ticket, token, onMove, onArchive }: {
  ticket: Ticket; token: string;
  onMove: (id: Id<"tickets">, status: TicketStatus) => void;
  onArchive: (id: Id<"tickets">) => Promise<void>;
}) {
  const { t, formatDate } = useI18n();
  const { activity, ticketActivity } = useTicketActivity(token, ticket?._id ?? null);
  const operations = useTicketOperations(token);
  const viewerRef = useRef<MediaViewerHandle>(null);
  const item = ticket;
  const [editVersion, setEditVersion] = useState<number | null>(null);
  const editing = editVersion !== null;
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [savingTicket, setSavingTicket] = useState(false);
  const [urgencyInput, setUrgencyDraft] = useState<{ value: string; version: number } | null>(null);
  const urgencyDraft = urgencyInput?.value ?? item?.urgencyScore?.toString() ?? "";
  const [savingUrgency, setSavingUrgency] = useState(false);
  const [ticketError, setTicketError] = useState("");
  const allAnnotations = item?.annotations ?? [];
  const annotations = allAnnotations.filter(isActiveAnnotation);
  const deletedAnnotations = allAnnotations.filter((annotation) => !isActiveAnnotation(annotation));

  async function saveUrgencyScore() {
    if (!item) return;
    const trimmed = urgencyDraft.trim();
    const urgencyScore = trimmed === "" ? undefined : Number(trimmed);
    if (
      urgencyScore !== undefined
      && (!Number.isInteger(urgencyScore) || urgencyScore < MIN_URGENCY_SCORE || urgencyScore > MAX_URGENCY_SCORE)
    ) {
      setTicketError(t("invalidUrgencyScore"));
      return;
    }

    setSavingUrgency(true);
    setTicketError("");
    try {
      await operations.urgency({ ...item, version: urgencyInput?.version ?? item.version }, urgencyScore);
      setUrgencyDraft(null);
    } catch (error) {
      setTicketError(localizeError(error, t));
    } finally {
      setSavingUrgency(false);
    }
  }

  async function saveTicketEdits() {
    if (!item) return;
    setSavingTicket(true);
    setTicketError("");
    try {
      await operations.edit({ ...item, version: editVersion ?? item.version }, editTitle, editDescription);
      setEditVersion(null);
    } catch (error) {
      setTicketError(localizeError(error, t));
    } finally {
      setSavingTicket(false);
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

  async function copyTicketNumber() {
    if (!item) return;
    try {
      await navigator.clipboard.writeText(formatTicketNumber(item.ticketNumber, item.projectKey));
      toast.success(t("ticketCopied"));
    } catch {
      toast.error(t("ticketCopyFailed"));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/20 px-3 py-2.5">
        <div>
          <p className="text-sm font-medium leading-5 text-muted-foreground">{t("ticketNumber")}</p>
          <p className="font-mono text-sm font-semibold">{formatTicketNumber(item.ticketNumber, item.projectKey)}</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void copyTicketNumber()}>
          <Copy /> {t("copy")}
        </Button>
      </div>
      <div className="rounded-md border bg-muted/20 px-3 py-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-40 flex-1 space-y-1.5">
            <label htmlFor="ticket-urgency-score" className="text-sm font-medium">{t("urgencyScore")}</label>
            <Input
              id="ticket-urgency-score"
              type="number"
              inputMode="numeric"
              min={MIN_URGENCY_SCORE}
              max={MAX_URGENCY_SCORE}
              step={1}
              value={urgencyDraft}
              placeholder="—"
              onChange={(event) => setUrgencyDraft({ value: event.target.value, version: urgencyInput?.version ?? item.version })}
              aria-describedby="ticket-urgency-hint"
            />
          </div>
          <Button type="button" onClick={() => void saveUrgencyScore()} disabled={savingUrgency}>
            {savingUrgency ? <Loader2 className="animate-spin" /> : null} {t("saveUrgency")}
          </Button>
        </div>
        <p id="ticket-urgency-hint" className="mt-2 text-xs leading-5 text-muted-foreground">{t("urgencyScoreHint")}</p>
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
        {statuses.map((status) => (
          <Button
            key={status.value}
            variant={item.status === status.value ? "default" : "outline"}
            size="sm"
            onClick={() => onMove(item._id, status.value)}
          >
            {t(status.labelKey)}
          </Button>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => {
          setEditTitle(item.title);
          setEditDescription(item.description);
          setEditVersion(item.version);
        }}>
          <Pencil /> {t("edit")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={() => {
            if (!window.confirm(t("archiveConfirm"))) return;
            void onArchive(item._id).catch((error) => setTicketError(localizeError(error, t)));
          }}
        >
          <Archive /> {t("archive")}
        </Button>
      </div>
      <div className="space-y-3">
        <Badge className={cn("border", statusMeta(item.status).tone)} variant="outline">
          {t(statusMeta(item.status).labelKey)}
        </Badge>
        {editing ? (
          <div className="space-y-3 rounded-md border bg-muted/20 p-3">
            <div className="space-y-1.5">
              <label htmlFor="edit-ticket-title" className="text-sm font-medium">{t("topic")}</label>
              <Input id="edit-ticket-title" value={editTitle} maxLength={100} onChange={(event) => setEditTitle(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="edit-ticket-description" className="text-sm font-medium">{t("description")}</label>
              <Textarea id="edit-ticket-description" rows={5} maxLength={10_000} value={editDescription} onChange={(event) => setEditDescription(event.target.value)} />
              <p className="text-sm leading-5 text-muted-foreground">{t("mediaLinkHint")}</p>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setEditVersion(null)}>{t("cancel")}</Button>
              <Button type="button" disabled={savingTicket || !editTitle.trim()} onClick={() => void saveTicketEdits()}>
                {savingTicket ? <Loader2 className="animate-spin" /> : null} {t("save")}
              </Button>
            </div>
          </div>
        ) : (
          item.description ? (
            <DescriptionWithTags
              text={item.description}
              annotations={annotations}
              onFocus={(annotation) => viewerRef.current?.focusAnnotation(annotation)}
            />
          ) : (
            <p className="text-sm leading-6 text-muted-foreground">{t("noDescription")}</p>
          )
        )}
        {ticketError ? <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{ticketError}</p> : null}
        <AnnotationList
          annotations={annotations}
          deletedAnnotations={deletedAnnotations}
          onFocus={(annotation) => viewerRef.current?.focusAnnotation(annotation)}
          onUpdate={async (annotationId, text) => handleUpdateAnnotation({ annotationId, text })}
          onDelete={handleDeleteAnnotation}
          onRestore={handleRestoreAnnotation}
        />
        <AnnotationActivityList events={activity ?? []} />
        <TicketActivityList events={ticketActivity ?? []} />
        <p className="text-sm leading-5 text-muted-foreground">{t("createdAt", { date: formatDate(item.createdAt) })}</p>
      </div>
    </div>
  );
}
