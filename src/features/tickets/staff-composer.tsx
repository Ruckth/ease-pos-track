import type { PendingMedia } from "@/lib/types";
import { MediaUploadField } from "@/components/media-upload";
import { MediaViewer } from "@/components/media-viewer";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/lib/i18n";
import { Loader2 } from "lucide-react";
import { FormEvent, useState } from "react";
import { toast } from "sonner";
import type { DisposableTicketDraft } from "./draft";
import { useTicketDraft } from "./use-composer";

export function SubmitTicket({
  token,
  draftOwner,
  active,
  onSubmissionComplete,
}: {
  token: string;
  draftOwner: DisposableTicketDraft;
  active: boolean;
  onSubmissionComplete: () => void;
}) {
  const { t } = useI18n();
  const { owner, title, description, items, annotations, error, progress, setTitle, setDescription,
    setItems, setError, viewerMedia, viewerAnnotations, annotationCounts,
    createPendingAnnotation, updatePendingAnnotation, deletePendingAnnotation, submit: submitDraft } = useTicketDraft(token, draftOwner);
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<PendingMedia | null>(null);
  const isUploading = progress !== null;
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
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!title.trim()) { setError(new Error("REQUIRED_TICKET")); return; }
    if (await submitDraft()) {
      setSelectedMediaId(null);
      setPendingRemoval(null);
      toast.success(t("ticketSubmitted"));
      onSubmissionComplete();
    }
  }

  return (
    <>
      <form className="space-y-4" onSubmit={onSubmit}>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="title">
            {t("topic")}
          </label>
          <Input disabled={isUploading} id="title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={100} />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="description">
            {t("description")}
          </label>
          <Textarea disabled={isUploading} id="description" maxLength={10_000} value={description} onChange={(event) => setDescription(event.target.value)} />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">{t("media")}</label>
          <MediaUploadField
            items={items}
            onItemsChange={setItems}
            onFilesAdded={owner.addFiles}
            onPreviewItem={(item) => setSelectedMediaId(item.id)}
            onRequestRemove={requestPendingItemRemoval}
            annotationCounts={annotationCounts}
            disabled={!active || isUploading}
          />
          {items.length > 0 ? (
            <p className="text-sm leading-5 text-muted-foreground">
              {annotations.length > 0
                ? t("pinSummary", { count: annotations.length })
                : t("pinHint")}
            </p>
          ) : null}
        </div>

        {progress !== null ? (
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
          </div>
        ) : null}
        {error ? <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
        <div className="flex gap-2">
          <Button className="flex-1" disabled={isUploading}>
            {isUploading ? <Loader2 className="animate-spin" /> : null}
            {isUploading ? t("submitting") : t("submit")}
          </Button>
          {isUploading ? (
            <Button type="button" variant="outline" onClick={() => owner.cancel()}>
              {t("cancelUpload")}
            </Button>
          ) : null}
        </div>
      </form>

      <Dialog
        open={active && selectedMediaId !== null}
        onOpenChange={(open) => !open && setSelectedMediaId(null)}
        title={items[selectedMediaIndex]?.file.name ?? t("annotateMedia")}
        description={t("annotateDescription")}
      >
        <MediaViewer
          key={selectedMediaId ?? "pending-media"}
          media={viewerMedia}
          annotations={viewerAnnotations}
          initialIndex={selectedMediaIndex}
          disabled={isUploading}
          onCreateAnnotation={createPendingAnnotation}
          onUpdateAnnotation={updatePendingAnnotation}
          onDeleteAnnotation={deletePendingAnnotation}
        />
      </Dialog>

      <AlertDialog
        open={active && pendingRemoval !== null}
        onOpenChange={(open) => !open && setPendingRemoval(null)}
        title={t("removeMediaPins")}
        description={t("removeMediaDescription", { name: pendingRemoval?.file.name ?? t("media"), count: pendingRemoval ? annotationCounts[pendingRemoval.id] ?? 0 : 0 })}
        confirmLabel={t("removeMedia")}
        onConfirm={() => {
          if (pendingRemoval) removePendingItem(pendingRemoval);
        }}
      />
    </>
  );
}
