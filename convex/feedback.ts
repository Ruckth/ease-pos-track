import { v } from "convex/values";
import { annotationCreateInputValidator, feedbackStatus, mediaItemValidator } from "./schema";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  actorFields,
  actorFromSession,
  assertCanWriteFeedback,
  assertCustomerActor,
  assertStaffActor,
  canReadFeedback,
  newFeedbackOwnership,
  type Actor,
} from "./authz";
import {
  createAnnotationRecord,
  restoreAnnotationRecord,
  softDeleteAnnotationRecord,
  updateAnnotationRecord,
  type AnnotationRecord,
} from "./annotation_state";
import { requireCurrentVersion, validateFeedbackText } from "./feedback_state";
import { assertSameTicketRequest, normalizeRequestId } from "./ticket_requests";
import { validateMediaItems } from "./uploads";
import {
  applyTicketChange,
  createTicketRecord,
  ensureTicketNumbersInDb,
  feedbackState,
  recordAnnotationEvent,
  recordFeedbackEvent,
} from "./tickets";

async function requireSession(ctx: QueryCtx | MutationCtx, token: string) {
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();

  if (!session || session.expiresAt <= Date.now()) {
    throw new Error("SESSION_EXPIRED");
  }

  return session;
}

/**
 * Resolves the session and the actor behind it. Sessions without a role predate
 * the customer portal and resolve to staff.
 */
async function requireActor(ctx: QueryCtx | MutationCtx, token: string) {
  const session = await requireSession(ctx, token);
  return { session, actor: actorFromSession(session) };
}

/**
 * Loads a ticket the actor may read, or null. Denied and non-existent tickets are
 * indistinguishable, so the portal cannot be used to probe for ticket ids.
 */
async function readableFeedback(
  ctx: QueryCtx | MutationCtx,
  actor: Actor<Id<"customers">>,
  id: Id<"feedback">,
) {
  const doc = await ctx.db.get(id);
  if (!doc || !canReadFeedback(actor, doc)) return null;
  return doc;
}

function publicAnnotationEvent(event: Doc<"annotationEvents">) {
  return {
    _id: event._id,
    _creationTime: event._creationTime,
    feedbackId: event.feedbackId,
    annotationId: event.annotationId,
    action: event.action,
    before: event.before,
    after: event.after,
    createdAt: event.createdAt,
  };
}

function publicFeedbackEvent(event: Doc<"feedbackEvents">) {
  return {
    _id: event._id,
    _creationTime: event._creationTime,
    feedbackId: event.feedbackId,
    action: event.action,
    before: event.before,
    after: event.after,
    sourceEventId: event.sourceEventId,
    createdAt: event.createdAt,
  };
}

/** Loads an active ticket the actor is allowed to change. */
async function requireWritableFeedback(
  ctx: MutationCtx,
  actor: Actor<Id<"customers">>,
  id: Id<"feedback">,
) {
  const doc = await ctx.db.get(id);
  if (!doc || doc.deletedAt !== undefined) throw new Error("FEEDBACK_NOT_FOUND");
  assertCanWriteFeedback(actor, doc);
  return doc;
}

function requireOwnedUploadIntent(
  intent: Doc<"uploadIntents"> | null,
  session: Doc<"sessions">,
  actor: Actor<Id<"customers">>,
  secret: string,
) {
  if (
    !intent
    || intent.sessionId !== session._id
    || intent.secret !== secret
    || (intent.actorRole !== undefined && intent.actorRole !== actor.role)
    || (intent.actorCustomerId !== undefined && intent.actorCustomerId !== actor.customerId)
  ) {
    throw new Error("UPLOAD_INTENT_NOT_FOUND");
  }
  return intent;
}

function verifyPendingUploadIntent(
  intent: Doc<"uploadIntents">,
  media: Doc<"feedback">["media"],
) {
  if (intent.status !== "pending" || intent.expiresAt <= Date.now()) {
    throw new Error("UPLOAD_INTENT_INVALID");
  }
  validateMediaItems(media);
  if (intent.uploadedFiles.length !== media.length) throw new Error("UPLOAD_INCOMPLETE");
  const uploadedByKey = new Map(intent.uploadedFiles.map((item) => [item.key, item]));
  const verified = media.every((item) => {
    const uploaded = uploadedByKey.get(item.key);
    return uploaded
      && uploaded.url === item.url
      && uploaded.name === item.name
      && uploaded.size === item.size
      && uploaded.type === item.type;
  });
  if (!verified || new Set(media.map((item) => item.key)).size !== media.length) {
    throw new Error("UPLOAD_VERIFICATION_FAILED");
  }
}

export const listFeedback = query({
  args: {
    token: v.string(),
    includeDeleted: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { actor } = await requireActor(ctx, args.token);
    // Customers never see the whole board; they use listMyFeedback instead.
    assertStaffActor(actor);

    const rows = await ctx.db.query("feedback").withIndex("by_created_at").order("desc").collect();
    return args.includeDeleted ? rows : rows.filter((item) => item.deletedAt === undefined);
  },
});

/** Tickets owned by the signed-in customer, newest first. */
export const listMyFeedback = query({
  args: {
    token: v.string(),
    includeDeleted: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { actor } = await requireActor(ctx, args.token);
    const customerId = assertCustomerActor(actor);

    const rows = await ctx.db
      .query("feedback")
      .withIndex("by_owner", (q) => q.eq("ownerCustomerId", customerId))
      .order("desc")
      .collect();
    return args.includeDeleted ? rows : rows.filter((item) => item.deletedAt === undefined);
  },
});

export const ensureTicketNumbers = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const { actor } = await requireActor(ctx, args.token);
    assertStaffActor(actor);
    const result = await ensureTicketNumbersInDb(ctx);
    return { updated: result.assignments };
  },
});

export const getFeedback = query({
  args: {
    token: v.string(),
    id: v.id("feedback"),
  },
  handler: async (ctx, args) => {
    const { actor } = await requireActor(ctx, args.token);
    return await readableFeedback(ctx, actor, args.id);
  },
});

/** Ticket-number lookup for authenticated staff tools such as the Ticket CLI. */
export const getFeedbackByTicketNumber = query({
  args: {
    token: v.string(),
    ticketNumber: v.number(),
    includeDeleted: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { actor } = await requireActor(ctx, args.token);
    assertStaffActor(actor);
    const doc = await ctx.db
      .query("feedback")
      .withIndex("by_ticket_number", (q) => q.eq("ticketNumber", args.ticketNumber))
      .unique();
    if (!doc || (!args.includeDeleted && doc.deletedAt !== undefined)) return null;
    return doc;
  },
});

export const listAnnotationActivity = query({
  args: {
    token: v.string(),
    id: v.id("feedback"),
  },
  handler: async (ctx, args) => {
    const { actor } = await requireActor(ctx, args.token);
    if (!(await readableFeedback(ctx, actor, args.id))) return [];
    const events = await ctx.db
      .query("annotationEvents")
      .withIndex("by_feedback", (q) => q.eq("feedbackId", args.id))
      .order("desc")
      .take(30);
    return events.map(publicAnnotationEvent);
  },
});

export const listFeedbackActivity = query({
  args: { token: v.string(), id: v.id("feedback") },
  handler: async (ctx, args) => {
    const { actor } = await requireActor(ctx, args.token);
    if (!(await readableFeedback(ctx, actor, args.id))) return [];
    const events = await ctx.db
      .query("feedbackEvents")
      .withIndex("by_feedback", (q) => q.eq("feedbackId", args.id))
      .order("desc")
      .take(30);
    return events.map(publicFeedbackEvent);
  },
});

export const createFeedback = mutation({
  args: {
    token: v.string(),
    title: v.string(),
    description: v.string(),
    media: v.array(mediaItemValidator),
    annotations: v.optional(v.array(annotationCreateInputValidator)),
    uploadIntentId: v.id("uploadIntents"),
    uploadIntentSecret: v.string(),
  },
  handler: async (ctx, args) => {
    const { session, actor } = await requireActor(ctx, args.token);

    const { title, description } = validateFeedbackText(args.title, args.description);
    const intent = requireOwnedUploadIntent(
      await ctx.db.get(args.uploadIntentId),
      session,
      actor,
      args.uploadIntentSecret,
    );
    // The intent stays bound to the session that created it, and therefore to
    // the same actor; the actor columns are re-checked as defence in depth.
    if (intent.status === "attached" && intent.feedbackId) return intent.feedbackId;
    verifyPendingUploadIntent(intent, args.media);

    const now = Date.now();
    const annotations = (args.annotations ?? []).map((annotation, index) =>
      createAnnotationRecord(args.media, annotation, index + 1, crypto.randomUUID(), now)
    );
    const created = await createTicketRecord(ctx, {
      title,
      description,
      media: args.media,
      annotations,
      // Ownership is derived from the session; clients cannot pass it in.
      ownership: newFeedbackOwnership(actor),
      author: { sessionId: session._id, ...actorFields(actor) },
      now,
    });
    await ctx.db.patch(intent._id, { status: "attached", feedbackId: created._id, updatedAt: now });
    return created._id;
  },
});

/**
 * Authenticated text-only creation for the Ticket CLI. It shares staff sessions,
 * validation, ownership, ticket allocation, audit events and request id rules
 * with the rest of the Ticket domain.
 */
export const createTextFeedback = mutation({
  args: {
    token: v.string(),
    title: v.string(),
    description: v.string(),
    requestId: v.string(),
  },
  handler: async (ctx, args) => {
    const { session, actor } = await requireActor(ctx, args.token);
    assertStaffActor(actor);
    const requestId = normalizeRequestId(args.requestId);
    const { title, description } = validateFeedbackText(args.title, args.description);
    const existing = await ctx.db
      .query("feedback")
      .withIndex("by_external_request", (q) => q.eq("externalRequestId", requestId))
      .unique();
    if (existing) {
      assertSameTicketRequest(existing, { title, description });
      return { ticket: existing, created: false, requestId };
    }

    const created = await createTicketRecord(ctx, {
      title,
      description,
      media: [],
      ownership: newFeedbackOwnership(actor),
      author: { sessionId: session._id, ...actorFields(actor), createdVia: "codex" },
      externalRequestId: requestId,
      now: Date.now(),
    });
    return { ticket: created, created: true, requestId };
  },
});

export const attachFeedbackMedia = mutation({
  args: {
    token: v.string(),
    id: v.id("feedback"),
    media: v.array(mediaItemValidator),
    uploadIntentId: v.id("uploadIntents"),
    uploadIntentSecret: v.string(),
    expectedVersion: v.number(),
  },
  handler: async (ctx, args) => {
    const { session, actor } = await requireActor(ctx, args.token);
    assertStaffActor(actor);
    const doc = await requireWritableFeedback(ctx, actor, args.id);
    const intent = requireOwnedUploadIntent(
      await ctx.db.get(args.uploadIntentId),
      session,
      actor,
      args.uploadIntentSecret,
    );
    if (intent.status === "attached") {
      if (intent.feedbackId !== doc._id) throw new Error("UPLOAD_INTENT_MISMATCH");
      return { eventId: null, version: doc.version ?? 0 };
    }
    if (args.media.length === 0) throw new Error("UPLOAD_INCOMPLETE");
    validateMediaItems([...doc.media, ...args.media]);
    verifyPendingUploadIntent(intent, args.media);

    const now = Date.now();
    const changed = await applyTicketChange(ctx, {
      doc,
      expectedVersion: args.expectedVersion,
      changes: { media: [...doc.media, ...args.media] },
      action: "media_attached",
      author: { sessionId: session._id, ...actorFields(actor), createdVia: "codex" },
      now,
    });
    await ctx.db.patch(intent._id, { status: "attached", feedbackId: doc._id, updatedAt: now });
    return changed;
  },
});

export const updateFeedbackStatus = mutation({
  args: {
    token: v.string(),
    id: v.id("feedback"),
    status: feedbackStatus,
    expectedVersion: v.number(),
  },
  handler: async (ctx, args) => {
    const { session, actor } = await requireActor(ctx, args.token);
    assertStaffActor(actor);
    const doc = await ctx.db.get(args.id);
    if (!doc || doc.deletedAt !== undefined) throw new Error("FEEDBACK_NOT_FOUND");
    const currentVersion = requireCurrentVersion(doc, args.expectedVersion);
    if (doc.status === args.status) return { eventId: null, version: currentVersion };

    const { eventId, version } = await applyTicketChange(ctx, {
      doc,
      expectedVersion: args.expectedVersion,
      changes: { status: args.status },
      action: "status_changed",
      author: { sessionId: session._id, ...actorFields(actor) },
      now: Date.now(),
    });
    return { eventId, version };
  },
});

export const undoFeedbackStatus = mutation({
  args: {
    token: v.string(),
    eventId: v.id("feedbackEvents"),
    expectedVersion: v.number(),
  },
  handler: async (ctx, args) => {
    const { session, actor } = await requireActor(ctx, args.token);
    assertStaffActor(actor);
    const event = await ctx.db.get(args.eventId);
    if (!event || event.action !== "status_changed" || !event.before || !event.after) {
      throw new Error("STATUS_UNDO_UNAVAILABLE");
    }
    const doc = await ctx.db.get(event.feedbackId);
    if (!doc || doc.deletedAt !== undefined) throw new Error("FEEDBACK_NOT_FOUND");
    requireCurrentVersion(doc, args.expectedVersion);
    if (doc.status !== event.after.status) throw new Error("STATUS_UNDO_UNAVAILABLE");

    const { version } = await applyTicketChange(ctx, {
      doc,
      expectedVersion: args.expectedVersion,
      changes: { status: event.before.status },
      action: "status_undone",
      author: { sessionId: session._id, ...actorFields(actor) },
      sourceEventId: event._id,
      now: Date.now(),
    });
    return { version };
  },
});

export const undoFeedbackEdit = mutation({
  args: { token: v.string(), eventId: v.id("feedbackEvents"), expectedVersion: v.number() },
  handler: async (ctx, args) => {
    const { session, actor } = await requireActor(ctx, args.token);
    const event = await ctx.db.get(args.eventId);
    if (!event) throw new Error("FEEDBACK_NOT_FOUND");
    // Ownership is settled before the event itself is inspected, so undo cannot be
    // used to learn anything about another customer's audit trail.
    const doc = await requireWritableFeedback(ctx, actor, event.feedbackId);
    if (event.action !== "edited" || !event.before || !event.after) {
      throw new Error("EDIT_UNDO_UNAVAILABLE");
    }
    requireCurrentVersion(doc, args.expectedVersion);
    if (doc.title !== event.after.title || doc.description !== event.after.description) {
      throw new Error("EDIT_UNDO_UNAVAILABLE");
    }
    const { version } = await applyTicketChange(ctx, {
      doc,
      expectedVersion: args.expectedVersion,
      changes: { title: event.before.title, description: event.before.description },
      action: "edit_undone",
      author: { sessionId: session._id, ...actorFields(actor) },
      sourceEventId: event._id,
      now: Date.now(),
    });
    return { version };
  },
});

export const editFeedback = mutation({
  args: {
    token: v.string(),
    id: v.id("feedback"),
    title: v.string(),
    description: v.string(),
    expectedVersion: v.number(),
  },
  handler: async (ctx, args) => {
    const { session, actor } = await requireActor(ctx, args.token);
    const doc = await requireWritableFeedback(ctx, actor, args.id);
    const currentVersion = requireCurrentVersion(doc, args.expectedVersion);
    const { title, description } = validateFeedbackText(args.title, args.description);
    if (title === doc.title && description === doc.description) return { version: currentVersion };

    const { eventId, version } = await applyTicketChange(ctx, {
      doc,
      expectedVersion: args.expectedVersion,
      changes: { title, description },
      action: "edited",
      author: { sessionId: session._id, ...actorFields(actor) },
      now: Date.now(),
    });
    return { eventId, version };
  },
});

export const archiveFeedback = mutation({
  args: { token: v.string(), id: v.id("feedback"), expectedVersion: v.number() },
  handler: async (ctx, args) => {
    const { session, actor } = await requireActor(ctx, args.token);
    const doc = await requireWritableFeedback(ctx, actor, args.id);
    const now = Date.now();
    const { version } = await applyTicketChange(ctx, {
      doc,
      expectedVersion: args.expectedVersion,
      changes: { deletedAt: now },
      action: "archived",
      author: { sessionId: session._id, ...actorFields(actor) },
      now,
    });
    return { version };
  },
});

export const restoreFeedback = mutation({
  args: { token: v.string(), id: v.id("feedback"), expectedVersion: v.number() },
  handler: async (ctx, args) => {
    const { session, actor } = await requireActor(ctx, args.token);
    // Restoring an archived ticket is a staff control.
    assertStaffActor(actor);
    const doc = await ctx.db.get(args.id);
    if (!doc || doc.deletedAt === undefined) throw new Error("ARCHIVED_FEEDBACK_NOT_FOUND");
    const currentVersion = requireCurrentVersion(doc, args.expectedVersion);
    const now = Date.now();
    const { deletedAt: _deletedAt, ...restored } = doc;
    const after = { ...restored, version: currentVersion + 1, updatedAt: now };
    await ctx.db.replace(doc._id, after);
    await recordFeedbackEvent(ctx, {
      feedbackId: doc._id,
      action: "restored",
      before: feedbackState(doc),
      after: feedbackState(after),
      sessionId: session._id,
      ...actorFields(actor),
      createdAt: now,
    });
    return { version: currentVersion + 1 };
  },
});

export const addAnnotation = mutation({
  args: {
    token: v.string(),
    id: v.id("feedback"),
    mediaIndex: v.number(),
    kind: v.union(v.literal("point"), v.literal("time")),
    x: v.optional(v.number()),
    y: v.optional(v.number()),
    time: v.optional(v.number()),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    const { session, actor } = await requireActor(ctx, args.token);
    const doc = await requireWritableFeedback(ctx, actor, args.id);

    const annotations = doc.annotations ?? [];
    const label = annotations.reduce((max, item) => Math.max(max, item.label), 0) + 1;
    const now = Date.now();
    const annotation = createAnnotationRecord(doc.media, args, label, crypto.randomUUID(), now);

    await ctx.db.patch(args.id, {
      annotations: [...annotations, annotation],
      updatedAt: now,
    });

    await recordAnnotationEvent(ctx, {
      feedbackId: args.id,
      annotationId: annotation.id,
      action: "created",
      after: annotation,
      sessionId: session._id,
      ...actorFields(actor),
      createdAt: now,
    });

    return annotation.id;
  },
});

export const updateAnnotation = mutation({
  args: {
    token: v.string(),
    id: v.id("feedback"),
    annotationId: v.string(),
    text: v.optional(v.string()),
    x: v.optional(v.number()),
    y: v.optional(v.number()),
    time: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { session, actor } = await requireActor(ctx, args.token);
    const doc = await requireWritableFeedback(ctx, actor, args.id);

    const index = (doc.annotations ?? []).findIndex((item) => item.id === args.annotationId);
    if (index < 0) throw new Error("COMMENT_NOT_FOUND");

    const annotations = [...(doc.annotations ?? [])];
    const before = annotations[index];
    const now = Date.now();
    const after = updateAnnotationRecord(before, args, now);
    annotations[index] = after;

    await ctx.db.patch(args.id, { annotations, updatedAt: now });
    const eventId = await recordAnnotationEvent(ctx, {
      feedbackId: args.id,
      annotationId: args.annotationId,
      action: "updated",
      before,
      after,
      sessionId: session._id,
      ...actorFields(actor),
      createdAt: now,
    });
    return { eventId };
  },
});

export const undoAnnotationUpdate = mutation({
  args: { token: v.string(), eventId: v.id("annotationEvents") },
  handler: async (ctx, args) => {
    const { session, actor } = await requireActor(ctx, args.token);
    const event = await ctx.db.get(args.eventId);
    if (!event) throw new Error("FEEDBACK_NOT_FOUND");
    // Ownership first, for the same reason as undoFeedbackEdit.
    const doc = await requireWritableFeedback(ctx, actor, event.feedbackId);
    if (event.action !== "updated" || !event.before || !event.after) {
      throw new Error("COMMENT_UNDO_UNAVAILABLE");
    }
    const annotations = [...(doc.annotations ?? [])];
    const index = annotations.findIndex((annotation) => annotation.id === event.annotationId);
    if (index < 0 || annotations[index].deletedAt !== undefined) throw new Error("COMMENT_NOT_FOUND");
    if (annotations[index].updatedAt !== event.after.updatedAt) {
      throw new Error("COMMENT_UNDO_UNAVAILABLE");
    }
    const now = Date.now();
    const before = annotations[index];
    const after = { ...event.before, updatedAt: now };
    annotations[index] = after;
    await ctx.db.patch(doc._id, { annotations, updatedAt: now });
    await recordAnnotationEvent(ctx, {
      feedbackId: doc._id,
      annotationId: event.annotationId,
      action: "update_undone",
      before,
      after,
      sessionId: session._id,
      ...actorFields(actor),
      createdAt: now,
    });
  },
});

export const removeAnnotation = mutation({
  args: {
    token: v.string(),
    id: v.id("feedback"),
    annotationId: v.string(),
  },
  handler: async (ctx, args) => {
    const { session, actor } = await requireActor(ctx, args.token);
    const doc = await requireWritableFeedback(ctx, actor, args.id);

    const index = (doc.annotations ?? []).findIndex((item) => item.id === args.annotationId);
    if (index < 0) throw new Error("COMMENT_NOT_FOUND");

    const annotations = [...(doc.annotations ?? [])];
    const before = annotations[index];
    const now = Date.now();
    const after = softDeleteAnnotationRecord(before, now);
    annotations[index] = after;
    await ctx.db.patch(args.id, {
      annotations,
      updatedAt: now,
    });
    await recordAnnotationEvent(ctx, {
      feedbackId: args.id,
      annotationId: args.annotationId,
      action: "deleted",
      before,
      after,
      sessionId: session._id,
      ...actorFields(actor),
      createdAt: now,
    });
  },
});

export const restoreAnnotation = mutation({
  args: {
    token: v.string(),
    id: v.id("feedback"),
    annotationId: v.string(),
  },
  handler: async (ctx, args) => {
    const { session, actor } = await requireActor(ctx, args.token);
    const doc = await requireWritableFeedback(ctx, actor, args.id);

    const index = (doc.annotations ?? []).findIndex((item) => item.id === args.annotationId);
    if (index < 0) throw new Error("COMMENT_NOT_FOUND");

    const annotations = [...(doc.annotations ?? [])];
    const before = annotations[index];
    const now = Date.now();
    const after = restoreAnnotationRecord(before, now);
    annotations[index] = after;

    await ctx.db.patch(args.id, { annotations, updatedAt: now });
    await recordAnnotationEvent(ctx, {
      feedbackId: args.id,
      annotationId: args.annotationId,
      action: "restored",
      before,
      after,
      sessionId: session._id,
      ...actorFields(actor),
      createdAt: now,
    });
  },
});

export const listFeedbackForPurge = internalQuery({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    return await ctx.db
      .query("feedback")
      .withIndex("by_deleted_at", (q) => q.gte("deletedAt", 0).lt("deletedAt", cutoff))
      .take(25);
  },
});

export const purgeFeedback = internalMutation({
  args: { id: v.id("feedback") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.id);
    if (!doc?.deletedAt || doc.deletedAt > Date.now() - 30 * 24 * 60 * 60 * 1000) return;
    const feedbackEvents = await ctx.db
      .query("feedbackEvents")
      .withIndex("by_feedback", (q) => q.eq("feedbackId", args.id))
      .collect();
    const annotationEvents = await ctx.db
      .query("annotationEvents")
      .withIndex("by_feedback", (q) => q.eq("feedbackId", args.id))
      .collect();
    for (const event of [...feedbackEvents, ...annotationEvents]) await ctx.db.delete(event._id);
    await ctx.db.delete(args.id);
  },
});
