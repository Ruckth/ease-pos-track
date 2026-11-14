/** Ticket planning, writes, numbering and audit. */

import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { newTicketOwnership } from "../authz";
import { validateAnnotationBudget, type AnnotationRecord } from "../annotation_state";
import { requireCurrentVersion } from "../ticket_state";

export type MediaItem = Doc<"tickets">["media"][number];

/** Each Project numbers its Tickets independently, from 1. */
export function projectCounterName(projectId: Id<"projects">) {
  return `project:${projectId}`;
}

async function allocateTicketNumber(ctx: MutationCtx, projectId: Id<"projects">) {
  const name = projectCounterName(projectId);
  const counter = await ctx.db
    .query("ticketCounters")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique();
  const now = Date.now();
  if (!counter) {
    await ctx.db.insert("ticketCounters", { name, nextNumber: 2, updatedAt: now });
    return 1;
  }
  await ctx.db.patch(counter._id, { nextNumber: counter.nextNumber + 1, updatedAt: now });
  return counter.nextNumber;
}

export function ticketState(doc: Doc<"tickets">) {
  return {
    title: doc.title,
    description: doc.description,
    status: doc.status,
    ...(doc.urgencyScore === undefined ? {} : { urgencyScore: doc.urgencyScore }),
    version: doc.version,
    lifecycle: doc.lifecycle,
    mediaCount: doc.media.length,
    annotationCount: doc.annotations.length,
    ...(doc.archivedAt === undefined ? {} : { archivedAt: doc.archivedAt }),
  };
}

/**
 * Who made a change, for the audit trail. Every path, including the Ticket CLI,
 * uses a real app session; `createdVia` records the integration boundary without
 * weakening attribution.
 */
export type TicketAuthor = {
  sessionId: Id<"sessions">;
  actorRole: "staff" | "customer";
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
    actorRole: author.actorRole,
    ...(author.actorCustomerId === undefined ? {} : { actorCustomerId: author.actorCustomerId }),
  };
}

export async function recordTicketEvent(
  ctx: MutationCtx,
  input: {
    ticketId: Id<"tickets">;
    action: "created" | TicketChangeAction;
    before?: ReturnType<typeof ticketState>;
    after?: ReturnType<typeof ticketState>;
    sourceEventId?: Id<"ticketEvents">;
    createdAt: number;
  } & TicketAuthor,
) {
  return await ctx.db.insert("ticketEvents", input);
}

/** The audit-trail snapshot of a Ticket. */
export type TicketState = ReturnType<typeof ticketState>;

/** Ticket fields that versioned state mutations may change. */
export type TicketChanges = Partial<
  Pick<Doc<"tickets">, "title" | "description" | "status" | "urgencyScore" | "media" | "annotations" | "archivedAt" | "lifecycle">
>;

type TicketChangeAction =
  | "media_attached"
  | "edited"
  | "edit_undone"
  | "urgency_changed"
  | "urgency_undone"
  | "status_changed"
  | "status_undone"
  | "archived"
  | "restored"
  | "annotation_changed"
  | "purge_claimed";

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
  doc: Doc<"tickets">;
  expectedVersion: number;
  changes: Changes;
  now: number;
}): TicketChangePlan<Changes> {
  const version = requireCurrentVersion(input.doc, input.expectedVersion) + 1;
  return {
    version,
    updatedAt: input.now,
    patch: { ...input.changes, version, updatedAt: input.now },
    before: ticketState(input.doc),
    after: ticketState({ ...input.doc, ...input.changes, version, updatedAt: input.now }),
  };
}

async function changeTotal(ctx: MutationCtx, projectId: Id<"projects">, status: Doc<"tickets">["status"], delta: number) {
  const total = await ctx.db.query("ticketTotals")
    .withIndex("by_project_status", q => q.eq("projectId", projectId).eq("status", status)).unique();
  if (total) await ctx.db.patch(total._id, { count: total.count + delta });
  else await ctx.db.insert("ticketTotals", { projectId, status, count: delta });
}

/** Applies one versioned Ticket patch and records its matching audit event. */
export async function applyTicketChange(
  ctx: MutationCtx,
  input: {
    doc: Doc<"tickets">;
    expectedVersion: number;
    changes: TicketChanges;
    action: TicketChangeAction;
    author: TicketAuthor;
    sourceEventId?: Id<"ticketEvents">;
    now: number;
  },
) {
  if (input.changes.annotations) validateAnnotationBudget(input.changes.annotations);
  const plan = planTicketChange(input);
  if (input.changes.title !== undefined || input.changes.description !== undefined) {
    Object.assign(plan.patch, { searchText: `${plan.after.title} ${plan.after.description}` });
  }
  await ctx.db.patch(input.doc._id, plan.patch);
  if (plan.before.status !== plan.after.status || plan.before.lifecycle !== plan.after.lifecycle) {
    if (plan.before.lifecycle === "active") await changeTotal(ctx, input.doc.projectId, plan.before.status, -1);
    if (plan.after.lifecycle === "active") await changeTotal(ctx, input.doc.projectId, plan.after.status, 1);
  }
  const eventId = await recordTicketEvent(ctx, {
    ticketId: input.doc._id,
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
    ticketId: Id<"tickets">;
    annotationId: string;
    action: "created" | "updated" | "deleted" | "restored" | "update_undone";
    before?: AnnotationRecord;
    after?: AnnotationRecord;
    sessionId: Id<"sessions">;
    actorRole: "staff" | "customer";
    actorCustomerId?: Id<"customers">;
    createdAt: number;
  },
) {
  return await ctx.db.insert("annotationEvents", input);
}

export type NewTicket = {
  /** Checked by the caller with `canUseProject`. */
  project: Pick<Doc<"projects">, "_id" | "key">;
  title: string;
  description: string;
  media: MediaItem[];
  annotations?: AnnotationRecord[];
  /** Derived from the actor by `newTicketOwnership`; never taken from a client. */
  ownership: ReturnType<typeof newTicketOwnership<Id<"customers">>>;
  author: TicketAuthor;
  now: number;
};

/**
 * Inserts a ticket in status `new` with its ticket number, then writes the
 * `created` audit events for the ticket and any annotations it starts with.
 * Callers own their own validation and any upload bookkeeping.
 */
export async function createTicketRecord(ctx: MutationCtx, input: NewTicket) {
  const annotations = input.annotations ?? [];
  validateAnnotationBudget(annotations);
  const ticketNumber = await allocateTicketNumber(ctx, input.project._id);
  const ticketId = await ctx.db.insert("tickets", {
    projectId: input.project._id,
    projectKey: input.project.key,
    title: input.title,
    searchText: `${input.title} ${input.description}`,
    lifecycle: "active",
    description: input.description,
    status: "new",
    ticketNumber,
    media: input.media,
    annotations,
    version: 0,
    ...input.ownership,
    ...(input.author.createdVia === undefined ? {} : { createdVia: input.author.createdVia }),
    createdAt: input.now,
    updatedAt: input.now,
  });
  await changeTotal(ctx, input.project._id, "new", 1);
  const created = await ctx.db.get(ticketId);
  if (!created) throw new Error("CREATE_TICKET_FAILED");

  await recordTicketEvent(ctx, {
    ticketId,
    action: "created",
    after: ticketState(created),
    ...input.author,
    createdAt: input.now,
  });
  for (const annotation of annotations) {
    await recordAnnotationEvent(ctx, {
      ticketId,
      annotationId: annotation.id,
      action: "created",
      after: annotation,
      ...requireSessionAuthor(input.author),
      createdAt: input.now,
    });
  }

  return created;
}
