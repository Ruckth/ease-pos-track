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
import { lazy, Suspense, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { MediaViewerHandle } from "@/components/media-viewer";
import { formatTicketNumber } from "../../../shared/ticket-numbers";
import type { ComposerStep, DisposableTicketDraft } from "./draft";
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
  const { t, language } = useI18n();
  const local = (en: string, th: string) => language === "th" ? th : en;
  const { owner, mediaEnabled, title, description, items, annotations, error, progress, stage, canceled, confirmedId, step, readTicket, retryLocked, setTitle, setDescription,
    setItems, routingClassification, viewerMedia, viewerAnnotations, annotationCounts,
    createPendingAnnotation, updatePendingAnnotation, deletePendingAnnotation, submit: submitDraft } = useTicketDraft(draftOwner);
  const [editingItem, setEditingItem] = useState<PendingMedia | null>(null);
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);
  const [viewIndex, setViewIndex] = useState(0);
  const [editingDirty, setEditingDirty] = useState(false);
  const [discardingEdits, setDiscardingEdits] = useState(false);
  const viewerRef = useRef<MediaViewerHandle>(null);
  const [pendingRemoval, setPendingRemoval] = useState<PendingMedia | null>(null);
  const [preview, setPreview] = useState(false);
  const [issue, setIssue] = useState<ReturnType<typeof ticketDraftIssue>>(null);
  const [receipt, setReceipt] = useState<{ reference: string; projectKey: string } | "loading" | "failed" | null>(null);
  const [focusRequest, setFocusRequest] = useState<string | null>(null);
  const errorSummary = useRef<HTMLDivElement>(null);
  const receiptHeading = useRef<HTMLHeadingElement>(null);
  const busy = owner.isSubmitting();
  const guided = role === "customer" && step !== null;
  const failed = !busy && (Boolean(error) || canceled);
  const titleInvalid = issue === "REQUIRED_TITLE" || issue === "TITLE_TOO_LONG";
  const descriptionInvalid = issue === "DESCRIPTION_TOO_LONG";
  const editsDisabled = busy || Boolean(retryLocked);
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
  const stepHeadingId = `${titleId}-step`;
  const mediaId = `${titleId}-media`;
  const detailRequired = ticketDraftIssue({ title, description }) !== null;
  const currentStep = guided && step !== 1 && detailRequired ? 1 : step === 2 && mediaEnabled === false ? 3 : step;
  const stepTotal = mediaEnabled === false ? 2 : 3;
  const stepNumber = currentStep === 3 && stepTotal === 2 ? 2 : currentStep;

  useLayoutEffect(() => {
    if (!active || !focusRequest) return;
    const target = document.getElementById(focusRequest);
    (target?.querySelector<HTMLElement>('[data-slot="choose-draft-files"]') ?? target)?.focus();
    setFocusRequest(null);
  }, [active, currentStep, focusRequest]);
  useLayoutEffect(() => {
    if (active && failed) errorSummary.current?.focus();
  }, [active, failed]);
  useLayoutEffect(() => {
    if (active && confirmedId) receiptHeading.current?.focus();
  }, [active, confirmedId]);

  function goTo(next: ComposerStep | null, focus = next ? stepHeadingId : titleId) {
    owner.setStep(next);
    setFocusRequest(focus);
  }

  function validateDraft() {
    const nextIssue = ticketDraftIssue({ title, description });
    setIssue(nextIssue);
    if (!nextIssue) return true;
    setFocusRequest(nextIssue === "DESCRIPTION_TOO_LONG" ? descriptionId : titleId);
    if (guided) owner.setStep(1);
    return false;
  }

  async function loadReceipt(id: Id<"tickets">) {
    setReceipt("loading");
    try {
      const ticket = await readTicket(id);
      if (!ticket) { setReceipt("failed"); return; }
      setReceipt({ reference: formatTicketNumber(ticket.ticketNumber, ticket.projectKey), projectKey: ticket.projectKey });
    } catch {
      setReceipt("failed");
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (guided && currentStep !== 3) {
      advanceGuide();
      return;
    }
    if (!validateDraft() || mediaEnabled === undefined) return;
    if (!(await submitDraft())) return;
    const id = owner.lastSubmittedId;
    setSelectedMediaId(null);
    setPendingRemoval(null);
    setPreview(false);
    if (id) void loadReceipt(id);
  }

  function advanceGuide() {
    if (currentStep === 1 && validateDraft()) goTo(mediaEnabled ? 2 : 3);
    else if (currentStep === 2) goTo(3);
  }

  async function copyReceipt(id: Id<"tickets">, projectKey: string) {
    const link = new URL(window.location.pathname, window.location.origin);
    link.searchParams.set("project", projectKey);
    link.searchParams.set("ticket", id);
    try { await navigator.clipboard.writeText(link.href); }
    catch { toast.error(t("ticketCopyFailed")); }
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
      title={t("editDraftImage")} placement="fullscreen" mobileWorkspace workspace>
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

  const titleCounter = title.length >= TITLE_MAX_LENGTH * 0.8;
  const descriptionCounter = description.length >= DESCRIPTION_MAX_LENGTH * 0.8;
  const titleError = titleInvalid ? t(issue === "TITLE_TOO_LONG" ? "titleTooLong" : "requiredTitle") : null;

  if (confirmedId) return <section className="space-y-3" aria-labelledby={`${titleId}-receipt`}>
    <h3 id={`${titleId}-receipt`} ref={receiptHeading} tabIndex={-1} className="text-lg font-semibold">
      {t("ticketSubmitted")}{receipt && typeof receipt === "object" ? ` · ${receipt.reference}` : ""}
    </h3>
    {(!receipt || receipt === "loading") && <p role="status">{t("syncing")}</p>}
    {receipt === "failed" && <p role="status">{local("Your Ticket was saved. Its number could not be loaded.", "บันทึก Ticket แล้ว แต่โหลดเลข Ticket ไม่สำเร็จ")}</p>}
    <div className="flex flex-wrap gap-2">
      <Button type="button" onClick={() => onSubmitted(confirmedId)}>{local("View Ticket", "ดู Ticket")}</Button>
      {receipt === "failed" && <Button type="button" variant="outline" onClick={() => void loadReceipt(confirmedId)}>
        {local("Retry loading Ticket number", "ลองโหลดเลข Ticket อีกครั้ง")}
      </Button>}
      {receipt && typeof receipt === "object" && <Button type="button" variant="outline" onClick={() => void copyReceipt(confirmedId, receipt.projectKey)}>{t("copyTicketLink")}</Button>}
    </div>
  </section>;

  return <>
    <form className="space-y-3 sm:space-y-4" onSubmit={submit} noValidate>
      {guided && <h3 id={stepHeadingId} tabIndex={-1} data-composer-step-heading className="text-lg font-semibold">
        {local(`Step ${stepNumber} of ${stepTotal}`, `ขั้นที่ ${stepNumber} จาก ${stepTotal}`)} · {t(currentStep === 1 ? "stepDetails" : currentStep === 2 ? "stepMedia" : "stepReview")}
      </h3>}
      {(!guided || currentStep === 1) && <div className="space-y-3 sm:space-y-4">
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor={titleId}>{t("topic")} <span aria-hidden="true" className="text-muted-foreground">{t("composerRequired")}</span></label>
          <Input disabled={editsDisabled} id={titleId} value={title} required aria-invalid={titleInvalid || undefined}
            aria-describedby={[titleInvalid && `${titleId}-error`, titleCounter && `${titleId}-length`].filter(Boolean).join(" ") || undefined} maxLength={TITLE_MAX_LENGTH}
            placeholder={t("topicPlaceholder")} onChange={event => {
              setTitle(event.target.value);
              if (titleInvalid) setIssue(null);
            }} />
          {titleError && <p id={`${titleId}-error`} className="text-sm text-destructive">{titleError}</p>}
          {titleCounter && <p id={`${titleId}-length`} className="text-sm text-muted-foreground">{local(`${title.length} of ${TITLE_MAX_LENGTH} characters`, `${title.length} จาก ${TITLE_MAX_LENGTH} ตัวอักษร`)}</p>}
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor={descriptionId}>{t("description")}</label>
          <p id={`${descriptionId}-guidance`} className="sr-only sm:not-sr-only sm:text-sm sm:text-muted-foreground">{t("descriptionPlaceholder")}</p>
          <Textarea disabled={editsDisabled} id={descriptionId} rows={3} maxLength={DESCRIPTION_MAX_LENGTH} value={description}
            aria-invalid={descriptionInvalid || undefined}
            aria-describedby={[`${descriptionId}-guidance`, descriptionCounter && `${descriptionId}-length`, descriptionInvalid && `${descriptionId}-error`].filter(Boolean).join(" ")}
            onChange={event => { setDescription(event.target.value); if (descriptionInvalid) setIssue(null); }} />
          {descriptionInvalid && <p id={`${descriptionId}-error`} className="text-sm text-destructive">{t("descriptionTooLong")}</p>}
          {descriptionCounter && <p id={`${descriptionId}-length`} className="text-sm text-muted-foreground">{local(`${description.length} of ${DESCRIPTION_MAX_LENGTH} characters`, `${description.length} จาก ${DESCRIPTION_MAX_LENGTH} ตัวอักษร`)}</p>}
        </div>
        <TicketRoutingFields projectId={owner.projectId} value={routingClassification}
          onChange={owner.setRoutingClassification} disabled={editsDisabled} />
      </div>}
      {mediaEnabled && (!guided || currentStep === 2) && <div id={mediaId} role="group" aria-label={t("stepMedia")} tabIndex={-1} className="space-y-2">
        {!guided && <p className="text-sm font-medium">{t("media")}</p>}
        <Suspense fallback={<p role="status" className="text-sm text-muted-foreground">{t("syncing")}</p>}><MediaUploadField items={items} ticketTitle={title} onRenameAttachment={owner.renameAttachment} onItemsChange={setItems} onFilesAdded={owner.addFiles}
          onEditImage={setEditingItem} onPreviewItem={openMedia} onRequestRemove={requestPendingItemRemoval}
          annotationCounts={annotationCounts} disabled={!active || editsDisabled} /></Suspense>
        {items.length ? <p className="text-sm leading-5 text-muted-foreground">{annotations.length ? t("pinSummary", { count: annotations.length }) : t("pinHint")}</p> : null}
      </div>}
      {(!guided || currentStep === 3) && <div className={guided ? "space-y-3" : "border-t border-border/60 sm:rounded-md sm:border"}>
        {!guided && <Button type="button" className="group h-auto min-h-11 w-full justify-between gap-2 whitespace-normal px-3 py-2 text-left" variant="ghost"
          disabled={busy} aria-expanded={preview} aria-controls={`${titleId}-preview`} onClick={() => setPreview(value => !value)}>
          {t(preview ? "composerHidePreview" : "composerPreview")}
          <ChevronDown aria-hidden="true" className="group-aria-expanded:rotate-180" />
        </Button>}
        <section id={`${titleId}-preview`} aria-label={guided ? local("Review Ticket", "ตรวจสอบ Ticket") : t("composerPreview")} hidden={!guided && !preview}
          className={guided ? "space-y-3" : "space-y-3 px-3 pb-3"}>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="font-semibold">{t("reviewTopic")}</h4>
              <Button type="button" variant="ghost" size="sm" disabled={editsDisabled}
                onClick={() => goTo(guided ? 1 : null, titleId)}>{local("Edit Topic", "แก้ไขหัวข้อ")}</Button>
            </div>
            <p className="break-words">{title.trim() || t("composerUntitled")}</p>
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="font-semibold">{t("reviewDescription")}</h4>
              <Button type="button" variant="ghost" size="sm" disabled={editsDisabled}
                onClick={() => goTo(guided ? 1 : null, descriptionId)}>{local("Edit description", "แก้ไขรายละเอียด")}</Button>
            </div>
            <p className="whitespace-pre-wrap break-words text-sm">{description.trim() || t("noDescription")}</p>
          </div>
          {mediaEnabled && <>
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="font-semibold">{t("reviewMedia", { count: items.length })}</h4>
              <Button type="button" variant="ghost" size="sm" disabled={editsDisabled}
                onClick={() => goTo(guided ? 2 : null, mediaId)}>{local("Edit photos & videos", "แก้ไขรูปและวิดีโอ")}</Button>
            </div>
            {items.length > 0 && <ul className="space-y-2">
              {items.map((item, index) => <li key={item.id}>
                <button type="button" disabled={busy} className="flex min-h-11 w-full items-center gap-3 text-left text-sm"
                  onClick={() => openMedia(item)}>
                  {item.isVideo
                    ? <video aria-hidden="true" src={item.previewUrl} className="size-12 shrink-0 rounded object-cover" preload="metadata" muted />
                    : <img alt="" src={item.previewUrl} className="size-12 shrink-0 rounded object-cover" />}
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    <span className="block font-medium">{attachmentName(item)}</span>
                    <span className="text-muted-foreground">
                      {t(item.isVideo ? "attachmentVideoNumber" : "attachmentPhotoNumber", { number: index + 1 })}
                      {(annotationCounts[item.id] ?? 0) > 0 && ` · ${local(`${annotationCounts[item.id]} notes`, `${annotationCounts[item.id]} หมายเหตุ`)}`}
                    </span>
                  </span>
                </button>
              </li>)}
            </ul>}
          </>}
        </section>
      </div>}
      {role === "customer" && !guided && !busy && <Button type="button" variant="ghost" className="min-h-11 px-2 text-sm text-primary" onClick={() => goTo(1)}>
        {local("Use step-by-step guide", "ใช้ตัวช่วยแบบทีละขั้นตอน")}
      </Button>}
      {owner.hasContent() && <p className="text-xs text-muted-foreground">{t("draftSessionHint")}</p>}
      {failed && <div ref={errorSummary} tabIndex={-1} role="group" aria-labelledby={`${titleId}-submit-result`}
        className="rounded-md bg-destructive/10 px-3 py-2 text-sm">
        <div id={`${titleId}-submit-result`}>
          {error && !canceled && <p className="text-destructive">{error}</p>}
          <p>{retryLocked ? t("retryFrozenTicket") : canceled
            ? local("Upload canceled. Your draft is ready to retry.", "ยกเลิกอัปโหลดแล้ว ฉบับร่างพร้อมให้ลองอีกครั้ง")
            : local("Your draft is still here. You can try again.", "ฉบับร่างยังอยู่ คุณลองอีกครั้งได้")}</p>
        </div>
      </div>}
      <div className="aurora-composer-footer aurora-dialog-edge sticky bottom-0 z-10 -mx-4 flex flex-wrap gap-2 border-t border-border/60 px-4 py-1.5 sm:static sm:mx-0 sm:mb-0 sm:border-t-0 sm:bg-transparent sm:px-0 sm:pb-0">
        {busy && <p role="status" className="basis-full text-sm font-medium">
          {stage === "upload" ? local("Uploading attachments…", "กำลังอัปโหลดไฟล์แนบ…")
            : stage === "canceling" ? local("Canceling upload. The draft stays here while cancellation settles.", "กำลังยกเลิกอัปโหลด ฉบับร่างจะยังอยู่ระหว่างรอผล")
            : local("Saving Ticket…", "กำลังบันทึก Ticket…")}
        </p>}
        {stage === "upload" && progress !== null && <div role="progressbar" aria-label={local("Uploading attachments", "กำลังอัปโหลดไฟล์แนบ")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} className="h-2 basis-full overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
        </div>}
        {guided && !busy && <Button type="button" variant="outline" className="min-h-11"
          onClick={() => goTo(currentStep === 1 ? null : currentStep === 2 || !mediaEnabled ? 1 : 2)}>
          {t("back")}
        </Button>}
        <Button className="min-h-11 flex-1" disabled={busy || mediaEnabled === undefined}>{busy ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
          {busy ? t("submitting") : guided && currentStep !== 3 ? t("next") : failed ? local("Retry submission", "ลองส่งอีกครั้ง") : t("submitTicket")}
        </Button>
        {stage === "upload" && <Button type="button" variant="outline" className="min-h-11" onClick={owner.cancel}>{t("cancelUpload")}</Button>}
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
