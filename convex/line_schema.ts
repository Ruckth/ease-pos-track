import { defineTable } from "convex/server";
import { v } from "convex/values";

export const locale = v.union(v.literal("th"), v.literal("en"));
export const kind = v.union(v.literal("group"), v.literal("room"), v.literal("user"));
export const notify = v.union(v.literal("off"), v.literal("own"), v.literal("all"));
export const botInfo = {
  lineUserId: v.string(), basicId: v.string(), displayName: v.string(), pictureUrl: v.optional(v.string()),
};
export const inbound = {
  webhookEventId: v.string(),
  type: v.union(v.literal("join"), v.literal("leave"), v.literal("follow"), v.literal("unfollow"),
    v.literal("memberJoined"), v.literal("memberLeft")),
  kind, lineChatId: v.string(), timestamp: v.number(),
  payload: v.object({ replyToken: v.optional(v.string()) }),
};
export const lineAiFileType = v.union(v.literal("image"), v.literal("video"), v.literal("file"));
export const lineAiFileRef = v.object({
  messageId: v.string(),
  type: lineAiFileType,
});
export const lineAiIntakeState = v.union(
  v.literal("pending"),
  v.literal("processing"),
  v.literal("draft"),
  v.literal("ignored"),
  v.literal("failed"),
  v.literal("acted"),
);
export const lineAiEventOutcome = v.union(
  v.literal("created"),
  v.literal("file_attached"),
  v.literal("unsent"),
  v.literal("unsend_fenced"),
);

export const lineTables = {
  lineBots: defineTable({
    projectId: v.id("projects"), name: v.string(), locale, ...botInfo,
    webhookSlug: v.string(), secretCipher: v.string(), tokenCipher: v.string(),
    secretHint: v.string(), tokenHint: v.string(),
    state: v.union(v.literal("active"), v.literal("disabled"), v.literal("setup")),
    allowDirectChats: v.boolean(), lastWebhookAt: v.optional(v.number()), signatureFailures: v.number(),
    lastError: v.optional(v.string()), createdAt: v.number(), updatedAt: v.number(),
    endpointLease: v.optional(v.number()),
    pendingSecretCipher: v.optional(v.string()),
    assistantRevision: v.optional(v.number()), webhookActive: v.optional(v.boolean()),
  }).index("by_slug", ["webhookSlug"])
    .index("by_project", ["projectId"]).index("by_line_user", ["lineUserId"]),
  lineChats: defineTable({
    botId: v.id("lineBots"), projectId: v.id("projects"), kind, lineChatId: v.string(), name: v.string(),
    displayNameOverride: v.optional(v.string()), pictureUrl: v.optional(v.string()), memberCount: v.optional(v.number()),
    state: v.union(v.literal("pending"), v.literal("active"), v.literal("muted"), v.literal("left"), v.literal("rejected")),
    ownerCustomerId: v.optional(v.id("customers")), notify, allowCreate: v.boolean(),
    // Explicit per-chat opt-in for AI Ticket intake; absent/false disables intake.
    assistantEnabled: v.optional(v.boolean()),
    assistantEnabledAt: v.optional(v.number()), assistantRevision: v.optional(v.number()),
    assistantOptIn: v.optional(v.object({ botRevision: v.number(), projectVisibilityVersion: v.number() })),
    approvedAt: v.optional(v.number()), approvedBy: v.optional(v.id("staff")),
    joinedAt: v.number(), leftAt: v.optional(v.number()), lastEventAt: v.number(),
    lastMembershipAt: v.optional(v.number()),
  }).index("by_bot_chat", ["botId", "lineChatId"]),
  lineInboundEvents: defineTable({
    botId: v.id("lineBots"), ...inbound,
    state: v.union(v.literal("pending"), v.literal("done"), v.literal("ignored"), v.literal("failed")),
    attempt: v.number(), leaseId: v.optional(v.string()), leaseExpiresAt: v.optional(v.number()),
    error: v.optional(v.string()), createdAt: v.number(), updatedAt: v.number(),
  }).index("by_bot_event", ["botId", "webhookEventId"])
    .index("by_chat_type_timestamp", ["botId", "lineChatId", "type", "timestamp"]),
  lineAiIntakes: defineTable({
    projectId: v.id("projects"),
    botId: v.id("lineBots"),
    chatId: v.id("lineChats"),
    joinedAt: v.number(),
    chatRevision: v.number(), botRevision: v.number(),
    connectionRevision: v.number(), projectVisibilityVersion: v.number(),
    kind,
    webhookEventId: v.string(),
    messageId: v.string(),
    senderDigest: v.string(),
    text: v.string(),
    files: v.array(lineAiFileRef),
    state: lineAiIntakeState,
    messageTimestamp: v.number(),
    windowEndsAt: v.number(),
    expiresAt: v.number(),
    availableAt: v.number(),
    attempt: v.number(),
    leaseId: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    error: v.optional(v.string()),
    unsentAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_bot_message", ["botId", "messageId"])
    .index("by_project_state", ["projectId", "state"])
    .index("by_chat_sender_window", ["chatId", "joinedAt", "senderDigest", "messageTimestamp"])
    .index("by_state_available", ["state", "availableAt"])
    .index("by_state_lease", ["state", "leaseExpiresAt"])
    .index("by_expires_at", ["expiresAt"]),
  // Bounded secondary lookup for O(1) file message dedup and pre-approval unsend removal.
  lineAiIntakeFiles: defineTable({
    botId: v.id("lineBots"),
    messageId: v.string(),
    intakeId: v.id("lineAiIntakes"),
    chatId: v.id("lineChats"),
    joinedAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_bot_message", ["botId", "messageId"])
    .index("by_intake", ["intakeId"])
    .index("by_expires_at", ["expiresAt"]),
  // Short-lived references for reconciling file webhooks with delayed text triggers.
  lineAiRecentFiles: defineTable({
    botId: v.id("lineBots"),
    chatId: v.id("lineChats"),
    joinedAt: v.number(),
    senderDigest: v.string(),
    chatRevision: v.number(), botRevision: v.number(),
    connectionRevision: v.number(), projectVisibilityVersion: v.number(),
    messageId: v.string(),
    webhookEventId: v.string(),
    type: lineAiFileType,
    messageTimestamp: v.number(),
    expiresAt: v.number(),
  })
    .index("by_bot_message", ["botId", "messageId"])
    .index("by_bot_event", ["botId", "webhookEventId"])
    .index("by_scope_expiry", ["botId", "chatId", "joinedAt", "senderDigest", "chatRevision",
      "botRevision", "connectionRevision", "projectVisibilityVersion", "expiresAt"])
    .index("by_expires_at", ["expiresAt"]),
  // Stable per-bot webhookEventId dedup for accepted AI intake/unsend events.
  lineAiEvents: defineTable({
    botId: v.id("lineBots"),
    webhookEventId: v.string(),
    messageId: v.string(),
    outcome: lineAiEventOutcome,
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_bot_event", ["botId", "webhookEventId"])
    .index("by_expires_at", ["expiresAt"]),
  // Bounded unsend fences blocking out-of-order delivery and redelivery resurrection.
  lineAiUnsends: defineTable({
    botId: v.id("lineBots"),
    lineChatId: v.string(),
    messageId: v.string(),
    webhookEventId: v.string(),
    unsentAt: v.number(),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_bot_chat_message", ["botId", "lineChatId", "messageId"])
    .index("by_expires_at", ["expiresAt"]),
};
