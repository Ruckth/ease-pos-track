import type { Annotation, MediaItem } from "@/lib/types";

export type PendingAnnotation = {
  id: string;
  mediaId: string;
  kind: "point" | "time";
  x?: number;
  y?: number;
  time?: number;
  text: string;
  createdAt: number;
};

export type PendingMediaRef = {
  id: string;
};

export type CreateAnnotationInput = {
  mediaIndex: number;
  kind: "point" | "time";
  x?: number;
  y?: number;
  time?: number;
  text: string;
};

export function pendingAnnotationsForViewer(
  media: PendingMediaRef[],
  annotations: PendingAnnotation[],
): Annotation[] {
  return annotations.flatMap((annotation, annotationIndex) => {
    const mediaIndex = media.findIndex((item) => item.id === annotation.mediaId);
    if (mediaIndex < 0) return [];
    return [{
      id: annotation.id,
      label: annotationIndex + 1,
      mediaIndex,
      kind: annotation.kind,
      x: annotation.x,
      y: annotation.y,
      time: annotation.time,
      text: annotation.text,
      createdAt: annotation.createdAt,
    } satisfies Annotation];
  });
}

export function pendingAnnotationsForCreate(
  media: PendingMediaRef[],
  annotations: PendingAnnotation[],
): CreateAnnotationInput[] {
  return pendingAnnotationsForViewer(media, annotations).map((annotation) => ({
    mediaIndex: annotation.mediaIndex,
    kind: annotation.kind === "time" ? "time" : "point",
    x: annotation.x,
    y: annotation.y,
    time: annotation.time,
    text: annotation.text,
  }));
}

export function pendingMediaForViewer(
  media: Array<PendingMediaRef & { file: File; previewUrl: string }>,
): MediaItem[] {
  return media.map((item) => ({
    key: item.id,
    name: item.file.name,
    size: item.file.size,
    type: item.file.type,
    url: item.previewUrl,
  }));
}

export function withoutPendingAnnotationsForMedia(
  annotations: PendingAnnotation[],
  mediaId: string,
) {
  return annotations.filter((annotation) => annotation.mediaId !== mediaId);
}
