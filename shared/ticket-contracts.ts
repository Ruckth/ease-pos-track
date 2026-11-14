import type { FunctionArgs, FunctionReturnType } from "convex/server";
import type { api } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";

// Generated handler results are the transport contract.
export type TicketSummary = FunctionReturnType<typeof api.tickets.pageTickets>["page"][number];
export type TicketDetail = NonNullable<FunctionReturnType<typeof api.tickets.getTicket>>;

/** Convex text search accepts at most sixteen tokens per query. */
export function isTicketSearchWithinLimits(search: string) {
  return search.length <= 200 && (search.match(new RegExp("[\\p{L}\\p{M}\\p{N}]+", "gu"))?.length ?? 0) <= 16;
}

/** Per reserved provider key; absent is success only after provider verification. */
export type StorageDeletionOutcome =
  | { outcome: "deleted" }
  | { outcome: "absent_verified" }
  | { outcome: "failed_retryable" }
  | { outcome: "failed_permanent" }
  | { outcome: "unknown" };

// Shared metadata limits: shared/media-policy.ts and convex/annotation_state.ts.
// Positive file sizes, nonblank names and image/ or video/ MIME prefixes remain
// validator rules outside this upper-bound policy. Node tests detect limit drift.
export const MEDIA_POLICY = {
  image: { maxCount: 10, maxBytes: 8 * 1024 * 1024 },
  video: { maxCount: 3, maxBytes: 64 * 1024 * 1024 },
  maxFileNameLength: 255,
  maxMimeTypeLength: 100,
  maxAnnotationTextLength: 2_000,
  maxAnnotationCount: 100,
  maxAnnotationTotalTextLength: 50_000,
} as const;

type CreateArgs = FunctionArgs<typeof api.tickets.createTicket>;
export type TicketRequestInput = Pick<CreateArgs, "title" | "description" | "annotations" | "projectId"> & {
  actor: { role: "staff" } | { role: "customer"; customerId: Id<"customers"> };
  // Trusted immutable key references, in display order (annotations use indexes).
  mediaKeys?: readonly string[];
};

function normalizeTicketActor(actor: TicketRequestInput["actor"]) {
  return actor.role === "staff"
    ? { role: "staff" as const }
    : { role: "customer" as const, customerId: actor.customerId };
}

/** Pure canonicalization of validated create input. Never include a session or secret.
 * Coordinates are preserved, not clamped; callers must supply already-validated input.
 * Bump hashTicketRequest's digest version when this encoding changes. Order is significant.
 */
export function normalizeTicketRequest(input: TicketRequestInput) {
  return {
    operation: "ticket.create" as const,
    actor: normalizeTicketActor(input.actor),
    projectId: input.projectId,
    title: input.title.trim(),
    description: input.description.trim(),
    mediaKeys: [...(input.mediaKeys ?? [])],
    annotations: (input.annotations ?? []).map((annotation) => ({
      mediaIndex: annotation.mediaIndex,
      kind: annotation.kind,
      x: annotation.x,
      y: annotation.y,
      time: annotation.kind === "time" ? annotation.time : undefined,
      text: annotation.text.trim(),
    })),
  };
}

/** Canonical digest input, NOT a hash. Hash at the runtime boundary and store
 * the version + digest with the immutable receipt, never mutable Ticket content.
 * (operation, requestId) is the duplicate key; actor/Project stay in this input.
 */
export function ticketRequestFingerprintInput(input: TicketRequestInput): string {
  return JSON.stringify(normalizeTicketRequest(input));
}

export function ticketMediaRequestFingerprintInput(input: {
  actor: TicketRequestInput["actor"];
  projectId: Id<"projects">;
  ticketId: Id<"tickets">;
  mediaKeys: readonly string[];
}) {
  return JSON.stringify({ operation: "ticket.attach_media", actor: normalizeTicketActor(input.actor),
    projectId: input.projectId, ticketId: input.ticketId, mediaKeys: [...input.mediaKeys] });
}

export type JobFence = { attempt: number; leaseId: string };
