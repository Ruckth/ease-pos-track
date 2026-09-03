/**
 * The one place a ticket is created and the one place its audit trail is written.
 *
 * Both entry points go through `createTicketRecord`: the browser UI's
 * `feedback.createFeedback` (after it has verified uploads) and
 * `feedback.createTextFeedback` (authenticated, text only). They therefore
 * share ticket-number allocation, ownership stamping and audit events, and can
 * only drift on purpose.
 */

import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { newFeedbackOwnership } from "./authz";
import type { AnnotationRecord } from "./annotation_state";
import { requireCurrentVersion } from "./feedback_state";
import { planTicketNumberBackfill } from "./ticket_numbers";

const FEEDBACK_COUNTER_NAME = "feedback";

export type MediaItem = Doc<"feedback">["media"][number];

export async function ensureTicketNumbersInDb(ctx: MutationCtx) {
  const [rows, counter] = await Promise.all([
    ctx.db.query("feedback").withIndex("by_created_at").order("asc").collect(),
    ctx.db
      .query("ticketCounters")
      .withIndex("by_name", (q) => q.eq("name", FEEDBACK_COUNTER_NAME))
      .unique(),
  ]);
  const plan = planTicketNumberBackfill(
    rows.map((row) => ({ id: row._id, createdAt: row.createdAt, ticketNumber: row.ticketNumber })),
    counter?.nextNumber,
  );
  const now = Date.now();

  for (const assignment of plan.assignments) {
    await ctx.db.patch(assignment.id as Id<"feedback">, { ticketNumber: assignment.ticketNumber });
  }

  const counterId = counter
    ? counter._id
    : await ctx.db.insert("ticketCounters", {
      name: FEEDBACK_COUNTER_NAME,
      nextNumber: plan.nextNumber,
      updatedAt: now,
    });
  if (counter && counter.nextNumber !== plan.nextNumber) {
    await ctx.db.patch(counter._id, { nextNumber: plan.nextNumber, updatedAt: now });
  }

  return { counterId, assignments: plan.assignments.length, nextNumber: plan.nextNumber };
}

async function allocateTicketNumber(ctx: MutationCtx) {
  const state = await ensureTicketNumbersInDb(ctx);
  await ctx.db.patch(state.counterId, { nextNumber: state.nextNumber + 1, updatedAt: Date.now() });
  return state.nextNumber;
}

export function feedbackState(doc: Doc<"feedback">) {
  return {
    title: doc.title,
    description: doc.description,
    status: doc.status,
    version: doc.version ?? 0,
    mediaCount: doc.media.length,
    ...(doc.deletedAt === undefined ? {} : { deletedAt: doc.deletedAt }),
  };
}

/**
 * Who made a change, for the audit trail. Every path, including the Ticket CLI,
 * uses a real app session; `createdVia` records the integration boundary without
 * weakening attribution.
 */
export type TicketAuthor = {
  sessionId: Id<"sessions">;
  actorRole?: "staff" | "customer";
  actorCustomerId?: Id<"customers">;
  createdVia?: "codex";
};

/**
 * Annotations only ever arrive from the browser UI, so an annotation event always
 * has a session. This keeps `annotationEvents` unchanged and fails loudly rather
 * than recording an unattributable annotation.
 */
function requireSessionAuthor(author: TicketAuthor) {
  return {
    sessionId: author.sessionId,
    ...(author.actorRole === undefined ? {} : { actorRole: author.actorRole }),
    ...(author.actorCustomerId === undefined ? {} : { actorCustomerId: author.actorCustomerId }),
  };
}

export async function recordFeedbackEvent(
  ctx: MutationCtx,
  input: {
    feedbackId: Id<"feedback">;
    action: "created" | "media_attached" | "edited" | "edit_undone" | "status_changed" | "status_undone" | "archived" | "restored";
    before?: ReturnType<typeof feedbackState>;
    after?: ReturnType<typeof feedbackState>;
    sourceEventId?: Id<"feedbackEvents">;
    createdAt: number;
  } & TicketAuthor,
) {
  return await ctx.db.insert("feedbackEvents", input);
}

/** The audit-trail snapshot of a Ticket. */
export type TicketState = ReturnType<typeof feedbackState>;

/** Ticket fields that versioned state mutations may change. */
export type TicketChanges = Partial<
  Pick<Doc<"feedback">, "title" | "description" | "status" | "media" | "deletedAt">
>;

type TicketChangeAction =
  | "media_attached"
  | "edited"
  | "edit_undone"
  | "status_changed"
  | "status_undone"
  | "archived";

export type TicketChangePlan<Changes extends TicketChanges> = {
  version: number;
  updatedAt: number;
  patch: Changes & { version: number; updatedAt: number };
  before: TicketState;
  after: TicketState;
};

/**
 * Plans a versioned Ticket change without writing to the database. The row patch
 * and audit snapshot are derived from the same changes so they cannot drift.
 */
export function planTicketChange<Changes extends TicketChanges>(input: {
  doc: Doc<"feedback">;
  expectedVersion: number;
  changes: Changes;
  now: number;
}): TicketChangePlan<Changes> {
  const version = requireCurrentVersion(input.doc, input.expectedVersion) + 1;
  return {
    version,
    updatedAt: input.now,
    patch: { ...input.changes, version, updatedAt: input.now },
    before: feedbackState(input.doc),
    after: feedbackState({ ...input.doc, ...input.changes, version, updatedAt: input.now }),
  };
}

/** Applies one versioned Ticket patch and records its matching audit event. */
export async function applyTicketChange(
  ctx: MutationCtx,
  input: {
    doc: Doc<"feedback">;
    expectedVersion: number;
    changes: TicketChanges;
    action: TicketChangeAction;
    author: TicketAuthor;
    sourceEventId?: Id<"feedbackEvents">;
    now: number;
  },
) {
  const plan = planTicketChange(input);
  await ctx.db.patch(input.doc._id, plan.patch);
  const eventId = await recordFeedbackEvent(ctx, {
    feedbackId: input.doc._id,
    action: input.action,
    before: plan.before,
    after: plan.after,
    ...input.author,
    ...(input.sourceEventId === undefined ? {} : { sourceEventId: input.sourceEventId }),
    createdAt: plan.updatedAt,
  });
  return { eventId, version: plan.version };
}

export async function recordAnnotationEvent(
  ctx: MutationCtx,
  input: {
    feedbackId: Id<"feedback">;
    annotationId: string;
    action: "created" | "updated" | "deleted" | "restored" | "update_undone";
    before?: AnnotationRecord;
    after?: AnnotationRecord;
    sessionId: Id<"sessions">;
    actorRole?: "staff" | "customer";
    actorCustomerId?: Id<"customers">;
    createdAt: number;
  },
) {
  return await ctx.db.insert("annotationEvents", input);
}

export type NewTicket = {
  title: string;
  description: string;
  media: MediaItem[];
  annotations?: AnnotationRecord[];
  /** Derived from the actor by `newFeedbackOwnership`; never taken from a client. */
  ownership: ReturnType<typeof newFeedbackOwnership<Id<"customers">>>;
  author: TicketAuthor;
  externalRequestId?: string;
  now: number;
};

/**
 * Inserts a ticket in status `new` with its ticket number, then writes the
 * `created` audit events for the ticket and any annotations it starts with.
 * Callers own their own validation and any upload bookkeeping.
 */
export async function createTicketRecord(ctx: MutationCtx, input: NewTicket) {
  const annotations = input.annotations ?? [];
  const ticketNumber = await allocateTicketNumber(ctx);
  const feedbackId = await ctx.db.insert("feedback", {
    title: input.title,
    description: input.description,
    status: "new",
    ticketNumber,
    media: input.media,
    ...(annotations.length === 0 ? {} : { annotations }),
    version: 0,
    ...input.ownership,
    ...(input.author.createdVia === undefined ? {} : { createdVia: input.author.createdVia }),
    ...(input.externalRequestId === undefined ? {} : { externalRequestId: input.externalRequestId }),
    createdAt: input.now,
    updatedAt: input.now,
  });
  const created = await ctx.db.get(feedbackId);
  if (!created) throw new Error("CREATE_FEEDBACK_FAILED");

  await recordFeedbackEvent(ctx, {
    feedbackId,
    action: "created",
    after: feedbackState(created),
    ...input.author,
    createdAt: input.now,
  });
  for (const annotation of annotations) {
    await recordAnnotationEvent(ctx, {
      feedbackId,
      annotationId: annotation.id,
      action: "created",
      after: annotation,
      ...requireSessionAuthor(input.author),
      createdAt: input.now,
    });
  }

  return created;
}
