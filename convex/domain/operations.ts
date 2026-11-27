import { patchMediaJob } from "./media_jobs";
import { queryOperation, mutationOperation } from "./operation";
import { ticketDetail, resolveTicketTags } from "./reads";
import { v } from "convex/values";
import { annotationCreateInputValidator, ticketStatus, mediaItemValidator } from "../schema";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import {
  actorFields,
  assertCanWriteTicket,
  canReadTicket,
  newTicketOwnership,
  type Actor,
} from "../authz";
import {
  createAnnotationRecord,
  restoreAnnotationRecord,
  softDeleteAnnotationRecord,
  updateAnnotationRecord,
} from "../annotation_state";
import { classificationInput } from "../routing_schema";
import { validateTicketClassification } from "./routing_policy";
import { requireCurrentVersion, validateTicketText, validateUrgencyScore } from "../../shared/ticket-state";
import { hashTicketRequest, normalizeRequestId } from "../ticket_requests";
import { ticketRequestFingerprintInput, ticketMediaRequestFingerprintInput } from "../../shared/ticket-contracts";
import { commitTicketRequest, replayTicketRequest, type RequestScope } from "./requests";
import { normalizeProjectKey } from "../../shared/ticket-numbers";
import { isMember, requireUsableProject, resolveStaffProject } from "./projects";
import { legacyMediaEnabled, projectInDeployment, requireLegacyMedia } from "../pilot_access";
import { validateMediaItems } from "../../shared/media-policy";
import { requireOwnedUploadIntent, verifyPendingUploadIntent, verifyAssetReceipts, attachIntentAssets } from "./media";
import {
  applyTicketChange,
  createTicketRecord,
  recordAnnotationEvent,
} from "./tickets";

/**
 * Loads a ticket the actor may read, or null. Denied and non-existent tickets are
 * indistinguishable, so the portal cannot be used to probe for ticket ids.
 */
export async function readableTicket(
  ctx: QueryCtx | MutationCtx,
  actor: Actor<Id<"customers">>,
  id: Id<"tickets">,
) {
  const doc = await ctx.db.get(id);
  if (!doc || doc.lifecycle === "purging" || !canReadTicket(actor, doc)) return null;
  if (!await projectInDeployment(ctx, doc.projectId)) return null;
  if (actor.role === "customer") {
    if (doc.lifecycle !== "active") return null;
    const project = await ctx.db.get(doc.projectId);
    if (!project || project.archivedAt !== undefined || !await isMember(ctx, doc.projectId, actor)) return null;
  }
  return doc;
}

/**
 * Normalizes untrusted Ticket id strings (such as URL `?ticket=` params) before
 * loading. Malformed, cross-table, missing, purging and unauthorized inputs all
 * return null so reads never crash or leak whether a Ticket id exists.
 */
async function readableTicketInput(
  ctx: QueryCtx,
  actor: Actor<Id<"customers">>,
  id: string,
) {
  const ticketId = ctx.db.normalizeId("tickets", id);
  if (!ticketId) return null;
  return readableTicket(ctx, actor, ticketId);
}

function publicAnnotationEvent(event: Doc<"annotationEvents">) {
  return {
    _id: event._id,
    _creationTime: event._creationTime,
    ticketId: event.ticketId,
    annotationId: event.annotationId,
    action: event.action,
    before: event.before,
    after: event.after,
    createdAt: event.createdAt,
  };
}

function publicTicketEvent(event: Doc<"ticketEvents">, mediaEnabled: boolean, role: Actor<Id<"customers">>["role"]) {
  const state = (value: Doc<"ticketEvents">["before"]) => {
    if (!value) return value;
    const { urgencyScore: _internalUrgency, ...customerSafe } = value;
    const base = role === "staff" ? value : customerSafe;
    return mediaEnabled ? base : { ...base, mediaCount: 0, annotationCount: 0 };
  };
  return {
    _id: event._id,
    _creationTime: event._creationTime,
    ticketId: event.ticketId,
    action: event.action,
    before: state(event.before),
    after: state(event.after),
    sourceEventId: event.sourceEventId,
    createdAt: event.createdAt,
  };
}

/** Loads an active ticket the actor is allowed to change. */
export async function requireWritableTicket(
  ctx: MutationCtx,
  actor: Actor<Id<"customers">>,
  id: Id<"tickets">,
) {
  const doc = await readableTicket(ctx, actor, id);
  if (!doc || doc.lifecycle !== "active") throw new Error("TICKET_UNAVAILABLE");
  assertCanWriteTicket(actor, doc);
  return doc;
}

export const getTicket = queryOperation({
  args: {
    id: v.string(),
  },
  handler: async (ctx, args) => {
    const { actor } = ctx;
    const row = await readableTicketInput(ctx, actor, args.id);
    return row ? ticketDetail(row, await resolveTicketTags(ctx, row), actor.role) : null;
  },
});

/** Normalize a browser deep link before resolving it within the current Project. */
export const getWorkspaceTicket = queryOperation({
  args: { projectId: v.id("projects"), ticket: v.string() },
  handler: async (ctx, args) => {
    const row = await readableTicketInput(ctx, ctx.actor, args.ticket);
    if (!row || row.projectId !== args.projectId) return null;
    const project = await ctx.db.get(row.projectId);
    if (!project || project.archivedAt !== undefined) return null;
    return ticketDetail(row, await resolveTicketTags(ctx, row), ctx.actor.role);
  },
});

/** Ticket-reference lookup (`POS-0012`) for authenticated staff tools such as the Ticket CLI. */
export const getTicketByTicketNumber = queryOperation({
  args: {
    projectKey: v.string(),
    ticketNumber: v.number(),
    includeDeleted: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const projectKey = normalizeProjectKey(args.projectKey);
    const doc = await ctx.db
      .query("tickets")
      .withIndex("by_project_ticket", (q) => q.eq("projectKey", projectKey).eq("ticketNumber", args.ticketNumber))
      .unique();
    if (!doc || doc.lifecycle === "purging" || (!args.includeDeleted && doc.lifecycle !== "active")
      || !await projectInDeployment(ctx, doc.projectId)) return null;
    return ticketDetail(doc, await resolveTicketTags(ctx, doc));
  },
});

export const listAnnotationActivity = queryOperation({
  args: {
    id: v.string(),
  },
  handler: async (ctx, args) => {
    const { actor } = ctx;
    const ticket = await readableTicketInput(ctx, actor, args.id);
    if (!ticket) return [];
    if (!legacyMediaEnabled()) return [];
    const events = await ctx.db
      .query("annotationEvents")
      .withIndex("by_ticket", (q) => q.eq("ticketId", ticket._id))
      .order("desc")
      .take(30);
    return events.map(publicAnnotationEvent);
  },
});

export const listTicketActivity = queryOperation({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const { actor } = ctx;
    const ticket = await readableTicketInput(ctx, actor, args.id);
    if (!ticket) return [];
    const events = await ctx.db
      .query("ticketEvents")
      .withIndex("by_ticket", (q) => q.eq("ticketId", ticket._id))
      .order("desc")
      .take(30);
    const mediaEnabled = legacyMediaEnabled();
    return events
      .filter(event => (mediaEnabled || (event.action !== "media_attached" && event.action !== "annotation_changed"))
        && (actor.role === "staff" || (event.action !== "urgency_changed" && event.action !== "urgency_undone")))
      .map(event => publicTicketEvent(event, mediaEnabled, actor.role));
  },
});

export const createTicket = mutationOperation({
  args: {
    projectId: v.id("projects"),
    title: v.string(),
    description: v.string(),
    media: v.array(mediaItemValidator),
    annotations: v.optional(v.array(annotationCreateInputValidator)),
    routingClassification: v.optional(classificationInput),
    requestId: v.string(),
    uploadIntentId: v.optional(v.id("uploadIntents")),
    uploadIntentSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { session, actor } = ctx;
    if (args.media.length || args.annotations?.length || args.uploadIntentId !== undefined || args.uploadIntentSecret !== undefined) {
      requireLegacyMedia();
      if (args.uploadIntentId === undefined || args.uploadIntentSecret === undefined) throw new Error("UPLOAD_INTENT_INVALID");
    }
    const project = await requireUsableProject(ctx, actor, args.projectId);
    const request: RequestScope = {
      operation: "ticket.create", requestId: normalizeRequestId(args.requestId), actor, projectId: args.projectId,
      ...await hashTicketRequest(ticketRequestFingerprintInput({ ...args, actor, mediaKeys: args.media.map(item => item.key) })),
    };
    const replay = await replayTicketRequest(ctx, request);
    const { title, description } = replay ? args : validateTicketText(args.title, args.description);
    const intent = args.uploadIntentId !== undefined && args.uploadIntentSecret !== undefined
      ? requireOwnedUploadIntent(await ctx.db.get(args.uploadIntentId), actor, args.uploadIntentSecret)
      : null;
    if (replay) {
      if (intent) await verifyAssetReceipts(ctx, intent._id, args.media, replay.ticket._id);
      return replay.ticket._id;
    }
    const routingClassification = args.routingClassification && {
      ...await validateTicketClassification(ctx, project._id, args.routingClassification),
      reviewed: false,
    };
    if (intent) await verifyPendingUploadIntent(ctx, intent, args.media);

    const now = Date.now();
    const annotations = (args.annotations ?? []).map((annotation, index) =>
      createAnnotationRecord(args.media, annotation, index + 1, crypto.randomUUID(), now)
    );
    const created = await createTicketRecord(ctx, {
      project,
      title,
      description,
      media: args.media,
      annotations,
      routingClassification,
      // Ownership is derived from the session; clients cannot pass it in.
      ownership: newTicketOwnership(actor),
      author: { sessionId: session._id, ...actorFields(actor) },
      now,
    });
    if (intent) await attachIntentAssets(ctx, intent, created._id, args.media);
    await commitTicketRequest(ctx, request, { ticketId: created._id, version: created.version });
    return created._id;
  },
});

/**
 * Authenticated text-only creation for the Ticket CLI. It shares staff sessions,
 * validation, ownership, ticket allocation, audit events and request id rules
 * with the rest of the Ticket domain. `projectKey` may be omitted only while a
 * single Project exists.
 */
export const createTextTicket = mutationOperation({
  args: {
    projectKey: v.optional(v.string()),
    title: v.string(),
    description: v.string(),
    requestId: v.string(),
  },
  handler: async (ctx, args) => {
    const { session, actor } = ctx;
    const requestId = normalizeRequestId(args.requestId);
    const { title, description } = validateTicketText(args.title, args.description);
    const selected = await resolveStaffProject(ctx, args.projectKey);
    const project = await requireUsableProject(ctx, actor, selected._id);
    const request: RequestScope = {
      operation: "ticket.create", requestId, actor, projectId: selected._id,
      ...await hashTicketRequest(ticketRequestFingerprintInput({ ...args, actor, projectId: selected._id })),
    };
    const replay = await replayTicketRequest(ctx, request);
    if (replay) return { ticket: ticketDetail(replay.ticket, await resolveTicketTags(ctx, replay.ticket), actor.role), created: false, requestId };

    const created = await createTicketRecord(ctx, {
      project,
      title,
      description,
      media: [],
      ownership: newTicketOwnership(actor),
      author: { sessionId: session._id, ...actorFields(actor), ...(actor.role === "staff" ? { createdVia: "codex" as const } : {}) },
      now: Date.now(),
    });
    await commitTicketRequest(ctx, request, { ticketId: created._id, version: created.version });
    return { ticket: ticketDetail(created, [], actor.role), created: true, requestId };
  },
});

export const attachTicketMedia = mutationOperation({
  args: {
    id: v.id("tickets"),
    media: v.array(mediaItemValidator),
    uploadIntentId: v.id("uploadIntents"),
    uploadIntentSecret: v.string(),
    expectedVersion: v.number(),
    requestId: v.string(),
  },
  handler: async (ctx, args) => {
    requireLegacyMedia();
    const { session, actor } = ctx;
    const visible = await readableTicket(ctx, actor, args.id);
    if (!visible) throw new Error("TICKET_UNAVAILABLE");
    const request: RequestScope = {
      operation: "ticket.attach_media", requestId: normalizeRequestId(args.requestId), actor, projectId: visible.projectId,
      ...await hashTicketRequest(ticketMediaRequestFingerprintInput({ actor, projectId: visible.projectId, ticketId: args.id, mediaKeys: args.media.map(item => item.key) })),
    };
    const replay = await replayTicketRequest(ctx, request);
    if (replay) {
      requireOwnedUploadIntent(await ctx.db.get(args.uploadIntentId), actor, args.uploadIntentSecret);
      await verifyAssetReceipts(ctx, args.uploadIntentId, args.media, replay.ticket._id);
      return { eventId: replay.receipt.eventId ?? null, version: replay.receipt.version };
    }
    const doc = await requireWritableTicket(ctx, actor, args.id);
    const intent = requireOwnedUploadIntent(
      await ctx.db.get(args.uploadIntentId),
      actor,
      args.uploadIntentSecret,
    );
    if (args.media.length === 0) throw new Error("UPLOAD_INCOMPLETE");
    validateMediaItems([...doc.media, ...args.media]);
    await verifyPendingUploadIntent(ctx, intent, args.media);

    const now = Date.now();
    const changed = await applyTicketChange(ctx, {
      doc,
      expectedVersion: args.expectedVersion,
      changes: { media: [...doc.media, ...args.media] },
      action: "media_attached",
      author: { sessionId: session._id, ...actorFields(actor), createdVia: "codex" },
      now,
    });
    await attachIntentAssets(ctx, intent, doc._id, args.media);
    await commitTicketRequest(ctx, request, { ticketId: doc._id, ...changed });
    return changed;
  },
});

export const updateTicketStatus = mutationOperation({
  args: {
    id: v.id("tickets"),
    status: ticketStatus,
    expectedVersion: v.number(),
  },
  handler: async (ctx, args) => {
    const { session, actor } = ctx;
    const doc = await ctx.db.get(args.id);
    if (!doc || doc.lifecycle !== "active" || !await projectInDeployment(ctx, doc.projectId)) throw new Error("TICKET_UNAVAILABLE");
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

/** Staff triage control for the optional 1-100 urgency score. */
export const updateUrgencyScore = mutationOperation({
  args: {
    id: v.id("tickets"),
    urgencyScore: v.optional(v.number()),
    expectedVersion: v.number(),
  },
  handler: async (ctx, args) => {
    const { session, actor } = ctx;
    const doc = await requireWritableTicket(ctx, actor, args.id);
    const currentVersion = requireCurrentVersion(doc, args.expectedVersion);
    const urgencyScore = validateUrgencyScore(args.urgencyScore);
    if (doc.urgencyScore === urgencyScore) return { eventId: null, version: currentVersion };

    return await applyTicketChange(ctx, {
      doc,
      expectedVersion: args.expectedVersion,
      changes: { urgencyScore },
      action: "urgency_changed",
      author: { sessionId: session._id, ...actorFields(actor) },
      now: Date.now(),
    });
  },
});

export const undoUrgencyScore = mutationOperation({
  args: {
    eventId: v.id("ticketEvents"),
    expectedVersion: v.number(),
  },
  handler: async (ctx, args) => {
    const { session, actor } = ctx;
    const event = await ctx.db.get(args.eventId);
    if (!event || event.action !== "urgency_changed" || !event.before || !event.after) {
      throw new Error("URGENCY_UNDO_UNAVAILABLE");
    }
    const doc = await requireWritableTicket(ctx, actor, event.ticketId);
    requireCurrentVersion(doc, args.expectedVersion);
    if (doc.urgencyScore !== event.after.urgencyScore) throw new Error("URGENCY_UNDO_UNAVAILABLE");

    const { version } = await applyTicketChange(ctx, {
      doc,
      expectedVersion: args.expectedVersion,
      changes: { urgencyScore: event.before.urgencyScore },
      action: "urgency_undone",
      author: { sessionId: session._id, ...actorFields(actor) },
      sourceEventId: event._id,
      now: Date.now(),
    });
    return { version };
  },
});

export const undoTicketStatus = mutationOperation({
  args: {
    eventId: v.id("ticketEvents"),
    expectedVersion: v.number(),
  },
  handler: async (ctx, args) => {
    const { session, actor } = ctx;
    const event = await ctx.db.get(args.eventId);
    if (!event || event.action !== "status_changed" || !event.before || !event.after) {
      throw new Error("STATUS_UNDO_UNAVAILABLE");
    }
    const doc = await ctx.db.get(event.ticketId);
    if (!doc || doc.lifecycle !== "active" || !await projectInDeployment(ctx, doc.projectId)) throw new Error("TICKET_UNAVAILABLE");
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

export const undoTicketEdit = mutationOperation({
  args: { eventId: v.id("ticketEvents"), expectedVersion: v.number() },
  handler: async (ctx, args) => {
    const { session, actor } = ctx;
    const event = await ctx.db.get(args.eventId);
    if (!event) throw new Error("TICKET_UNAVAILABLE");
    // Ownership is settled before the event itself is inspected, so undo cannot be
    // used to learn anything about another customer's audit trail.
    const doc = await requireWritableTicket(ctx, actor, event.ticketId);
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

export const editTicket = mutationOperation({
  args: {
    id: v.id("tickets"),
    title: v.string(),
    description: v.string(),
    expectedVersion: v.number(),
  },
  handler: async (ctx, args) => {
    const { session, actor } = ctx;
    const doc = await requireWritableTicket(ctx, actor, args.id);
    const currentVersion = requireCurrentVersion(doc, args.expectedVersion);
    const { title, description } = validateTicketText(args.title, args.description);
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

export const archiveTicket = mutationOperation({
  args: { id: v.id("tickets"), expectedVersion: v.number() },
  handler: async (ctx, args) => {
    const { session, actor } = ctx;
    const doc = await requireWritableTicket(ctx, actor, args.id);
    const now = Date.now();
    const { version } = await applyTicketChange(ctx, {
      doc,
      expectedVersion: args.expectedVersion,
      changes: { archivedAt: now, lifecycle: "archived" },
      action: "archived",
      author: { sessionId: session._id, ...actorFields(actor) },
      now,
    });
    return { version };
  },
});

export const restoreTicket = mutationOperation({
  args: { id: v.id("tickets"), expectedVersion: v.number() },
  handler: async (ctx, args) => {
    const { session, actor } = ctx;
    // Restoring an archived ticket is a staff control.
    const doc = await ctx.db.get(args.id);
    if (!doc || !await projectInDeployment(ctx, doc.projectId)) throw new Error("TICKET_UNAVAILABLE");
    if (doc.lifecycle === "purging") throw new Error("TICKET_PURGING");
    if (doc.lifecycle !== "archived") throw new Error("TICKET_UNAVAILABLE");
    const result = await applyTicketChange(ctx, {
      doc,
      expectedVersion: args.expectedVersion,
      changes: { lifecycle: "active", archivedAt: undefined },
      action: "restored",
      author: { sessionId: session._id, ...actorFields(actor) },
      now: Date.now(),
    });
    await ctx.db.patch(doc._id, { purgeBlocked: undefined });
    const failed = await ctx.db.query("mediaJobs").withIndex("by_scope", q => q.eq("resourceScope", `ticket:${doc._id}`).eq("state", "failed")).unique();
    if (failed) {
      // Restore ends this archive cycle. Retire its job and release the scope for a future cycle.
      await patchMediaJob(ctx, failed, { state: "superseded", resourceScope: `superseded:${failed._id}`,
        lastOutcome: undefined, updatedAt: Date.now() });
    }
    return result;
  },
});

export const addAnnotation = mutationOperation({
  args: {
    id: v.id("tickets"),
    expectedVersion: v.number(),
    mediaIndex: v.number(),
    kind: v.union(v.literal("point"), v.literal("time")),
    x: v.optional(v.number()),
    y: v.optional(v.number()),
    time: v.optional(v.number()),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    requireLegacyMedia();
    const { session, actor } = ctx;
    const doc = await requireWritableTicket(ctx, actor, args.id);

    const annotations = doc.annotations;
    const label = annotations.reduce((max, item) => Math.max(max, item.label), 0) + 1;
    const now = Date.now();
    const annotation = createAnnotationRecord(doc.media, args, label, crypto.randomUUID(), now);

    const { version } = await applyTicketChange(ctx, {
      doc, expectedVersion: args.expectedVersion, changes: { annotations: [...annotations, annotation] },
      action: "annotation_changed", author: { sessionId: session._id, ...actorFields(actor) }, now,
    });

    await recordAnnotationEvent(ctx, {
      ticketId: args.id,
      annotationId: annotation.id,
      action: "created",
      after: annotation,
      sessionId: session._id,
      ...actorFields(actor),
      createdAt: now,
    });

    return { annotationId: annotation.id, version };
  },
});

export const updateAnnotation = mutationOperation({
  args: {
    id: v.id("tickets"),
    expectedVersion: v.number(),
    annotationId: v.string(),
    text: v.optional(v.string()),
    x: v.optional(v.number()),
    y: v.optional(v.number()),
    time: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireLegacyMedia();
    const { session, actor } = ctx;
    const doc = await requireWritableTicket(ctx, actor, args.id);

    const index = (doc.annotations).findIndex((item) => item.id === args.annotationId);
    if (index < 0) throw new Error("COMMENT_NOT_FOUND");

    const annotations = [...doc.annotations];
    const before = annotations[index];
    const now = Date.now();
    const after = updateAnnotationRecord(before, args, now);
    annotations[index] = after;

    const { version } = await applyTicketChange(ctx, {
      doc, expectedVersion: args.expectedVersion, changes: { annotations },
      action: "annotation_changed", author: { sessionId: session._id, ...actorFields(actor) }, now,
    });
    const eventId = await recordAnnotationEvent(ctx, {
      ticketId: args.id,
      annotationId: args.annotationId,
      action: "updated",
      before,
      after,
      sessionId: session._id,
      ...actorFields(actor),
      createdAt: now,
    });
    return { eventId, version };
  },
});

export const undoAnnotationUpdate = mutationOperation({
  args: { eventId: v.id("annotationEvents"), expectedVersion: v.number() },
  handler: async (ctx, args) => {
    requireLegacyMedia();
    const { session, actor } = ctx;
    const event = await ctx.db.get(args.eventId);
    if (!event) throw new Error("TICKET_UNAVAILABLE");
    // Ownership first, for the same reason as undoTicketEdit.
    const doc = await requireWritableTicket(ctx, actor, event.ticketId);
    if (event.action !== "updated" || !event.before || !event.after) {
      throw new Error("COMMENT_UNDO_UNAVAILABLE");
    }
    const annotations = [...doc.annotations];
    const index = annotations.findIndex((annotation) => annotation.id === event.annotationId);
    if (index < 0 || annotations[index].deletedAt !== undefined) throw new Error("COMMENT_NOT_FOUND");
    if (annotations[index].updatedAt !== event.after.updatedAt) {
      throw new Error("COMMENT_UNDO_UNAVAILABLE");
    }
    const now = Date.now();
    const before = annotations[index];
    const after = { ...event.before, updatedAt: now };
    annotations[index] = after;
    await applyTicketChange(ctx, {
      doc, expectedVersion: args.expectedVersion, changes: { annotations },
      action: "annotation_changed", author: { sessionId: session._id, ...actorFields(actor) }, now,
    });
    await recordAnnotationEvent(ctx, {
      ticketId: doc._id,
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

export const removeAnnotation = mutationOperation({
  args: {
    id: v.id("tickets"),
    expectedVersion: v.number(),
    annotationId: v.string(),
  },
  handler: async (ctx, args) => {
    requireLegacyMedia();
    const { session, actor } = ctx;
    const doc = await requireWritableTicket(ctx, actor, args.id);

    const index = (doc.annotations).findIndex((item) => item.id === args.annotationId);
    if (index < 0) throw new Error("COMMENT_NOT_FOUND");

    const annotations = [...doc.annotations];
    const before = annotations[index];
    const now = Date.now();
    const after = softDeleteAnnotationRecord(before, now);
    annotations[index] = after;
    const { version } = await applyTicketChange(ctx, {
      doc, expectedVersion: args.expectedVersion, changes: { annotations },
      action: "annotation_changed", author: { sessionId: session._id, ...actorFields(actor) }, now,
    });
    await recordAnnotationEvent(ctx, {
      ticketId: args.id,
      annotationId: args.annotationId,
      action: "deleted",
      before,
      after,
      sessionId: session._id,
      ...actorFields(actor),
      createdAt: now,
    });
    return { version };
  },
});

export const restoreAnnotation = mutationOperation({
  args: {
    id: v.id("tickets"),
    expectedVersion: v.number(),
    annotationId: v.string(),
  },
  handler: async (ctx, args) => {
    requireLegacyMedia();
    const { session, actor } = ctx;
    const doc = await requireWritableTicket(ctx, actor, args.id);

    const index = (doc.annotations).findIndex((item) => item.id === args.annotationId);
    if (index < 0) throw new Error("COMMENT_NOT_FOUND");

    const annotations = [...doc.annotations];
    const before = annotations[index];
    const now = Date.now();
    const after = restoreAnnotationRecord(before, now);
    annotations[index] = after;

    const { version } = await applyTicketChange(ctx, {
      doc, expectedVersion: args.expectedVersion, changes: { annotations },
      action: "annotation_changed", author: { sessionId: session._id, ...actorFields(actor) }, now,
    });
    await recordAnnotationEvent(ctx, {
      ticketId: args.id,
      annotationId: args.annotationId,
      action: "restored",
      before,
      after,
      sessionId: session._id,
      ...actorFields(actor),
      createdAt: now,
    });
    return { version };
  },
});

