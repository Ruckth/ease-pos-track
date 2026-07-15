import { v } from "convex/values";
import { annotationCreateInputValidator, feedbackStatus, mediaItemValidator } from "./schema";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  createAnnotationRecord,
  restoreAnnotationRecord,
  softDeleteAnnotationRecord,
  updateAnnotationRecord,
  type AnnotationRecord,
} from "./annotation_state";
import { requireCurrentVersion, validateFeedbackText } from "./feedback_state";
import { planTicketNumberBackfill } from "./ticket_numbers";

const FEEDBACK_COUNTER_NAME = "feedback";

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

async function recordAnnotationEvent(
  ctx: MutationCtx,
  input: {
    feedbackId: Id<"feedback">;
    annotationId: string;
    action: "created" | "updated" | "deleted" | "restored" | "update_undone";
    before?: AnnotationRecord;
    after?: AnnotationRecord;
    sessionId: Id<"sessions">;
    createdAt: number;
  },
) {
  return await ctx.db.insert("annotationEvents", input);
}

function feedbackState(doc: Doc<"feedback">) {
  return {
    title: doc.title,
    description: doc.description,
    status: doc.status,
    version: doc.version ?? 0,
    ...(doc.deletedAt === undefined ? {} : { deletedAt: doc.deletedAt }),
  };
}

async function recordFeedbackEvent(
  ctx: MutationCtx,
  input: {
    feedbackId: Id<"feedback">;
    action: "created" | "edited" | "edit_undone" | "status_changed" | "status_undone" | "archived" | "restored";
    before?: ReturnType<typeof feedbackState>;
    after?: ReturnType<typeof feedbackState>;
    sessionId: Id<"sessions">;
    sourceEventId?: Id<"feedbackEvents">;
    createdAt: number;
  },
) {
  return await ctx.db.insert("feedbackEvents", input);
}

async function ensureTicketNumbersInDb(ctx: MutationCtx) {
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

export const listFeedback = query({
  args: {
    token: v.string(),
    includeDeleted: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);

    const rows = await ctx.db.query("feedback").withIndex("by_created_at").order("desc").collect();
    return args.includeDeleted ? rows : rows.filter((item) => item.deletedAt === undefined);
  },
});

export const ensureTicketNumbers = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
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
    await requireSession(ctx, args.token);
    return await ctx.db.get(args.id);
  },
});

export const listAnnotationActivity = query({
  args: {
    token: v.string(),
    id: v.id("feedback"),
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    return await ctx.db
      .query("annotationEvents")
      .withIndex("by_feedback", (q) => q.eq("feedbackId", args.id))
      .order("desc")
      .take(30);
  },
});

export const listFeedbackActivity = query({
  args: { token: v.string(), id: v.id("feedback") },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    return await ctx.db
      .query("feedbackEvents")
      .withIndex("by_feedback", (q) => q.eq("feedbackId", args.id))
      .order("desc")
      .take(30);
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
    const session = await requireSession(ctx, args.token);

    const { title, description } = validateFeedbackText(args.title, args.description);
    if (args.media.length === 0) {
      throw new Error("REQUIRED_FEEDBACK");
    }
    const imageCount = args.media.filter((item) => item.type.startsWith("image/")).length;
    const videoCount = args.media.filter((item) => item.type.startsWith("video/")).length;
    if (imageCount + videoCount !== args.media.length) {
      throw new Error("IMAGE_VIDEO_ONLY");
    }
    if (imageCount > 10 || videoCount > 3) {
      throw new Error("MEDIA_LIMIT_EXCEEDED");
    }
    for (const item of args.media) {
      const sizeLimit = item.type.startsWith("image/") ? 8 * 1024 * 1024 : 64 * 1024 * 1024;
      if (!item.key || !item.url.startsWith("https://") || item.size <= 0 || item.size > sizeLimit) {
        throw new Error("INVALID_MEDIA_REFERENCE");
      }
    }

    const intent = await ctx.db.get(args.uploadIntentId);
    if (!intent || intent.sessionId !== session._id || intent.secret !== args.uploadIntentSecret) {
      throw new Error("UPLOAD_INTENT_NOT_FOUND");
    }
    if (intent.status === "attached" && intent.feedbackId) return intent.feedbackId;
    if (intent.status !== "pending" || intent.expiresAt <= Date.now()) {
      throw new Error("UPLOAD_INTENT_INVALID");
    }
    if (intent.uploadedFiles.length !== args.media.length) throw new Error("UPLOAD_INCOMPLETE");
    const uploadedByKey = new Map(intent.uploadedFiles.map((item) => [item.key, item]));
    const verified = args.media.every((item) => {
      const uploaded = uploadedByKey.get(item.key);
      return uploaded
        && uploaded.url === item.url
        && uploaded.name === item.name
        && uploaded.size === item.size
        && uploaded.type === item.type;
    });
    if (!verified) throw new Error("UPLOAD_VERIFICATION_FAILED");

    const now = Date.now();
    const annotations = (args.annotations ?? []).map((annotation, index) =>
      createAnnotationRecord(args.media, annotation, index + 1, crypto.randomUUID(), now)
    );
    const ticketNumber = await allocateTicketNumber(ctx);
    const feedbackId = await ctx.db.insert("feedback", {
      title,
      description,
      status: "new",
      ticketNumber,
      media: args.media,
      ...(annotations.length === 0 ? {} : { annotations }),
      version: 0,
      createdAt: now,
      updatedAt: now,
    });
    const created = await ctx.db.get(feedbackId);
    if (!created) throw new Error("CREATE_FEEDBACK_FAILED");
    await ctx.db.patch(intent._id, { status: "attached", feedbackId, updatedAt: now });
    await recordFeedbackEvent(ctx, {
      feedbackId,
      action: "created",
      after: feedbackState(created),
      sessionId: session._id,
      createdAt: now,
    });
    for (const annotation of annotations) {
      await recordAnnotationEvent(ctx, {
        feedbackId,
        annotationId: annotation.id,
        action: "created",
        after: annotation,
        sessionId: session._id,
        createdAt: now,
      });
    }
    return feedbackId;
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
    const session = await requireSession(ctx, args.token);
    const doc = await ctx.db.get(args.id);
    if (!doc || doc.deletedAt !== undefined) throw new Error("FEEDBACK_NOT_FOUND");
    const currentVersion = requireCurrentVersion(doc, args.expectedVersion);
    if (doc.status === args.status) return { eventId: null, version: currentVersion };

    const now = Date.now();
    const after = { ...doc, status: args.status, version: currentVersion + 1, updatedAt: now };
    await ctx.db.patch(args.id, {
      status: args.status,
      version: currentVersion + 1,
      updatedAt: now,
    });
    const eventId = await recordFeedbackEvent(ctx, {
      feedbackId: args.id,
      action: "status_changed",
      before: feedbackState(doc),
      after: feedbackState(after),
      sessionId: session._id,
      createdAt: now,
    });
    return { eventId, version: currentVersion + 1 };
  },
});

export const undoFeedbackStatus = mutation({
  args: {
    token: v.string(),
    eventId: v.id("feedbackEvents"),
    expectedVersion: v.number(),
  },
  handler: async (ctx, args) => {
    const session = await requireSession(ctx, args.token);
    const event = await ctx.db.get(args.eventId);
    if (!event || event.action !== "status_changed" || !event.before || !event.after) {
      throw new Error("STATUS_UNDO_UNAVAILABLE");
    }
    const doc = await ctx.db.get(event.feedbackId);
    if (!doc || doc.deletedAt !== undefined) throw new Error("FEEDBACK_NOT_FOUND");
    const currentVersion = requireCurrentVersion(doc, args.expectedVersion);
    if (doc.status !== event.after.status) throw new Error("STATUS_UNDO_UNAVAILABLE");

    const now = Date.now();
    const after = { ...doc, status: event.before.status, version: currentVersion + 1, updatedAt: now };
    await ctx.db.patch(doc._id, { status: event.before.status, version: currentVersion + 1, updatedAt: now });
    await recordFeedbackEvent(ctx, {
      feedbackId: doc._id,
      action: "status_undone",
      before: feedbackState(doc),
      after: feedbackState(after),
      sessionId: session._id,
      sourceEventId: event._id,
      createdAt: now,
    });
    return { version: currentVersion + 1 };
  },
});

export const undoFeedbackEdit = mutation({
  args: { token: v.string(), eventId: v.id("feedbackEvents"), expectedVersion: v.number() },
  handler: async (ctx, args) => {
    const session = await requireSession(ctx, args.token);
    const event = await ctx.db.get(args.eventId);
    if (!event || event.action !== "edited" || !event.before || !event.after) {
      throw new Error("EDIT_UNDO_UNAVAILABLE");
    }
    const doc = await ctx.db.get(event.feedbackId);
    if (!doc || doc.deletedAt !== undefined) throw new Error("FEEDBACK_NOT_FOUND");
    const currentVersion = requireCurrentVersion(doc, args.expectedVersion);
    if (doc.title !== event.after.title || doc.description !== event.after.description) {
      throw new Error("EDIT_UNDO_UNAVAILABLE");
    }
    const now = Date.now();
    const after = {
      ...doc,
      title: event.before.title,
      description: event.before.description,
      version: currentVersion + 1,
      updatedAt: now,
    };
    await ctx.db.patch(doc._id, {
      title: event.before.title,
      description: event.before.description,
      version: currentVersion + 1,
      updatedAt: now,
    });
    await recordFeedbackEvent(ctx, {
      feedbackId: doc._id,
      action: "edit_undone",
      before: feedbackState(doc),
      after: feedbackState(after),
      sessionId: session._id,
      sourceEventId: event._id,
      createdAt: now,
    });
    return { version: currentVersion + 1 };
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
    const session = await requireSession(ctx, args.token);
    const doc = await ctx.db.get(args.id);
    if (!doc || doc.deletedAt !== undefined) throw new Error("FEEDBACK_NOT_FOUND");
    const currentVersion = requireCurrentVersion(doc, args.expectedVersion);
    const { title, description } = validateFeedbackText(args.title, args.description);
    if (title === doc.title && description === doc.description) return { version: currentVersion };

    const now = Date.now();
    const after = { ...doc, title, description, version: currentVersion + 1, updatedAt: now };
    await ctx.db.patch(doc._id, { title, description, version: currentVersion + 1, updatedAt: now });
    const eventId = await recordFeedbackEvent(ctx, {
      feedbackId: doc._id,
      action: "edited",
      before: feedbackState(doc),
      after: feedbackState(after),
      sessionId: session._id,
      createdAt: now,
    });
    return { eventId, version: currentVersion + 1 };
  },
});

export const archiveFeedback = mutation({
  args: { token: v.string(), id: v.id("feedback"), expectedVersion: v.number() },
  handler: async (ctx, args) => {
    const session = await requireSession(ctx, args.token);
    const doc = await ctx.db.get(args.id);
    if (!doc || doc.deletedAt !== undefined) throw new Error("FEEDBACK_NOT_FOUND");
    const currentVersion = requireCurrentVersion(doc, args.expectedVersion);
    const now = Date.now();
    const after = { ...doc, deletedAt: now, version: currentVersion + 1, updatedAt: now };
    await ctx.db.patch(doc._id, { deletedAt: now, version: currentVersion + 1, updatedAt: now });
    await recordFeedbackEvent(ctx, {
      feedbackId: doc._id,
      action: "archived",
      before: feedbackState(doc),
      after: feedbackState(after),
      sessionId: session._id,
      createdAt: now,
    });
    return { version: currentVersion + 1 };
  },
});

export const restoreFeedback = mutation({
  args: { token: v.string(), id: v.id("feedback"), expectedVersion: v.number() },
  handler: async (ctx, args) => {
    const session = await requireSession(ctx, args.token);
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
    const session = await requireSession(ctx, args.token);

    const doc = await ctx.db.get(args.id);
    if (!doc || doc.deletedAt !== undefined) throw new Error("FEEDBACK_NOT_FOUND");

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
    const session = await requireSession(ctx, args.token);
    const doc = await ctx.db.get(args.id);
    if (!doc || doc.deletedAt !== undefined) throw new Error("FEEDBACK_NOT_FOUND");

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
      createdAt: now,
    });
    return { eventId };
  },
});

export const undoAnnotationUpdate = mutation({
  args: { token: v.string(), eventId: v.id("annotationEvents") },
  handler: async (ctx, args) => {
    const session = await requireSession(ctx, args.token);
    const event = await ctx.db.get(args.eventId);
    if (!event || event.action !== "updated" || !event.before || !event.after) {
      throw new Error("COMMENT_UNDO_UNAVAILABLE");
    }
    const doc = await ctx.db.get(event.feedbackId);
    if (!doc || doc.deletedAt !== undefined) throw new Error("FEEDBACK_NOT_FOUND");
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
    const session = await requireSession(ctx, args.token);

    const doc = await ctx.db.get(args.id);
    if (!doc || doc.deletedAt !== undefined) throw new Error("FEEDBACK_NOT_FOUND");

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
    const session = await requireSession(ctx, args.token);
    const doc = await ctx.db.get(args.id);
    if (!doc || doc.deletedAt !== undefined) throw new Error("FEEDBACK_NOT_FOUND");

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
