import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const ticketStatus = v.union(
  v.literal("new"),
  v.literal("acknowledged"),
  v.literal("in_progress"),
  v.literal("waiting"),
  v.literal("done"),
);

export const mediaJobKind = v.union(v.literal("cancellation"), v.literal("intent_expiry"), v.literal("rejected_upload"), v.literal("ticket_purge"));
export const mediaJobState = v.union(v.literal("pending"), v.literal("running"), v.literal("completed"), v.literal("failed"), v.literal("superseded"));

const ticketLifecycle = v.union(v.literal("active"), v.literal("archived"), v.literal("purging"));

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

const annotationValidator = v.object({
  id: v.string(),
  label: v.number(),
  mediaIndex: v.number(),
  kind: v.union(v.literal("point"), v.literal("time")),
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

const annotationEventAction = v.union(
  v.literal("created"),
  v.literal("updated"),
  v.literal("deleted"),
  v.literal("restored"),
  v.literal("update_undone"),
);

const ticketEventAction = v.union(
  v.literal("created"),
  v.literal("media_attached"),
  v.literal("edited"),
  v.literal("edit_undone"),
  v.literal("urgency_changed"),
  v.literal("urgency_undone"),
  v.literal("status_changed"),
  v.literal("status_undone"),
  v.literal("archived"),
  v.literal("restored"),
  v.literal("annotation_changed"),
  v.literal("purge_claimed"),
);

const ticketStateValidator = v.object({
  title: v.string(),
  description: v.string(),
  status: ticketStatus,
  urgencyScore: v.optional(v.number()),
  version: v.number(),
  mediaCount: v.number(),
  annotationCount: v.number(),
  lifecycle: ticketLifecycle,
  archivedAt: v.optional(v.number()),
});

const ticketCreatedVia = v.literal("codex");

const uploadIntentStatus = v.union(
  v.literal("pending"),
  v.literal("expiring"),
  v.literal("attached"),
  v.literal("cancelled"),
  v.literal("cleaned"),
);

const pageManifestEntry = v.object({ path: v.string(), size: v.number(), sha256: v.string() });

export default defineSchema({
  projects: defineTable({
    name: v.string(),
    // Immutable once created: it prefixes every Ticket reference in the Project.
    key: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
    archivedAt: v.optional(v.number()),
  }).index("by_key", ["key"]),
  // Which customers may see and create Tickets in a Project. Staff need no row.
  projectMembers: defineTable({
    projectId: v.id("projects"),
    customerId: v.id("customers"),
    createdAt: v.number(),
  })
    .index("by_project", ["projectId", "customerId"])
    .index("by_customer", ["customerId"]),
  tickets: defineTable({
    projectId: v.id("projects"),
    projectKey: v.string(),
    title: v.string(),
    description: v.string(),
    searchText: v.string(),
    status: ticketStatus,
    urgencyScore: v.optional(v.number()),
    ticketNumber: v.number(),
    media: v.array(mediaItemValidator),
    annotations: v.array(annotationValidator),
    version: v.number(),
    lifecycle: ticketLifecycle,
    archivedAt: v.optional(v.number()),
    purgeBlocked: v.optional(v.boolean()),
    ownerCustomerId: v.optional(v.id("customers")),
    origin: actorRole,
    createdVia: v.optional(ticketCreatedVia),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_lifecycle_archive", ["lifecycle", "purgeBlocked", "archivedAt"])
    .index("by_project_lane", ["projectId", "lifecycle", "status", "ticketNumber"])
    .index("by_owner_project", ["ownerCustomerId", "projectId", "lifecycle", "ticketNumber"])
    .index("by_project_ticket", ["projectKey", "ticketNumber"])
    .index("by_project_lifecycle", ["projectId", "lifecycle", "ticketNumber"])
    .searchIndex("search_text", { searchField: "searchText", filterFields: ["projectId", "ownerCustomerId", "lifecycle", "status"] }),
  customers: defineTable({
    email: v.string(),
    passwordAlgorithm: v.string(),
    passwordSalt: v.string(),
    passwordHash: v.string(),
    passwordIterations: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_email", ["email"]),
  ticketTotals: defineTable({
    projectId: v.id("projects"),
    status: ticketStatus,
    count: v.number(),
  }).index("by_project_status", ["projectId", "status"]),
  ticketCounters: defineTable({
    name: v.string(),
    nextNumber: v.number(),
    updatedAt: v.number(),
  }).index("by_name", ["name"]),
  ticketEvents: defineTable({
    ticketId: v.id("tickets"),
    action: ticketEventAction,
    before: v.optional(ticketStateValidator),
    after: v.optional(ticketStateValidator),
    sessionId: v.id("sessions"),
    createdVia: v.optional(ticketCreatedVia),
    actorRole: actorRole,
    actorCustomerId: v.optional(v.id("customers")),
    sourceEventId: v.optional(v.id("ticketEvents")),
    createdAt: v.number(),
  })
    .index("by_ticket", ["ticketId", "createdAt"]),
  annotationEvents: defineTable({
    ticketId: v.id("tickets"),
    annotationId: v.string(),
    action: annotationEventAction,
    before: v.optional(annotationValidator),
    after: v.optional(annotationValidator),
    sessionId: v.id("sessions"),
    actorRole: actorRole,
    actorCustomerId: v.optional(v.id("customers")),
    createdAt: v.number(),
  })
    .index("by_ticket", ["ticketId", "createdAt"])
    .index("by_annotation", ["ticketId", "annotationId", "createdAt"]),
  sessions: defineTable(v.union(
    v.object({ token: v.string(), clientId: v.optional(v.string()), role: v.literal("staff"), createdAt: v.number(), expiresAt: v.number() }),
    v.object({ token: v.string(), clientId: v.optional(v.string()), role: v.literal("customer"), customerId: v.id("customers"), createdAt: v.number(), expiresAt: v.number() }),
  ))
    .index("by_token", ["token"])
    .index("by_expires_at", ["expiresAt"]),
  loginAttempts: defineTable({
    clientId: v.string(),
    attempts: v.number(),
    firstAttemptAt: v.number(),
    lockedUntil: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_client_id", ["clientId"]),
  ticketRequests: defineTable({
    operation: v.string(),
    requestId: v.string(),
    actorRole,
    actorCustomerId: v.optional(v.id("customers")),
    projectId: v.id("projects"),
    digestVersion: v.number(),
    inputDigest: v.string(),
    outcome: v.union(v.literal("committed"), v.literal("unavailable")),
    ticketId: v.optional(v.id("tickets")),
    jobId: v.optional(v.id("mediaJobs")),
    eventId: v.optional(v.id("ticketEvents")),
    version: v.number(),
    createdAt: v.number(),
  }).index("by_operation_request", ["operation", "requestId"])
    .index("by_ticket", ["ticketId"]),
  mediaAssets: defineTable({
    key: v.string(),
    source: v.union(v.literal("callback"), v.literal("staff")),
    intentId: v.id("uploadIntents"),
    ticketId: v.optional(v.id("tickets")),
    metadata: mediaItemValidator,
    lifecycle: v.union(v.literal("pending"), v.literal("attached"), v.literal("deleting"), v.literal("deleted")),
    jobId: v.optional(v.id("mediaJobs")),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_key", ["key"])
    .index("by_intent", ["intentId", "lifecycle"])
    .index("by_ticket", ["ticketId", "lifecycle"]),
  mediaJobs: defineTable({
    kind: mediaJobKind,
    resourceScope: v.string(),
    intentId: v.optional(v.id("uploadIntents")),
    ticketId: v.optional(v.id("tickets")),
    keys: v.array(v.string()),
    completedKeys: v.array(v.string()),
    phase: v.union(v.literal("delete_media"), v.literal("delete_ticket"), v.literal("delete_events"), v.literal("complete")),
    state: mediaJobState,
    attempt: v.number(),
    maxAttempts: v.number(),
    leaseId: v.optional(v.string()),
    leaseStartedAt: v.optional(v.number()),
    leaseExpiresAt: v.optional(v.number()),
    availableAt: v.number(),
    lastOutcome: v.optional(v.union(v.literal("deleted"), v.literal("absent_verified"), v.literal("failed_retryable"), v.literal("failed_permanent"), v.literal("unknown"), v.literal("not_configured"), v.literal("ownership_unverified"), v.literal("ownership_conflict"))),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_scope", ["resourceScope", "state"])
    .index("by_available", ["state", "availableAt"])
    .index("by_lease", ["state", "leaseExpiresAt"])
    .index("by_kind_state", ["kind", "state", "createdAt"])
    .index("by_state_created", ["state", "createdAt"]),
  mediaJobCounters: defineTable({
    key: v.string(),
    count: v.number(),
  }).index("by_key", ["key"]),
  // A hosted page published from a Ticket. Bytes live in Convex File Storage;
  // `files` is the durable ownership record of every blob this row staged.
  ticketPages: defineTable({
    ticketId: v.id("tickets"),
    projectId: v.id("projects"),
    requestId: v.string(),
    actorRole,
    actorCustomerId: v.optional(v.id("customers")),
    sessionId: v.id("sessions"),
    inputDigest: v.string(),
    entryPath: v.string(),
    manifest: v.array(pageManifestEntry),
    files: v.array(v.object({ path: v.string(), size: v.number(), sha256: v.string(), contentType: v.string(), storageId: v.id("_storage") })),
    // Blobs recorded after the row stopped staging, or duplicates of a staged path.
    discarded: v.array(v.id("_storage")),
    totalBytes: v.number(),
    state: v.union(v.literal("staging"), v.literal("published"), v.literal("revoked"), v.literal("abandoned")),
    shareKey: v.optional(v.string()),
    expiresAt: v.number(),
    // Set while blobs await the gated reclaim sweep.
    reclaimAfter: v.optional(v.number()),
    publishedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_request", ["requestId"])
    .index("by_share_key", ["shareKey"])
    .index("by_ticket", ["ticketId", "state", "createdAt"])
    .index("by_state_expires", ["state", "expiresAt"])
    .index("by_reclaim", ["reclaimAfter"]),
  uploadIntents: defineTable({
    sessionId: v.id("sessions"),
    secret: v.string(),
    idempotencyKey: v.string(),
    expectedFiles: v.array(pendingFileValidator),
    uploadedFiles: v.array(mediaItemValidator),
    status: uploadIntentStatus,
    ticketId: v.optional(v.id("tickets")),
    actorRole: actorRole,
    actorCustomerId: v.optional(v.id("customers")),
    createdAt: v.number(),
    expiresAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_session", ["sessionId", "createdAt"])
    .index("by_idempotency", ["actorRole", "actorCustomerId", "idempotencyKey"])
    .index("by_expires_at", ["status", "expiresAt"]),
});
