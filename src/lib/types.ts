import type { Doc } from "@convex/_generated/dataModel";

export type Feedback = Doc<"feedback">;
export type FeedbackStatus = Feedback["status"];
export type MediaItem = Feedback["media"][number];
export type Annotation = NonNullable<Feedback["annotations"]>[number];
export type AnnotationEvent = Doc<"annotationEvents">;
export type FeedbackEvent = Doc<"feedbackEvents">;

export function isActiveAnnotation(annotation: Annotation) {
  return annotation.deletedAt === undefined;
}

export function isVideoMedia(item: MediaItem) {
  return item.type.startsWith("video/");
}

export function formatClock(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}
