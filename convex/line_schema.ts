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
  }).index("by_slug", ["webhookSlug"])
    .index("by_project", ["projectId"]).index("by_line_user", ["lineUserId"]),
  lineChats: defineTable({
    botId: v.id("lineBots"), projectId: v.id("projects"), kind, lineChatId: v.string(), name: v.string(),
    displayNameOverride: v.optional(v.string()), pictureUrl: v.optional(v.string()), memberCount: v.optional(v.number()),
    state: v.union(v.literal("pending"), v.literal("active"), v.literal("muted"), v.literal("left"), v.literal("rejected")),
    ownerCustomerId: v.optional(v.id("customers")), notify, allowCreate: v.boolean(),
    approvedAt: v.optional(v.number()), approvedBy: v.optional(v.id("staff")),
    joinedAt: v.number(), leftAt: v.optional(v.number()), lastEventAt: v.number(),
    lastMembershipAt: v.optional(v.number()),
  }).index("by_bot_chat", ["botId", "lineChatId"]),
  lineInboundEvents: defineTable({
    botId: v.id("lineBots"), ...inbound,
    state: v.union(v.literal("pending"), v.literal("done"), v.literal("ignored"), v.literal("failed")),
    attempt: v.number(), leaseId: v.optional(v.string()), leaseExpiresAt: v.optional(v.number()),
    error: v.optional(v.string()), createdAt: v.number(), updatedAt: v.number(),
  }).index("by_event", ["webhookEventId"]),
};
