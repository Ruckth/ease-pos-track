import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, GripVertical, ImagePlus, MapPin, PlayCircle, Upload, X } from "lucide-react";
import { Sortable, SortableItem, SortableItemHandle } from "@/components/reui/sortable";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type PendingMedia = {
  id: string;
  file: File;
  previewUrl: string;
  isVideo: boolean;
};

const IMAGE_LIMIT = 10;
const VIDEO_LIMIT = 3;
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const VIDEO_MAX_BYTES = 64 * 1024 * 1024;

export function releasePendingMedia(items: PendingMedia[]) {
  for (const item of items) {
    URL.revokeObjectURL(item.previewUrl);
  }
}

export function MediaUploadField({
  items,
  onItemsChange,
  onPreviewItem,
  onRequestRemove,
  annotationCounts = {},
  disabled = false,
}: {
  items: PendingMedia[];
  onItemsChange: (items: PendingMedia[]) => void;
  onPreviewItem?: (item: PendingMedia) => void;
  onRequestRemove?: (item: PendingMedia) => void;
  annotationCounts?: Record<string, number>;
  disabled?: boolean;
}) {
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setDragging] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    return () => releasePendingMedia(itemsRef.current);
  }, []);

  const addFiles = useCallback(
    (list: FileList | File[]) => {
      const accepted: PendingMedia[] = [];
      const problems: string[] = [];
      let imageCount = items.filter((item) => !item.isVideo).length;
      let videoCount = items.filter((item) => item.isVideo).length;

      for (const file of Array.from(list)) {
        const isVideo = file.type.startsWith("video/");
        const isImage = file.type.startsWith("image/");
        if (!isVideo && !isImage) {
          problems.push(`${file.name}: only images and videos are supported`);
          continue;
        }
        if (isImage && file.size > IMAGE_MAX_BYTES) {
          problems.push(`${file.name}: images must be 8MB or smaller`);
          continue;
        }
        if (isVideo && file.size > VIDEO_MAX_BYTES) {
          problems.push(`${file.name}: videos must be 64MB or smaller`);
          continue;
        }
        if (isImage && imageCount >= IMAGE_LIMIT) {
          problems.push(`${file.name}: up to ${IMAGE_LIMIT} images allowed`);
          continue;
        }
        if (isVideo && videoCount >= VIDEO_LIMIT) {
          problems.push(`${file.name}: up to ${VIDEO_LIMIT} videos allowed`);
          continue;
        }
        if (isImage) imageCount += 1;
        else videoCount += 1;
        accepted.push({
          id: crypto.randomUUID(),
          file,
          previewUrl: URL.createObjectURL(file),
          isVideo,
        });
      }

      setErrors(problems);
      if (accepted.length > 0) {
        onItemsChange([...items, ...accepted]);
      }
    },
    [items, onItemsChange],
  );

  useEffect(() => {
    if (disabled) return;

    const onPaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []).filter(
        (file) => file.type.startsWith("image/") || file.type.startsWith("video/"),
      );
      if (files.length > 0) addFiles(files);
    };

    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [addFiles, disabled]);

  function removeItem(id: string) {
    const target = items.find((item) => item.id === id);
    if (target && onRequestRemove) {
      onRequestRemove(target);
      return;
    }
    if (target) URL.revokeObjectURL(target.previewUrl);
    onItemsChange(items.filter((item) => item.id !== id));
  }

  function onDrop(event: React.DragEvent) {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    if (event.dataTransfer.files.length > 0) addFiles(event.dataTransfer.files);
  }

  return (
    <div
      className="space-y-3"
      onDragEnter={(event) => {
        event.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        event.preventDefault();
        setDragging(false);
      }}
      onDrop={onDrop}
    >
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" variant="outline" disabled={disabled} onClick={() => cameraInputRef.current?.click()}>
          <Camera />
          Camera
        </Button>
        <Button type="button" variant="outline" disabled={disabled} onClick={() => uploadInputRef.current?.click()}>
          <Upload />
          Upload
        </Button>
      </div>
      <input
        ref={cameraInputRef}
        className="hidden"
        type="file"
        accept="image/*,video/*"
        capture="environment"
        onChange={(event) => {
          if (event.target.files) addFiles(event.target.files);
          event.target.value = "";
        }}
      />
      <input
        ref={uploadInputRef}
        className="hidden"
        type="file"
        accept="image/*,video/*"
        multiple
        onChange={(event) => {
          if (event.target.files) addFiles(event.target.files);
          event.target.value = "";
        }}
      />

      {items.length === 0 ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => uploadInputRef.current?.click()}
          className={cn(
            "grid aspect-video w-full place-items-center rounded-lg border border-dashed bg-muted/40 text-sm text-muted-foreground transition-colors",
            isDragging && "border-primary bg-primary/5 text-primary",
          )}
        >
          <span className="px-4 text-center">
            Drop, paste, or tap to add photos and videos
            <span className="mt-1 block text-xs">First image becomes the cover. Drag tiles to reorder.</span>
          </span>
        </button>
      ) : (
        <>
          <Sortable
            value={items}
            onValueChange={onItemsChange}
            getItemValue={(item) => item.id}
            strategy="grid"
            className={cn("grid grid-cols-3 gap-2", isDragging && "rounded-lg ring-2 ring-primary/50")}
          >
            {items.map((item, index) => (
              <SortableItem key={item.id} value={item.id} disabled={disabled}>
                <div className="group relative aspect-square overflow-hidden rounded-md border bg-black">
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => onPreviewItem?.(item)}
                    aria-label={`Open ${item.file.name} to add pins`}
                    className="absolute inset-0 block h-full w-full disabled:cursor-not-allowed"
                  >
                    {item.isVideo ? (
                      <>
                        <video className="h-full w-full object-cover opacity-80" src={item.previewUrl} muted playsInline preload="metadata" />
                        <PlayCircle className="pointer-events-none absolute left-1/2 top-1/2 size-6 -translate-x-1/2 -translate-y-1/2 text-white" />
                      </>
                    ) : (
                      <img className="h-full w-full object-cover" src={item.previewUrl} alt={item.file.name} />
                    )}
                  </button>
                  {index === 0 ? (
                    <span className="pointer-events-none absolute bottom-1 left-1 rounded bg-black/70 px-1.5 py-0.5 text-xs font-medium text-white">
                      Cover
                    </span>
                  ) : null}
                  {(annotationCounts[item.id] ?? 0) > 0 ? (
                    <span className="pointer-events-none absolute bottom-1 right-1 flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-xs font-medium text-white">
                      <MapPin className="size-3" />
                      {annotationCounts[item.id]}
                    </span>
                  ) : null}
                  <SortableItemHandle className="absolute left-1 top-1 z-10">
                    <span className="flex size-6 items-center justify-center rounded-full border bg-background/90 shadow-sm">
                      <GripVertical className="size-3.5" />
                    </span>
                  </SortableItemHandle>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => removeItem(item.id)}
                    aria-label={`Remove ${item.file.name}`}
                    className="absolute right-1 top-1 z-10 flex size-6 items-center justify-center rounded-full border bg-background/90 shadow-sm hover:bg-destructive hover:text-white"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              </SortableItem>
            ))}
            <button
              type="button"
              disabled={disabled}
              onClick={() => uploadInputRef.current?.click()}
              aria-label="Add more media"
              className="grid aspect-square place-items-center rounded-md border border-dashed text-muted-foreground transition-colors hover:border-primary hover:text-primary"
            >
              <ImagePlus className="size-5" />
            </button>
          </Sortable>
          <p className="text-xs text-muted-foreground">
            {items.length} file{items.length === 1 ? "" : "s"} — drag tiles to reorder, first image is the cover.
          </p>
        </>
      )}

      {errors.length > 0 ? (
        <div className="space-y-1 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {errors.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
