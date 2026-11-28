import { AttachmentFilename } from "@/components/attachment-filename";
import { attachmentName } from "@/lib/attachment-names";
import { canMarkupImage, type PendingMedia } from "@/lib/types";
import { CameraCaptureDialog } from "@/components/camera-capture-dialog";
import { Sortable, SortableItem, SortableItemHandle } from "@/components/reui/sortable";
import { Button } from "@/components/ui/button";
import { supportsCamera } from "@/lib/camera";
import { useI18n } from "@/lib/i18n";
import {
  computeMediaCapacity,
  mediaUxCopy,
  partitionMediaFiles,
  stepDragCueState,
  validateCapturedPhoto,
  type DragCueEvent,
  type DragCueState,
} from "@/lib/media-ux-copy";
import { cn } from "@/lib/utils";
import {
  Camera,
  ChevronDown,
  ClipboardPaste,
  FileImage,
  GripVertical,
  MapPin,
  Pencil,
  PlayCircle,
  Star,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

type SelectionSummary = {
  added: number;
  skipped: number;
  reasons: string[];
  nonce: number;
};

export function MediaUploadField({
  items,
  ticketTitle,
  onRenameAttachment,
  onItemsChange,
  onFilesAdded,
  onPreviewItem,
  onEditImage,
  onRequestRemove,
  annotationCounts = {},
  disabled = false,
}: {
  items: PendingMedia[];
  ticketTitle: string;
  onRenameAttachment: (id: string, name?: string) => void;
  onItemsChange: (items: PendingMedia[]) => void;
  onFilesAdded: (files: File[]) => void;
  onEditImage?: (item: PendingMedia) => void;
  onPreviewItem?: (item: PendingMedia) => void;
  onRequestRemove: (item: PendingMedia) => void;
  annotationCounts?: Record<string, number>;
  disabled?: boolean;
}) {
  const { t, language } = useI18n();
  const copy = mediaUxCopy(language);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  if (disabled && cameraOpen) setCameraOpen(false);
  const [isDragging, setDragging] = useState(false);
  const dragStateRef = useRef<DragCueState>({ depth: 0, active: false });
  const [positioning, setPositioning] = useState<string | null>(null);
  const orderHint = useId();
  const positionId = useId();
  const reasonsId = useId();
  const noteBadgePrefix = useId();
  const positionIndex = items.findIndex((item) => item.id === positioning);
  const field = useRef<HTMLDivElement>(null);
  const returnToHandle = useRef<string | null>(null);
  const [selectionSummary, setSelectionSummary] = useState<SelectionSummary | null>(null);
  const [reasonsExpanded, setReasonsExpanded] = useState(false);
  const [pasteNotice, setPasteNotice] = useState<string | null>(null);

  const capacity = computeMediaCapacity(items);
  const supportsClipboardRead =
    typeof navigator !== "undefined" && typeof navigator.clipboard?.read === "function";

  const applyDragEvent = useCallback((event: DragCueEvent) => {
    const next = stepDragCueState(dragStateRef.current, event);
    dragStateRef.current = next;
    setDragging(next.active);
  }, []);

  useEffect(() => {
    if (!disabled) return;
    applyDragEvent({ type: "reset" });
  }, [disabled, applyDragEvent]);

  useLayoutEffect(() => {
    if (positioning !== null || returnToHandle.current === null) return;
    field.current
      ?.querySelector<HTMLButtonElement>(`[data-order-handle="${CSS.escape(returnToHandle.current)}"]`)
      ?.focus();
    returnToHandle.current = null;
  }, [positioning]);

  function closePosition(id: string) {
    returnToHandle.current = id;
    setPositioning(null);
  }

  function placeFile(from: number, to: number) {
    const reordered = [...items];
    const [file] = reordered.splice(from, 1);
    reordered.splice(to, 0, file);
    onItemsChange(reordered);
    closePosition(file.id);
  }

  const addFiles = useCallback(
    (list: FileList | File[]) => {
      if (disabled) return;
      const incoming = Array.from(list);
      if (incoming.length === 0) return;

      const { accepted, rejected } = partitionMediaFiles(incoming, items);
      const reasons = rejected.map(({ file, code }) => `${file.name}: ${t(code)}`);

      setPasteNotice(null);
      setReasonsExpanded(false);
      setSelectionSummary((previous) => ({
        added: accepted.length,
        skipped: rejected.length,
        reasons,
        nonce: (previous?.nonce ?? 0) + 1,
      }));

      if (accepted.length > 0) {
        onFilesAdded(accepted);
      }
    },
    [items, onFilesAdded, t, disabled],
  );

  function handleRegionPaste(event: React.ClipboardEvent<HTMLDivElement>) {
    if (disabled) return;
    const target = event.target as Element | null;
    if (target?.closest('input, textarea, [contenteditable=""], [contenteditable="true"]')) {
      return;
    }
    const files = Array.from(event.clipboardData?.files ?? []).filter(
      (file) => file.type.startsWith("image/") || file.type.startsWith("video/"),
    );
    if (files.length > 0) {
      event.preventDefault();
      addFiles(files);
    }
  }

  async function handleClipboardPasteAction() {
    if (disabled || !supportsClipboardRead) return;
    setPasteNotice(null);
    try {
      const clipboardItems = await navigator.clipboard.read();
      const extracted: File[] = [];
      let index = 0;
      for (const clipboardItem of clipboardItems) {
        const mediaType = clipboardItem.types.find(
          (type) => type.startsWith("image/") || type.startsWith("video/"),
        );
        if (!mediaType) continue;
        const blob = await clipboardItem.getType(mediaType);
        const ext = mediaType.split("/")[1]?.split(";")[0] || "bin";
        index += 1;
        extracted.push(new File([blob], `pasted-${Date.now()}-${index}.${ext}`, { type: mediaType }));
      }
      if (extracted.length === 0) {
        setPasteNotice(copy.pasteNoMedia);
        return;
      }
      addFiles(extracted);
    } catch {
      setPasteNotice(copy.pasteUnavailable);
    }
  }

  function removeItem(id: string) {
    const target = items.find((item) => item.id === id);
    if (target) onRequestRemove(target);
  }

  function handleDragEnter(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (disabled) return;
    applyDragEvent({ type: "enter" });
  }

  function handleDragOver(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (disabled) return;
    applyDragEvent({ type: "over" });
  }

  function handleDragLeave(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (disabled) {
      applyDragEvent({ type: "reset" });
      return;
    }
    const next = event.relatedTarget instanceof Node ? event.relatedTarget : null;
    const targetPosition =
      next === null ? "unknown" : event.currentTarget.contains(next) ? "inside" : "outside";
    applyDragEvent({ type: "leave", targetPosition });
  }

  function handleDragEnd() {
    applyDragEvent({ type: "reset" });
  }

  function onDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    applyDragEvent({ type: "reset" });
    if (disabled) return;
    if (event.dataTransfer.files.length > 0) addFiles(event.dataTransfer.files);
  }

  function openCamera() {
    if (supportsCamera(window.navigator.mediaDevices)) {
      setCameraOpen(true);
      return;
    }
    cameraInputRef.current?.click();
  }

  const validateCapture = useCallback(
    (file: File) => {
      const code = validateCapturedPhoto(file, items);
      return code ? t(code) : null;
    },
    [items, t],
  );

  return (
    <div
      className={cn(
        "relative space-y-3 rounded-xl transition-colors",
        isDragging && "bg-primary/5 ring-2 ring-primary/60",
      )}
      ref={field}
      data-slot="media-upload-dropzone"
      data-dragging={isDragging || undefined}
      onPaste={handleRegionPaste}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDragEnd={handleDragEnd}
      onDrop={onDrop}
    >
      {isDragging ? (
        <div
          data-drop-cue="active"
          aria-hidden="true"
          className="pointer-events-none flex items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary bg-primary/10 px-3 py-2 text-xs font-medium text-primary"
        >
          <FileImage className="size-4 shrink-0" />
          <span>{copy.dropActive}</span>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          className="h-11 min-w-[8.5rem] flex-1 rounded-xl"
          variant="outline"
          disabled={disabled}
          onClick={openCamera}
        >
          <Camera aria-hidden="true" />
          {t("takePhoto")}
        </Button>
        <Button
          type="button"
          className="h-11 min-w-[8.5rem] flex-1 rounded-xl"
          variant="outline"
          disabled={disabled}
          data-slot="choose-draft-files"
          onClick={() => uploadInputRef.current?.click()}
        >
          <Upload aria-hidden="true" />
          {t("chooseFiles")}
        </Button>
        {supportsClipboardRead ? (
          <Button
            type="button"
            className="h-11 shrink-0 rounded-xl"
            variant="outline"
            disabled={disabled}
            onClick={() => void handleClipboardPasteAction()}
          >
            <ClipboardPaste aria-hidden="true" />
            {copy.pasteFromClipboard}
          </Button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span data-slot="photo-capacity" className="rounded-md bg-muted/60 px-2 py-0.5 font-medium">
          {copy.photoSlots(capacity.imageUsed, capacity.imageLimit, capacity.imageRemaining)}
        </span>
        <span data-slot="video-capacity" className="rounded-md bg-muted/60 px-2 py-0.5 font-medium">
          {copy.videoSlots(capacity.videoUsed, capacity.videoLimit, capacity.videoRemaining)}
        </span>
      </div>

      {selectionSummary ? (
        <div
          key={selectionSummary.nonce}
          role={selectionSummary.skipped > 0 ? "alert" : "status"}
          className={cn(
            "space-y-1.5 rounded-xl border px-3 py-2 text-sm",
            selectionSummary.skipped > 0
              ? "border-destructive/20 bg-destructive/10 text-destructive"
              : "border-border/60 bg-muted/40 text-foreground",
          )}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-medium">
              {copy.selectionSummary(selectionSummary.added, selectionSummary.skipped)}
            </p>
            {selectionSummary.reasons.length > 0 ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-auto min-h-9 px-2 text-xs text-current hover:bg-destructive/10"
                aria-expanded={reasonsExpanded}
                aria-controls={reasonsId}
                onClick={() => setReasonsExpanded((open) => !open)}
              >
                {reasonsExpanded
                  ? copy.hideReasons
                  : copy.showReasons(selectionSummary.reasons.length)}
                <ChevronDown
                  aria-hidden="true"
                  className={cn("size-3.5 transition-transform", reasonsExpanded && "rotate-180")}
                />
              </Button>
            ) : null}
          </div>
          {selectionSummary.reasons.length > 0 && reasonsExpanded ? (
            <ul id={reasonsId} className="list-disc space-y-1 pl-5 text-xs leading-5">
              {selectionSummary.reasons.map((message, reasonIndex) => (
                <li key={`${reasonIndex}-${message}`} className="[overflow-wrap:anywhere]">
                  {message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {pasteNotice ? (
        <p role="status" className="text-xs text-muted-foreground">
          {pasteNotice}
        </p>
      ) : null}

      <input
        ref={cameraInputRef}
        className="hidden"
        disabled={disabled}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(event) => {
          if (event.target.files) addFiles(event.target.files);
          event.target.value = "";
        }}
      />
      <CameraCaptureDialog
        open={cameraOpen}
        onOpenChange={setCameraOpen}
        onCapture={(file) => addFiles([file])}
        onUseFilePicker={() => cameraInputRef.current?.click()}
        validateCapture={validateCapture}
      />
      <input
        ref={uploadInputRef}
        data-slot="ticket-draft-files"
        className="hidden"
        disabled={disabled}
        type="file"
        accept="image/*,video/*"
        multiple
        onChange={(event) => {
          if (event.target.files) addFiles(event.target.files);
          event.target.value = "";
        }}
      />

      {items.length === 0 ? (
        <div
          tabIndex={disabled ? undefined : 0}
          className="hidden min-h-16 w-full items-center justify-center gap-3 rounded-xl border border-dashed bg-muted/30 px-4 py-3 text-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex"
        >
          <FileImage className="size-5 shrink-0" aria-hidden="true" />
          <span>{t("dropMedia")}</span>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 rounded-xl bg-muted/45 px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-medium">{t("filesReady", { count: items.length })}</p>
              <p id={orderHint} className="text-xs leading-4 text-muted-foreground">
                {t("reorderHint")}
              </p>
            </div>
          </div>
          {positionIndex >= 0 && (
            <fieldset
              id={positionId}
              className="flex flex-wrap items-center gap-1.5 rounded-md border border-transparent bg-muted/40 p-2"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  closePosition(items[positionIndex].id);
                }
              }}
            >
              <legend className="px-1 text-sm">
                {t("filePosition", { name: attachmentName(items[positionIndex]) })}
              </legend>
              {positionIndex > 0 && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="min-h-11"
                  onClick={() => placeFile(positionIndex, 0)}
                >
                  <Star aria-hidden="true" />
                  {copy.makeCover}
                </Button>
              )}
              {items.map((file, index) => (
                <button
                  type="button"
                  key={file.id}
                  autoFocus={index === positionIndex}
                  aria-pressed={index === positionIndex}
                  className="min-h-11 min-w-11 rounded-md border border-transparent bg-muted/40 px-2 aria-pressed:bg-muted focus-visible:ring-2"
                  onClick={() => placeFile(positionIndex, index)}
                >
                  {index + 1}
                </button>
              ))}
            </fieldset>
          )}
          <Sortable
            value={items}
            onValueChange={onItemsChange}
            getItemValue={(item) => item.id}
            strategy="grid"
            className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4"
          >
            {items.map((item, index) => {
              const noteCount = annotationCounts[item.id] ?? 0;
              const noteBadgeId = `${noteBadgePrefix}-${item.id}`;
              return (
                <SortableItem key={item.id} value={item.id} disabled={disabled}>
                  <div className="group relative aspect-square overflow-hidden rounded-xl border bg-black shadow-sm">
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => onPreviewItem?.(item)}
                      aria-label={t("openMedia", { name: attachmentName(item) })}
                      aria-describedby={noteCount > 0 ? noteBadgeId : undefined}
                      className="absolute inset-0 block h-full w-full disabled:cursor-not-allowed"
                    >
                      {item.isVideo ? (
                        <>
                          <video
                            className="h-full w-full object-cover opacity-80"
                            src={item.previewUrl}
                            muted
                            playsInline
                            preload="metadata"
                          />
                          <PlayCircle
                            aria-hidden="true"
                            className="pointer-events-none absolute left-1/2 top-1/2 size-6 -translate-x-1/2 -translate-y-1/2 text-white"
                          />
                        </>
                      ) : (
                        <img
                          className="h-full w-full object-cover"
                          src={item.previewUrl}
                          alt={attachmentName(item)}
                        />
                      )}
                    </button>
                    {index === 0 ? (
                      <span className="pointer-events-none absolute bottom-1 left-1 rounded bg-black/75 px-1.5 py-0.5 text-xs font-medium text-white">
                        {t("cover")}
                      </span>
                    ) : null}
                    {noteCount > 0 ? (
                      <span
                        id={noteBadgeId}
                        className="pointer-events-none absolute bottom-1 right-1 flex items-center gap-1 rounded bg-black/75 px-1.5 py-0.5 text-xs font-medium text-white"
                      >
                        <MapPin className="size-3" aria-hidden="true" />
                        {copy.noteCount(noteCount)}
                      </span>
                    ) : null}
                    {items.length > 1 && (
                      <SortableItemHandle
                        render={<button type="button" disabled={disabled} />}
                        data-order-handle={item.id}
                        aria-label={t("reorderFile", { name: attachmentName(item) })}
                        aria-describedby={orderHint}
                        aria-expanded={positioning === item.id}
                        aria-controls={positionId}
                        onClick={() => setPositioning((current) => (current === item.id ? null : item.id))}
                        onKeyDownCapture={(event) => {
                          // Enter and Space activate the position chooser; pointer dragging uses the same handle.
                          if (event.key === "Enter" || event.key === " ") event.stopPropagation();
                        }}
                        className="absolute left-1 top-1 z-10"
                      >
                        <span className="flex size-11 items-center justify-center rounded-full border bg-background/90 shadow-sm">
                          <GripVertical className="size-4" aria-hidden="true" />
                        </span>
                      </SortableItemHandle>
                    )}
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => removeItem(item.id)}
                      aria-label={t("removeFile", { name: attachmentName(item) })}
                      className="absolute right-1 top-1 z-10 flex size-10 items-center justify-center rounded-full border bg-background/90 shadow-sm hover:bg-destructive hover:text-destructive-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <X className="size-4" aria-hidden="true" />
                    </button>
                  </div>
                  <AttachmentFilename
                    item={item}
                    ticketTitle={ticketTitle}
                    position={index + 1}
                    onRename={onRenameAttachment}
                    disabled={disabled}
                  />
                  {onEditImage && canMarkupImage(item.file) && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="min-h-11 w-full"
                      disabled={disabled}
                      aria-label={t("editImageNamed", { name: attachmentName(item) })}
                      onClick={() => onEditImage(item)}
                    >
                      <Pencil aria-hidden="true" /> {t("editDraftImage")}
                    </Button>
                  )}
                </SortableItem>
              );
            })}
          </Sortable>
        </>
      )}

      <p className="text-xs leading-5 text-muted-foreground">{t("uploadLimits")}</p>
    </div>
  );
}
