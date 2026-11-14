import type { FunctionArgs, FunctionReturnType } from "convex/server";
import type { ConvexError } from "convex/values";
import type { api } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";

/** Safe public codes only. Unavailable includes missing and unauthorized Tickets. */
export type TicketErrorCode =
  | "SESSION_EXPIRED" | "STAFF_ONLY" | "PROJECT_NOT_FOUND" | "PROJECT_REQUIRED"
  | "TICKET_UNAVAILABLE" | "VERSION_CONFLICT" | "REQUEST_ID_CONFLICT"
  | "INVALID_INPUT" | "MEDIA_LIMIT_EXCEEDED" | "ANNOTATION_LIMIT_EXCEEDED" | "UPLOAD_INTENT_INVALID"
  | "MEDIA_OWNERSHIP_CONFLICT" | "TICKET_PURGING" | "STORAGE_NOT_CONFIGURED"
  | "UPLOAD_CALLBACK_NOT_CONFIGURED" | "TRUSTED_CALLBACK_REQUIRED" | "MEDIA_NOT_ATTACHABLE"
  | "UPLOAD_VERIFICATION_FAILED" | "UPLOAD_INTENT_NOT_FOUND" | "UPLOAD_INCOMPLETE" | "UPLOAD_REQUEST_CONFLICT";

/** ConvexError.data: no raw messages, provider responses, credentials or content. */
export type TicketErrorData = { code: TicketErrorCode };
export type TicketDomainError = ConvexError<TicketErrorData>;

// Project existing generated results explicitly; never expose owner/session fields.
// These are contract projections for future handlers, not replacements for generated callers.
type TicketRead = NonNullable<FunctionReturnType<typeof api.tickets.getTicket>>;
export type TicketSummary = Pick<TicketRead,
  "_id" | "title" | "status" | "urgencyScore" | "createdAt" | "updatedAt"
> & Required<Pick<TicketRead, "projectId" | "projectKey" | "ticketNumber" | "version">> & {
  lifecycle: "active" | "archived";
  mediaCount: number;
};
export type TicketDetail = TicketSummary & Pick<TicketRead, "description" | "media"> & {
  annotations: NonNullable<TicketRead["annotations"]>;
  archivedAt?: number;
};

export type TicketCommandResult<Result, Progress = string> =
  | { state: "committed"; result: Result }
  | { state: "queued"; progress: Progress }
  | { state: "completed"; result: Result };

/** Only the client can classify response loss; unknown never permits cleanup. */
export type TicketCommandOutcome<Result, Progress = string> =
  | { outcome: "acknowledged"; acknowledgement: TicketCommandResult<Result, Progress> }
  | { outcome: "rejected"; error: TicketErrorData }
  | { outcome: "unknown"; requestId: string };

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
// Set maxAttempts to a positive integer at creation; transitions preserve it.
export type TicketJob = { maxAttempts: number } & (
  | { state: "pending"; attempt: number; availableAt: number }
  | ({ state: "leased"; leaseExpiresAt: number } & JobFence)
  | { state: "succeeded" | "failed" | "exhausted" | "cancelled"; attempt: number });
export type JobTransition =
  | { kind: "claim"; now: number; leaseId: string; leaseExpiresAt: number }
  | { kind: "settle"; now: number; fence: JobFence; outcome: "succeeded" | "failed" }
  | { kind: "retry"; now: number; fence: JobFence; availableAt: number }
  | { kind: "cancel"; now: number };
export type JobTransitionResult =
  | { accepted: true; job: TicketJob }
  | { accepted: false; reason: "terminal" | "not_ready" | "invalid_event" | "invalid_job" | "stale_lease" | "leased" };

/** Database rules only: callers persist/schedule atomically. Fences cannot stop
 * old provider I/O; reservations must survive retry, unknown and terminal failure.
 * An accepted claim may produce exhausted; callers must check the resulting state.
 */
export function transitionTicketJob(job: TicketJob, event: JobTransition): JobTransitionResult {
  if (!Number.isInteger(job.maxAttempts) || job.maxAttempts < 1) {
    return { accepted: false, reason: "invalid_job" };
  }
  if (job.state !== "pending" && job.state !== "leased") {
    return { accepted: false, reason: "terminal" };
  }
  if (event.kind === "cancel") {
    if (!Number.isFinite(event.now)) return { accepted: false, reason: "invalid_event" };
    return job.state === "pending" || job.leaseExpiresAt <= event.now
      ? { accepted: true, job: { state: "cancelled", attempt: job.attempt, maxAttempts: job.maxAttempts } }
      : { accepted: false, reason: "leased" };
  }
  if (event.kind === "claim") {
    if (!event.leaseId || !Number.isFinite(event.now) || !Number.isFinite(event.leaseExpiresAt)
      || event.leaseExpiresAt <= event.now) {
      return { accepted: false, reason: "invalid_event" };
    }
    if ((job.state === "pending" && job.availableAt > event.now)
      || (job.state === "leased" && job.leaseExpiresAt > event.now)) {
      return { accepted: false, reason: "not_ready" };
    }
    return { accepted: true, job: job.attempt >= job.maxAttempts
      ? { state: "exhausted", attempt: job.attempt, maxAttempts: job.maxAttempts }
      : { state: "leased", attempt: job.attempt + 1, leaseId: event.leaseId, leaseExpiresAt: event.leaseExpiresAt, maxAttempts: job.maxAttempts } };
  }
  if (job.state !== "leased" || job.attempt !== event.fence.attempt
    || job.leaseId !== event.fence.leaseId || !Number.isFinite(event.now) || job.leaseExpiresAt <= event.now) {
    return { accepted: false, reason: "stale_lease" };
  }
  if (event.kind === "settle") {
    return { accepted: true, job: { state: event.outcome, attempt: job.attempt, maxAttempts: job.maxAttempts } };
  }
  if (!Number.isFinite(event.availableAt) || event.availableAt < event.now) {
    return { accepted: false, reason: "invalid_event" };
  }
  return { accepted: true, job: job.attempt >= job.maxAttempts
    ? { state: "exhausted", attempt: job.attempt, maxAttempts: job.maxAttempts }
    : { state: "pending", attempt: job.attempt, availableAt: event.availableAt, maxAttempts: job.maxAttempts } };
}
