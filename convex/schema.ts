import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const feedbackStatus = v.union(
  v.literal("new"),
  v.literal("acknowledged"),
  v.literal("in_progress"),
  v.literal("waiting"),
  v.literal("done"),
);

// Sessions created before the customer portal have no role; readers treat a
// missing role as staff so legacy sessions keep full workspace access.
export const actorRole = v.union(v.literal("staff"), v.literal("customer"));

export const mediaItemValidator = v.object({
  key: v.string(),
  name: v.string(),
  size: v.number(),
  type: v.string(),
  url: v.string(),
});

export const pendingFileValidator = v.object({
  name: v.string(),
  size: v.number(),
  type: v.string(),
});

export const annotationValidator = v.object({
  id: v.string(),
  label: v.number(),
  mediaIndex: v.number(),
  // "pin" is retained for records created by the earlier annotation model.
  kind: v.union(v.literal("pin"), v.literal("point"), v.literal("time")),
  x: v.optional(v.number()),
  y: v.optional(v.number()),
  time: v.optional(v.number()),
  text: v.string(),
  createdAt: v.number(),
  updatedAt: v.optional(v.number()),
  deletedAt: v.optional(v.number()),
});

export const annotationCreateInputValidator = v.object({
  mediaIndex: v.number(),
  kind: v.union(v.literal("point"), v.literal("time")),
  x: v.optional(v.number()),
  y: v.optional(v.number()),
  time: v.optional(v.number()),
  text: v.string(),
});

export const annotationEventAction = v.union(
  v.literal("created"),
  v.literal("updated"),
  v.literal("deleted"),
  v.literal("restored"),
  v.literal("update_undone"),
);

export const feedbackEventAction = v.union(
  v.literal("created"),
  v.literal("edited"),
  v.literal("edit_undone"),
  v.literal("status_changed"),
  v.literal("status_undone"),
  v.literal("archived"),
  v.literal("restored"),
);

export const feedbackStateValidator = v.object({
  title: v.string(),
  description: v.string(),
  status: feedbackStatus,
  version: v.number(),
  deletedAt: v.optional(v.number()),
});

/**
 * How a ticket entered the system when it did not come from the browser UI.
 * Absent means the browser UI, so every ticket created before agent creation
 * existed keeps its meaning without a migration.
 */
export const ticketCreatedVia = v.literal("codex");

export const uploadIntentStatus = v.union(
  v.literal("pending"),
  v.literal("attached"),
  v.literal("cancelled"),
  v.literal("cleaned"),
);

export default defineSchema({
  feedback: defineTable({
    title: v.string(),
    description: v.string(),
    status: feedbackStatus,
    ticketNumber: v.optional(v.number()),
    media: v.array(mediaItemValidator),
    annotations: v.optional(v.array(annotationValidator)),
    version: v.optional(v.number()),
    deletedAt: v.optional(v.number()),
    // Tickets created before the customer portal have no owner and stay staff-only.
    ownerCustomerId: v.optional(v.id("customers")),
    origin: v.optional(actorRole),
    createdVia: v.optional(ticketCreatedVia),
    // Idempotency key supplied by a non-browser caller (the ticket CLI). Unset
    // for UI tickets, so at most one ticket exists per external request id.
    externalRequestId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_created_at", ["createdAt"])
    .index("by_deleted_at", ["deletedAt"])
    .index("by_ticket_number", ["ticketNumber"])
    .index("by_external_request", ["externalRequestId"])
    .index("by_owner", ["ownerCustomerId", "createdAt"]),
  customers: defineTable({
    email: v.string(),
    passwordAlgorithm: v.string(),
    passwordSalt: v.string(),
    passwordHash: v.string(),
    passwordIterations: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_email", ["email"]),
  ticketCounters: defineTable({
    name: v.string(),
    nextNumber: v.number(),
    updatedAt: v.number(),
  }).index("by_name", ["name"]),
  feedbackEvents: defineTable({
    feedbackId: v.id("feedback"),
    action: feedbackEventAction,
    before: v.optional(feedbackStateValidator),
    after: v.optional(feedbackStateValidator),
    sessionId: v.id("sessions"),
    createdVia: v.optional(ticketCreatedVia),
    actorRole: v.optional(actorRole),
    actorCustomerId: v.optional(v.id("customers")),
    sourceEventId: v.optional(v.id("feedbackEvents")),
    createdAt: v.number(),
  })
    .index("by_feedback", ["feedbackId", "createdAt"]),
  annotationEvents: defineTable({
    feedbackId: v.id("feedback"),
    annotationId: v.string(),
    action: annotationEventAction,
    before: v.optional(annotationValidator),
    after: v.optional(annotationValidator),
    sessionId: v.id("sessions"),
    actorRole: v.optional(actorRole),
    actorCustomerId: v.optional(v.id("customers")),
    createdAt: v.number(),
  })
    .index("by_feedback", ["feedbackId", "createdAt"])
    .index("by_annotation", ["feedbackId", "annotationId", "createdAt"]),
  sessions: defineTable({
    token: v.string(),
    clientId: v.optional(v.string()),
    role: v.optional(actorRole),
    customerId: v.optional(v.id("customers")),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_token", ["token"])
    .index("by_expires_at", ["expiresAt"]),
  loginAttempts: defineTable({
    clientId: v.string(),
    attempts: v.number(),
    firstAttemptAt: v.number(),
    lockedUntil: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_client_id", ["clientId"]),
  uploadIntents: defineTable({
    sessionId: v.id("sessions"),
    secret: v.string(),
    idempotencyKey: v.string(),
    expectedFiles: v.array(pendingFileValidator),
    uploadedFiles: v.array(mediaItemValidator),
    status: uploadIntentStatus,
    feedbackId: v.optional(v.id("feedback")),
    actorRole: v.optional(actorRole),
    actorCustomerId: v.optional(v.id("customers")),
    createdAt: v.number(),
    expiresAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_session", ["sessionId", "createdAt"])
    .index("by_idempotency", ["sessionId", "idempotencyKey"])
    .index("by_expires_at", ["status", "expiresAt"]),
});
