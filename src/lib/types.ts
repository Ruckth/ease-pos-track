import type { Doc, Id } from "@convex/_generated/dataModel";
import type { TicketDetail } from "../../shared/ticket-contracts";

export type Ticket = TicketDetail;
export type TicketStatus = Ticket["status"];
export type MediaItem = Ticket["media"][number];
export type Annotation = NonNullable<Ticket["annotations"]>[number];
export type AnnotationEvent = Omit<Doc<"annotationEvents">, "sessionId" | "actorRole" | "actorCustomerId">;
export type TicketEvent = Omit<Doc<"ticketEvents">, "sessionId" | "actorRole" | "actorCustomerId">;

export type ProjectSummary = { _id: Id<"projects">; name: string; key: string };
export type PendingMedia = { id: string; file: File; previewUrl: string; isVideo: boolean };
export type AnnotationDraftInput = {
  mediaIndex: number;
  kind: "point" | "time";
  x?: number;
  y?: number;
  time?: number;
  text: string;
};
export type AnnotationUpdateInput = {
  annotationId: string;
  text?: string;
  x?: number;
  y?: number;
  time?: number;
};

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
