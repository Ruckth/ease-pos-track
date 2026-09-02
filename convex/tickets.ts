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
    action: "created" | "edited" | "edit_undone" | "status_changed" | "status_undone" | "archived" | "restored";
    before?: ReturnType<typeof feedbackState>;
    after?: ReturnType<typeof feedbackState>;
    sourceEventId?: Id<"feedbackEvents">;
    createdAt: number;
  } & TicketAuthor,
) {
  return await ctx.db.insert("feedbackEvents", input);
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
