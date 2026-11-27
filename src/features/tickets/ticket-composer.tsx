import { attachmentName } from "@/lib/attachment-names";
import { TicketRoutingFields } from "@/features/routing/ticket-routing-fields";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/lib/i18n";
import { canMarkupImage, type PendingMedia } from "@/lib/types";
import { ChevronDown, Loader2, Pencil } from "lucide-react";
import { lazy, Suspense, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { MediaViewerHandle } from "@/components/media-viewer";
import type { DisposableTicketDraft } from "./draft";
import { useTicketDraft } from "./use-composer";
import type { Id } from "@convex/_generated/dataModel";
import { DESCRIPTION_MAX_LENGTH, ticketDraftIssue, TITLE_MAX_LENGTH } from "./composer-validation";

const ImageMarkupEditor = lazy(() => import("@/components/image-markup-editor").then(module => ({ default: module.ImageMarkupEditor })));
const MediaViewer = lazy(() => import("@/components/media-viewer").then(module => ({ default: module.MediaViewer })));
const MediaUploadField = lazy(() => import("@/components/media-upload").then(module => ({ default: module.MediaUploadField })));

/** Presentation never owns files: closing, previewing, and remounting keep the
 * Project-bound draft and its retry identity in the existing draft controller. */
export function TicketComposer({ draftOwner, active, role, onSubmitted }: {
  draftOwner: DisposableTicketDraft;
  active: boolean;
  role: "staff" | "customer";
  onSubmitted: (id?: Id<"tickets">) => void;
}) {
  const { t } = useI18n();
  const { owner, mediaEnabled, title, description, items, annotations, error, progress, retryLocked, setTitle, setDescription,
    setItems, setError, routingClassification, viewerMedia, viewerAnnotations, annotationCounts,
    createPendingAnnotation, updatePendingAnnotation, deletePendingAnnotation, submit: submitDraft } = useTicketDraft(draftOwner);
  const [editingItem, setEditingItem] = useState<PendingMedia | null>(null);
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);
  const [viewIndex, setViewIndex] = useState(0);
  const [editingDirty, setEditingDirty] = useState(false);
  const [discardingEdits, setDiscardingEdits] = useState(false);
  const viewerRef = useRef<MediaViewerHandle>(null);
  const [pendingRemoval, setPendingRemoval] = useState<PendingMedia | null>(null);
  const [preview, setPreview] = useState(false);
  const [titleInvalid, setTitleInvalid] = useState(false);
  const isUploading = progress !== null;
  const editsDisabled = isUploading || Boolean(retryLocked);
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
    if (mediaEnabled === undefined) return;
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

  function openMedia(item: PendingMedia) {
    const index = items.findIndex(candidate => candidate.id === item.id);
    if (index < 0) return;
    setViewIndex(index);
    setSelectedMediaId(item.id);
  }

  function closeEditor() {
    setEditingItem(null);
    setEditingDirty(false);
  }

  function requestCloseEditor() {
    if (editingDirty) setDiscardingEdits(true);
    else closeEditor();
  }

  function requestCloseViewer() {
    if (viewerRef.current) viewerRef.current.requestClose(() => setSelectedMediaId(null));
    else setSelectedMediaId(null);
  }

  const markupDialog = <Dialog open={active && editingItem !== null} onOpenChange={open => { if (!open) requestCloseEditor(); }}
      title={t("editDraftImage")} placement="fullscreen" mobileWorkspace>
      {active && editingItem && <Suspense fallback={<p role="status">{t("syncing")}</p>}>
        <ImageMarkupEditor key={editingItem.previewUrl} item={editingItem}
          pins={viewerAnnotations.filter(pin => items[pin.mediaIndex]?.id === editingItem.id)}
          onCancel={requestCloseEditor}
          onDirtyChange={setEditingDirty}
          onApply={(file, crop) => {
            const applied = owner.applyImageEdit(editingItem, file, crop);
            if (applied) {
              if (selectedMediaId === null && window.matchMedia("(max-width: 639px)").matches) openMedia(editingItem);
              closeEditor();
            }
            return applied;
          }} />
      </Suspense>}
      <AlertDialog open={discardingEdits} onOpenChange={setDiscardingEdits}
        title={t("discardImageTitle")} description={t("discardImageDescription")} confirmLabel={t("discardChanges")} onConfirm={closeEditor} />
    </Dialog>;

  const viewed = items[viewIndex];
  const generatedName = !viewed?.name && /^image-[a-f\d-]{36}\.(?:png|jpg)$/i.test(viewed?.file.name ?? "");
  const mediaTitle = generatedName
    ? t(viewed?.isVideo ? "attachmentVideo" : "attachmentPhoto", { number: viewIndex + 1 })
    : (viewed ? attachmentName(viewed) : t("annotateMedia"));

  return <>
    <form className="space-y-4" onSubmit={submit} noValidate aria-busy={isUploading}>
      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor={titleId}>{t("topic")} <span className="text-muted-foreground">{t("composerRequired")}</span></label>
        <Input disabled={editsDisabled} id={titleId} value={title} required aria-invalid={titleInvalid || undefined}
          aria-describedby={titleInvalid ? `${titleId}-error` : undefined} maxLength={TITLE_MAX_LENGTH}
          placeholder={t("topicPlaceholder")} onChange={event => {
            setTitle(event.target.value);
            if (titleInvalid) { setTitleInvalid(false); setError(null); }
          }} />
        {titleInvalid ? <p id={`${titleId}-error`} className="text-sm text-destructive">{t("requiredTitle")}</p> : null}
      </div>
      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor={descriptionId}>{t("description")}</label>
        <Textarea disabled={editsDisabled} id={descriptionId} rows={4} maxLength={DESCRIPTION_MAX_LENGTH} value={description}
          placeholder={t("descriptionPlaceholder")} onChange={event => setDescription(event.target.value)} />
      </div>
      {mediaEnabled && <div className="space-y-2">
        <p className="text-sm font-medium">{t("media")}</p>
        <Suspense fallback={<p role="status" className="text-sm text-muted-foreground">{t("syncing")}</p>}><MediaUploadField items={items} ticketTitle={title} onRenameAttachment={owner.renameAttachment} onItemsChange={setItems} onFilesAdded={owner.addFiles}
          onEditImage={setEditingItem} onPreviewItem={openMedia} onRequestRemove={requestPendingItemRemoval}
          annotationCounts={annotationCounts} disabled={!active || editsDisabled} /></Suspense>
        {items.length ? <p className="text-sm leading-5 text-muted-foreground">{annotations.length ? t("pinSummary", { count: annotations.length }) : t("pinHint")}</p> : null}
      </div>}
      <TicketRoutingFields projectId={owner.projectId} value={routingClassification}
        onChange={owner.setRoutingClassification} disabled={editsDisabled} />
      <div className="rounded-md border border-border/60">
        <Button type="button" className="group h-auto min-h-11 w-full justify-between gap-2 whitespace-normal px-3 py-2 text-left" variant="ghost"
          disabled={isUploading} aria-expanded={preview} aria-controls={`${titleId}-preview`} onClick={() => setPreview(value => !value)}>
          {t(preview ? "composerHidePreview" : "composerPreview")}
          <ChevronDown aria-hidden="true" className="group-aria-expanded:rotate-180" />
        </Button>
        <section id={`${titleId}-preview`} aria-label={t("composerPreview")} hidden={!preview} className="space-y-2 px-3 pb-3">
          <h3 className="break-words font-semibold">{title.trim() || t("composerUntitled")}</h3>
          <p className="whitespace-pre-wrap break-words text-sm">{description.trim() || t("noDescription")}</p>
          {mediaEnabled && <p className="text-sm text-muted-foreground">{t("reviewMedia", { count: items.length })} · {t("reviewPins", { count: annotations.length })}</p>}
          {mediaEnabled && items.length > 0 && <ul className="space-y-1 text-sm text-muted-foreground">
            {items.map(item => <li key={item.id} className="[overflow-wrap:anywhere]">{attachmentName(item)}</li>)}
          </ul>}
        </section>
      </div>
      {mediaEnabled && progress !== null ? <div role="progressbar" aria-label={t("submitting")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} className="h-2 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
      </div> : null}
      {(title || description || items.length > 0) && <p className="text-xs text-muted-foreground">{t("draftSessionHint")}</p>}
      {retryLocked && !isUploading && <p role="status" className="text-sm">{t("retryFrozenTicket")}</p>}
      {error && !titleInvalid ? <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
      <div className="aurora-composer-footer aurora-dialog-edge sticky bottom-0 z-10 -mx-4 flex flex-wrap gap-2 border-t border-border/60 px-4 py-3 sm:static sm:mx-0 sm:mb-0 sm:border-t-0 sm:bg-transparent sm:px-0 sm:pb-0">
        <Button className="min-h-11 flex-1" disabled={isUploading || mediaEnabled === undefined}>{isUploading ? <Loader2 className="animate-spin" /> : null}{isUploading ? t("submitting") : t("submitTicket")}</Button>
        {mediaEnabled && isUploading ? <Button type="button" variant="outline" className="min-h-11" onClick={() => owner.cancel()}>{t("cancelUpload")}</Button> : null}
      </div>
    </form>
    {mediaEnabled && <><Dialog open={active && selectedMediaId !== null} onOpenChange={open => { if (!open) requestCloseViewer(); }}
      title={mediaTitle} description={t("annotateDescription")} mobileFullScreen mobileWorkspace>
      <Suspense fallback={<p role="status">{t("syncing")}</p>}><MediaViewer ref={viewerRef} key={selectedMediaId ?? "pending-media"} media={viewerMedia} annotations={viewerAnnotations}
        initialIndex={selectedMediaIndex} disabled={editsDisabled} workspace onMediaChange={setViewIndex}
        renderImageAction={index => {
          const item = items[index];
          return item && canMarkupImage(item.file)
            ? <Button type="button" size="touch" variant="outline" onClick={() => setEditingItem(item)}>
                <Pencil aria-hidden="true" />{t("editDraftImage")}
              </Button>
            : null;
        }}
        onCreateAnnotation={createPendingAnnotation}
        onUpdateAnnotation={updatePendingAnnotation} onDeleteAnnotation={deletePendingAnnotation} /></Suspense>
      {selectedMediaId !== null && markupDialog}
    </Dialog>
    {selectedMediaId === null && markupDialog}
    <AlertDialog open={active && pendingRemoval !== null} onOpenChange={open => !open && setPendingRemoval(null)} title={t("removeMediaPins")}
      description={t("removeMediaDescription", { name: pendingRemoval ? attachmentName(pendingRemoval) : t("media"), count: pendingRemoval ? annotationCounts[pendingRemoval.id] ?? 0 : 0 })}
      confirmLabel={t("removeMedia")} onConfirm={() => { if (pendingRemoval) removePendingItem(pendingRemoval); }} /></>}
  </>;
}
