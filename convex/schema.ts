import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { T3_DOCTOR_AUDIENCE } from "../shared/t3-doctor";
import { assignment, classification, routingTables } from "./routing_schema";

export const tagColor = v.union(v.literal("slate"), v.literal("red"), v.literal("orange"), v.literal("green"), v.literal("blue"), v.literal("violet"));

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
export const staffRole = v.union(v.literal("owner"), v.literal("staff"));
export const principalStatus = v.union(v.literal("active"), v.literal("disabled"));
const invitationStatus = v.union(v.literal("pending"), v.literal("redeemed"), v.literal("revoked"));

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
  v.literal("tags_changed"),
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
  tagIds: v.optional(v.array(v.id("ticketTags"))),
});

const ticketCreatedVia = v.literal("codex");

const uploadIntentStatus = v.union(
  v.literal("pending"),
  v.literal("expiring"),
  v.literal("attached"),
  v.literal("cancelled"),
  v.literal("cleaned"),
);

// Historical attribution and outstanding media reservations keep their original session reference.
const sessionReference = v.union(v.id("sessionAdmissions"), v.id("sessions"));

export default defineSchema({
  projectIntakeStaff: defineTable({
    projectId: v.id("projects"), staffId: v.string(),
  }).index("by_project_staff", ["projectId", "staffId"]),
  // Each category change advances its generation; items from an earlier generation stay hidden.
  staffInboxPreferences: defineTable({
    projectId: v.id("projects"), staffId: v.string(), intake: v.boolean(), assignment: v.boolean(),
    intakeGeneration: v.optional(v.number()), assignmentGeneration: v.optional(v.number()),
  }).index("by_project_staff", ["projectId", "staffId"]),
  staffInbox: defineTable({
    projectId: v.id("projects"), staffId: v.string(), ticketId: v.id("tickets"),
    category: v.union(v.literal("intake"), v.literal("assignment")),
    assignmentEventId: v.optional(v.id("ticketAssignmentEvents")),
    intakeMembership: v.optional(v.id("projectIntakeStaff")), readAt: v.optional(v.number()),
    projectVisibilityVersion: v.optional(v.number()), visibilityVersion: v.number(),
    // Pilot epoch and preference generation at insertion; absent outside a pilot or before generations.
    pilotEpoch: v.optional(v.string()), preferenceGeneration: v.optional(v.number()),
  }).index("by_recipient", ["projectId", "staffId"]),
  customerInbox: defineTable({
    customerId: v.id("customers"), memberId: v.id("projectMembers"),
    projectId: v.id("projects"), ticketId: v.id("tickets"), eventId: v.id("ticketEvents"),
    projectVisibilityVersion: v.optional(v.number()), visibilityVersion: v.number(), status: ticketStatus,
    restored: v.boolean(), readAt: v.optional(v.number()),
    pilotEpoch: v.optional(v.string()), preferenceGeneration: v.optional(v.number()),
  }).index("by_member", ["memberId"]),
  t3DoctorKeys: defineTable({
    selector: v.string(),
    digest: v.string(),
    epochTag: v.string(),
    audience: v.literal(T3_DOCTOR_AUDIENCE),
    deployment: v.string(),
    staffId: v.string(),
    generation: v.number(),
    projectId: v.id("projects"),
    hostId: v.string(),
    machineLabel: v.string(),
    releaseId: v.string(),
    combinationId: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    revokedAt: v.optional(v.number()),
    revokedBy: v.optional(v.string()),
    replacedKeyId: v.optional(v.id("t3DoctorKeys")),
  }).index("by_selector", ["selector"])
    .index("by_staff_created", ["staffId", "createdAt"])
    .index("by_staff_active", ["staffId", "generation", "epochTag", "revokedAt", "expiresAt"]),

  ...routingTables,
  ticketTags: defineTable({
    name: v.string(), normalizedName: v.string(), color: tagColor,
    createdBy: sessionReference, createdAt: v.number(),
  }).index("by_normalized_name", ["normalizedName"]),
  projects: defineTable({
    name: v.string(),
    inboxVisibilityVersion: v.optional(v.number()),
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
    statusInboxEnabled: v.optional(v.boolean()),
    statusInboxGeneration: v.optional(v.number()),
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
    assignment: v.optional(assignment),
    assigneeStaffId: v.optional(v.string()),
    // The assignment event that began the current assignee's interval.
    assigneeEventId: v.optional(v.id("ticketAssignmentEvents")),
    routingClassification: v.optional(classification),
    tagIds: v.optional(v.array(v.id("ticketTags"))),
    ticketNumber: v.number(),
    media: v.array(mediaItemValidator),
    annotations: v.array(annotationValidator),
    version: v.number(),
    lifecycle: ticketLifecycle,
    archivedAt: v.optional(v.number()),
    purgeBlocked: v.optional(v.boolean()),
    inboxVisibilityVersion: v.optional(v.number()),
    ownerCustomerId: v.optional(v.id("customers")),
    origin: actorRole,
    createdVia: v.optional(ticketCreatedVia),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_lifecycle_archive", ["lifecycle", "purgeBlocked", "archivedAt"])
    .index("by_project_assignee_lane", ["projectId", "lifecycle", "assigneeStaffId", "status", "ticketNumber"])
    .index("by_project_assignee", ["projectId", "lifecycle", "assigneeStaffId", "ticketNumber"])
    .index("by_project_number", ["projectId", "ticketNumber"])
    .index("by_project_lane", ["projectId", "lifecycle", "status", "ticketNumber"])
    .index("by_owner_project", ["ownerCustomerId", "projectId", "lifecycle", "ticketNumber"])
    .index("by_project_ticket", ["projectKey", "ticketNumber"])
    .index("by_project_lifecycle", ["projectId", "lifecycle", "ticketNumber"])
    .searchIndex("search_text", { searchField: "searchText", filterFields: ["projectId", "ownerCustomerId", "lifecycle", "status", "assigneeStaffId"] }),
  // The Convex Auth user (the core's opaque userId). Exactly one principal kind:
  // a pending Google identity has no workspace access until it is bound.
  users: defineTable({
    kind: v.union(v.literal("pending"), v.literal("staff"), v.literal("customer"), v.literal("revoked")),
    staffId: v.optional(v.id("staff")),
    customerId: v.optional(v.id("customers")),
    googleSubject: v.optional(v.string()),
    googleEmail: v.optional(v.string()),
    googleEmailVerified: v.optional(v.boolean()),
    googleName: v.optional(v.string()),
    googleVerifiedAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_google_subject", ["googleSubject"]),
  staff: defineTable({
    userId: v.id("users"),
    googleSubject: v.string(),
    email: v.string(),
    name: v.string(),
    role: staffRole,
    status: principalStatus,
    // Disable, replacement and re-enable advance the generation and validAfter.
    generation: v.number(),
    validAfter: v.number(),
    // Named pilot epoch this principal was enrolled or reconciled into.
    pilotEpoch: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_user", ["userId"])
    .index("by_email", ["email"])
    .index("by_status_role", ["status", "role"]),
  customers: defineTable({
    userId: v.id("users"),
    // Normalized lowercase ASCII; the username component stores the same value.
    username: v.string(),
    displayName: v.string(),
    status: principalStatus,
    generation: v.number(),
    validAfter: v.number(),
    pilotEpoch: v.optional(v.string()),
    // Saved recovery code digest, bound to customerId and generation.
    recoveryCodeDigest: v.optional(v.string()),
    recoveryCodeCreatedAt: v.optional(v.number()),
    credentialEpoch: v.optional(v.string()),
    recoveryEnrollmentRequired: v.optional(v.boolean()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_user", ["userId"])
    .index("by_username", ["username"]),
  pilotRelease: defineTable({
    ticketDisposalDeadline: v.optional(v.number()),
    // Written by earlier builds; expiry now requires the approved periods in `retention`.
    identityRetentionApproved: v.optional(v.boolean()),
    retention: v.optional(v.object({
      challengeHours: v.number(), invitationDays: v.number(), attemptDays: v.number(), auditDays: v.number(), inboxDays: v.number(),
    })),
    epoch: v.string(),
    manifestDigest: v.string(),
    previousEpoch: v.optional(v.string()),
    deploymentOrigin: v.string(),
    projectIds: v.array(v.id("projects")),
  }),
  customerRestoreCases: defineTable({
    epoch: v.string(),
    requestId: v.string(),
    customerId: v.id("customers"),
    userId: v.id("users"),
    generation: v.number(),
    evidenceRef: v.string(),
    verifierId: v.string(),
    reviewerId: v.optional(v.string()),
    expiresAt: v.number(),
    approvedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
  }).index("by_epoch_request", ["epoch", "requestId"])
    .index("by_epoch_customer", ["epoch", "customerId", "expiresAt"]),
  // Only a verified sign-in completion inserts a row, in the same mutation that
  // minted the Convex Auth session. Protected handlers require a live match.
  sessionAdmissions: defineTable({
    authSessionId: v.string(),
    userId: v.id("users"),
    principal: v.union(v.literal("pending"), v.literal("staff"), v.literal("customer")),
    staffId: v.optional(v.id("staff")),
    customerId: v.optional(v.id("customers")),
    generation: v.number(),
    method: v.union(v.literal("google"), v.literal("password")),
    // Named pilot epoch the session was admitted under; absent outside a pilot.
    pilotEpoch: v.optional(v.string()),
    createdAt: v.number(),
    revokedAt: v.optional(v.number()),
  }).index("by_auth_session", ["authSessionId"])
    .index("by_user", ["userId", "createdAt"]),
  googleFlows: defineTable({
    stateDigest: v.string(),
    startedAt: v.number(),
    consumedAt: v.optional(v.number()),
    pilotEpoch: v.optional(v.string()),
  }).index("by_state", ["stateDigest"])
    .index("by_started", ["startedAt"]),
  staffInvitations: defineTable({
    email: v.string(),
    role: staffRole,
    secretDigest: v.string(),
    status: invitationStatus,
    expiresAt: v.number(),
    createdByStaffId: v.id("staff"),
    redeemedByStaffId: v.optional(v.id("staff")),
    pilotEpoch: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_secret", ["secretDigest"])
    .index("by_status", ["status", "createdAt"])
    .index("by_expiry", ["expiresAt"]),
  projectInvitations: defineTable({
    eligibilityConfirmed: v.optional(v.literal(true)),
    projectId: v.id("projects"),
    secretDigest: v.string(),
    status: invitationStatus,
    expiresAt: v.number(),
    createdByStaffId: v.id("staff"),
    redeemedByCustomerId: v.optional(v.id("customers")),
    pilotEpoch: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_secret", ["secretDigest"])
    .index("by_project", ["projectId", "status", "createdAt"])
    .index("by_expiry", ["expiresAt"]),
  // Fresh single-use proof for sensitive actions and staff mailbox confirmation.
  identityChallenges: defineTable({
    admissionId: v.id("sessionAdmissions"),
    purpose: v.string(),
    intentDigest: v.string(),
    codeDigest: v.string(),
    failedAttempts: v.number(),
    expiresAt: v.number(),
    consumedAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_admission", ["admissionId", "purpose", "createdAt"])
    .index("by_created", ["createdAt"]),
  // Local test identity sender only; refused outside the disposable backend.
  identityOutbox: defineTable({
    to: v.string(),
    purpose: v.string(),
    code: v.string(),
    createdAt: v.number(),
  }).index("by_to", ["to", "createdAt"]),
  identityAudit: defineTable({
    action: v.string(),
    actorStaffId: v.optional(v.id("staff")),
    staffId: v.optional(v.id("staff")),
    customerId: v.optional(v.id("customers")),
    detail: v.optional(v.string()),
    restoreCaseId: v.optional(v.id("customerRestoreCases")),
    previousUserId: v.optional(v.id("users")),
    replacementUserId: v.optional(v.id("users")),
    createdAt: v.number(),
  }).index("by_created", ["createdAt"]),
  // Attempt budgets for recovery, invitations and action proof.
  identityAttempts: defineTable({
    key: v.string(),
    attempts: v.number(),
    firstAttemptAt: v.number(),
    lockedUntil: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_key", ["key"]).index("by_updated", ["updatedAt"]),
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
  ticketMessages: defineTable({
    ticketId: v.id("tickets"),
    role: actorRole,
    authorSessionId: sessionReference,
    staffId: v.optional(v.id("staff")),
    customerId: v.optional(v.id("customers")),
    body: v.string(),
    requestId: v.string(),
    inReplyTo: v.optional(v.id("ticketMessages")),
  }).index("by_ticket", ["ticketId"])
    .index("by_ticket_request", ["ticketId", "requestId"]),
  ticketEvents: defineTable({
    ticketId: v.id("tickets"),
    action: ticketEventAction,
    before: v.optional(ticketStateValidator),
    after: v.optional(ticketStateValidator),
    sessionId: sessionReference,
    createdVia: v.optional(ticketCreatedVia),
    actorRole: actorRole,
    actorCustomerId: v.optional(v.id("customers")),
    actorStaffId: v.optional(v.id("staff")),
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
    sessionId: sessionReference,
    actorRole: actorRole,
    actorCustomerId: v.optional(v.id("customers")),
    actorStaffId: v.optional(v.id("staff")),
    createdAt: v.number(),
  })
    .index("by_ticket", ["ticketId", "createdAt"])
    .index("by_annotation", ["ticketId", "annotationId", "createdAt"]),
  ticketRequests: defineTable({
    operation: v.string(),
    requestId: v.string(),
    actorRole,
    actorCustomerId: v.optional(v.id("customers")),
    actorStaffId: v.optional(v.id("staff")),
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
  uploadIntents: defineTable({
    sessionId: sessionReference,
    secret: v.string(),
    idempotencyKey: v.string(),
    expectedFiles: v.array(pendingFileValidator),
    uploadedFiles: v.array(mediaItemValidator),
    status: uploadIntentStatus,
    ticketId: v.optional(v.id("tickets")),
    actorRole: actorRole,
    actorCustomerId: v.optional(v.id("customers")),
    actorStaffId: v.optional(v.id("staff")),
    createdAt: v.number(),
    expiresAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_session", ["sessionId", "createdAt"])
    .index("by_idempotency", ["actorRole", "actorCustomerId", "actorStaffId", "idempotencyKey"])
    .index("by_expires_at", ["status", "expiresAt"]),
});
