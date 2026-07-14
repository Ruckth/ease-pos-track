import type { Doc } from "./_generated/dataModel";

export type AnnotationRecord = NonNullable<Doc<"feedback">["annotations"]>[number];

export type AnnotationUpdate = {
  text?: string;
  x?: number;
  y?: number;
  time?: number;
};

export type AnnotationCreateInput = {
  mediaIndex: number;
  kind: "point" | "time";
  x?: number;
  y?: number;
  time?: number;
  text: string;
};

type AnnotationMedia = {
  type: string;
};

const MAX_ANNOTATION_LENGTH = 2_000;

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

export function createAnnotationRecord(
  media: AnnotationMedia[],
  input: AnnotationCreateInput,
  label: number,
  id: string,
  now: number,
): AnnotationRecord {
  const text = input.text.trim();
  if (!text) throw new Error("Comment text is required.");
  if (text.length > MAX_ANNOTATION_LENGTH) {
    throw new Error(`Comments must be ${MAX_ANNOTATION_LENGTH.toLocaleString()} characters or fewer.`);
  }
  if (!Number.isInteger(input.mediaIndex) || input.mediaIndex < 0 || input.mediaIndex >= media.length) {
    throw new Error("Invalid media index.");
  }

  const target = media[input.mediaIndex];
  const isVideo = target.type.startsWith("video/");
  if (input.kind === "point" && isVideo) throw new Error("Use a time mark for videos.");
  if (input.kind === "time" && !isVideo) throw new Error("Time marks are only valid on videos.");
  if (input.x === undefined || input.y === undefined || !Number.isFinite(input.x) || !Number.isFinite(input.y)) {
    throw new Error("Comments require a valid media position.");
  }
  if (input.kind === "time" && (input.time === undefined || !Number.isFinite(input.time))) {
    throw new Error("Time annotations require a valid timestamp.");
  }
  if (!Number.isInteger(label) || label < 1) throw new Error("Invalid comment label.");

  return {
    id,
    label,
    mediaIndex: input.mediaIndex,
    kind: input.kind,
    x: clamp01(input.x),
    y: clamp01(input.y),
    ...(input.kind === "time" ? { time: Math.max(0, input.time ?? 0) } : {}),
    text,
    createdAt: now,
  };
}

export function activeAnnotations(annotations: AnnotationRecord[]) {
  return annotations.filter((annotation) => annotation.deletedAt === undefined);
}

export function deletedAnnotations(annotations: AnnotationRecord[]) {
  return annotations.filter((annotation) => annotation.deletedAt !== undefined);
}

export function updateAnnotationRecord(
  annotation: AnnotationRecord,
  update: AnnotationUpdate,
  now: number,
): AnnotationRecord {
  if (annotation.deletedAt !== undefined) {
    throw new Error("Deleted comments must be restored before editing.");
  }

  if (update.text === undefined && update.x === undefined && update.y === undefined && update.time === undefined) {
    throw new Error("No comment changes were provided.");
  }

  const text = update.text === undefined ? annotation.text : update.text.trim();
  if (!text) throw new Error("Comment text is required.");
  if (text.length > MAX_ANNOTATION_LENGTH) {
    throw new Error(`Comments must be ${MAX_ANNOTATION_LENGTH.toLocaleString()} characters or fewer.`);
  }

  const x = update.x === undefined ? annotation.x : clamp01(update.x);
  const y = update.y === undefined ? annotation.y : clamp01(update.y);
  if (x === undefined || y === undefined) {
    throw new Error("Comments require an image position.");
  }

  if ((annotation.kind === "pin" || annotation.kind === "point") && update.time !== undefined) {
    throw new Error("Image comments cannot have a video timestamp.");
  }

  const time = annotation.kind === "time"
    ? Math.max(0, update.time === undefined ? annotation.time ?? 0 : update.time)
    : undefined;

  return {
    ...annotation,
    text,
    x,
    y,
    ...(time === undefined ? {} : { time }),
    updatedAt: now,
  };
}

export function softDeleteAnnotationRecord(annotation: AnnotationRecord, now: number): AnnotationRecord {
  if (annotation.deletedAt !== undefined) throw new Error("Comment is already deleted.");
  return { ...annotation, deletedAt: now, updatedAt: now };
}

export function restoreAnnotationRecord(annotation: AnnotationRecord, now: number): AnnotationRecord {
  if (annotation.deletedAt === undefined) throw new Error("Comment is not deleted.");
  const { deletedAt: _deletedAt, ...active } = annotation;
  return { ...active, updatedAt: now };
}
