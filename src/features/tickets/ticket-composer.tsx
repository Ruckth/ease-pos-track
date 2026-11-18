import { AlertDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/lib/i18n";
import type { PendingMedia } from "@/lib/types";
import { Loader2 } from "lucide-react";
import { lazy, Suspense, useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { DisposableTicketDraft } from "./draft";
import { useTicketDraft } from "./use-composer";
import type { Id } from "@convex/_generated/dataModel";
import { DESCRIPTION_MAX_LENGTH, ticketDraftIssue, TITLE_MAX_LENGTH } from "./composer-validation";

const MediaViewer = lazy(() => import("@/components/media-viewer").then(module => ({ default: module.MediaViewer })));
const MediaUploadField = lazy(() => import("@/components/media-upload").then(module => ({ default: module.MediaUploadField })));

/** Presentation never owns files: closing, previewing, and remounting keep the
 * Project-bound draft and its retry identity in the existing draft controller. */
export function TicketComposer({ token, draftOwner, active, role, onSubmitted }: {
  token: string;
  draftOwner: DisposableTicketDraft;
  active: boolean;
  role: "staff" | "customer";
  onSubmitted: (id?: Id<"tickets">) => void;
}) {
  const { t } = useI18n();
  const { owner, title, description, items, annotations, error, progress, setTitle, setDescription,
    setItems, setError, viewerMedia, viewerAnnotations, annotationCounts,
    createPendingAnnotation, updatePendingAnnotation, deletePendingAnnotation, submit: submitDraft } = useTicketDraft(token, draftOwner);
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<PendingMedia | null>(null);
  const [preview, setPreview] = useState(false);
  const [titleInvalid, setTitleInvalid] = useState(false);
  const isUploading = progress !== null;
  const titleId = role === "customer" ? "customer-ticket-title" : "title";
  const descriptionId = role === "customer" ? "customer-ticket-description" : "description";
  const selectedMediaIndex = Math.max(0, items.findIndex(item => item.id === selectedMediaId));

  function removePendingItem(item: PendingMedia) {
    owner.remove(item);
    setSelectedMediaId(current => current === item.id ? null : current);
    setPendingRemoval(null);
  }
  function requestPendingItemRemoval(item: PendingMedia) {
    if ((annotationCounts[item.id] ?? 0) === 0) removePendingItem(item);
    else setPendingRemoval(item);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const issue = ticketDraftIssue({ title, description });
    if (issue) {
      setTitleInvalid(issue === "REQUIRED_TITLE");
      setError(new Error(issue));
      document.getElementById(issue === "DESCRIPTION_TOO_LONG" ? descriptionId : titleId)?.focus();
      return;
    }
    setTitleInvalid(false);
    if (await submitDraft()) {
      setSelectedMediaId(null);
      setPendingRemoval(null);
      setPreview(false);
      const id = owner.lastSubmittedId;
      onSubmitted(id);
      const link = new URL(window.location.pathname, window.location.origin);
      const project = new URLSearchParams(window.location.search).get("project");
      if (project) link.searchParams.set("project", project);
      if (id) link.searchParams.set("ticket", id);
      toast.success(t("ticketSubmitted"), id ? { action: {
        label: t("copyTicketLink"),
        onClick: async () => {
          try { await navigator.clipboard.writeText(link.href); }
          catch { toast.error(t("ticketCopyFailed")); }
        },
      } } : undefined);
    }
  }

  return <>
    <form className="space-y-4" onSubmit={submit} noValidate aria-busy={isUploading}>
      <p className="text-sm text-muted-foreground">{t("composerHint")}</p>
      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor={titleId}>{t("topic")} <span className="text-muted-foreground">{t("composerRequired")}</span></label>
        <Input disabled={isUploading} id={titleId} value={title} required aria-invalid={titleInvalid || undefined}
          aria-describedby={titleInvalid ? `${titleId}-error` : undefined} maxLength={TITLE_MAX_LENGTH}
          placeholder={t("topicPlaceholder")} onChange={event => {
            setTitle(event.target.value);
            if (titleInvalid) { setTitleInvalid(false); setError(null); }
          }} />
        {titleInvalid ? <p id={`${titleId}-error`} className="text-sm text-destructive">{t("requiredTitle")}</p> : null}
      </div>
      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor={descriptionId}>{t("description")}</label>
        <Textarea disabled={isUploading} id={descriptionId} rows={4} maxLength={DESCRIPTION_MAX_LENGTH} value={description}
          placeholder={t("descriptionPlaceholder")} onChange={event => setDescription(event.target.value)} />
      </div>
      <div className="space-y-2">
        <p className="text-sm font-medium">{t("media")}</p>
        <Suspense fallback={<p role="status" className="text-sm text-muted-foreground">{t("syncing")}</p>}><MediaUploadField items={items} onItemsChange={setItems} onFilesAdded={owner.addFiles}
          onPreviewItem={item => setSelectedMediaId(item.id)} onRequestRemove={requestPendingItemRemoval}
          annotationCounts={annotationCounts} disabled={!active || isUploading} /></Suspense>
        {items.length ? <p className="text-sm leading-5 text-muted-foreground">{annotations.length ? t("pinSummary", { count: annotations.length }) : t("pinHint")}</p> : null}
      </div>
      <Button type="button" className="min-h-11" variant="ghost" disabled={isUploading} aria-expanded={preview} aria-controls={`${titleId}-preview`}
        onClick={() => setPreview(value => !value)}>{t(preview ? "composerHidePreview" : "composerPreview")}</Button>
      {preview ? <section id={`${titleId}-preview`} aria-label={t("composerPreview")} className="space-y-2 rounded-lg border bg-muted/30 p-4">
        <h3 className="break-words font-semibold">{title.trim() || t("composerUntitled")}</h3>
        <p className="whitespace-pre-wrap break-words text-sm">{description.trim() || t("noDescription")}</p>
        <p className="text-sm text-muted-foreground">{t("reviewMedia", { count: items.length })} · {t("reviewPins", { count: annotations.length })}</p>
      </section> : null}
      {progress !== null ? <div role="progressbar" aria-label={t("submitting")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} className="h-2 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
      </div> : null}
      {(title || description || items.length > 0) && <p className="text-xs text-muted-foreground">{t("draftSessionHint")}</p>}
      {error && !titleInvalid ? <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
      <div className="sticky -bottom-4 z-10 -mx-4 -mb-4 flex flex-wrap gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:mb-0 sm:bg-transparent sm:px-0 sm:pb-0">
        <Button className="min-h-11 flex-1" disabled={isUploading}>{isUploading ? <Loader2 className="animate-spin" /> : null}{isUploading ? t("submitting") : t(role === "staff" ? "submit" : "submitTicket")}</Button>
        {isUploading ? <Button type="button" variant="outline" className="min-h-11" onClick={() => owner.cancel()}>{t("cancelUpload")}</Button> : null}
      </div>
    </form>
    <Dialog open={active && selectedMediaId !== null} onOpenChange={open => !open && setSelectedMediaId(null)}
      title={items[selectedMediaIndex]?.file.name ?? t("annotateMedia")} description={t("annotateDescription")} mobileFullScreen>
      <Suspense fallback={<p role="status">{t("syncing")}</p>}><MediaViewer key={selectedMediaId ?? "pending-media"} media={viewerMedia} annotations={viewerAnnotations}
        initialIndex={selectedMediaIndex} disabled={isUploading} onCreateAnnotation={createPendingAnnotation}
        onUpdateAnnotation={updatePendingAnnotation} onDeleteAnnotation={deletePendingAnnotation} /></Suspense>
    </Dialog>
    <AlertDialog open={active && pendingRemoval !== null} onOpenChange={open => !open && setPendingRemoval(null)} title={t("removeMediaPins")}
      description={t("removeMediaDescription", { name: pendingRemoval?.file.name ?? t("media"), count: pendingRemoval ? annotationCounts[pendingRemoval.id] ?? 0 : 0 })}
      confirmLabel={t("removeMedia")} onConfirm={() => { if (pendingRemoval) removePendingItem(pendingRemoval); }} />
  </>;
}
