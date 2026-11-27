import { defineTable } from "convex/server";
import { v } from "convex/values";

export const captureKind = v.union(v.literal("group"), v.literal("room"));
export const captureState = v.union(
  v.literal("captured"), v.literal("needs_details"), v.literal("review"),
  v.literal("linked"), v.literal("dismissed"), v.literal("withdrawn"),
);
export const captureOperation = v.union(v.literal("create"), v.literal("link"), v.literal("dismiss"));

const enrollment = {
  projectId: v.id("projects"), botId: v.id("lineBots"), chatId: v.id("lineChats"), joinedAt: v.number(),
};

/** No-model-key LINE capture. Capture authority is separate from AI analysis authority. */
export const lineCaptureTables = {
  // Presence switches a Project's single LINE intake writer from the legacy AI path to capture.
  lineCaptureProjects: defineTable({
    projectId: v.id("projects"), enabledAt: v.number(), enabledBy: v.id("staff"),
  }).index("by_project", ["projectId"]),
  // Per-chat capture opt-in, bound to one enrollment (joinedAt).
  lineCaptureChats: defineTable({
    ...enrollment, enabledAt: v.number(), enabledBy: v.id("staff"),
  }).index("by_chat", ["chatId", "joinedAt"]).index("by_project", ["projectId"]),
  lineCaptureIntakes: defineTable({
    ...enrollment, captureChatId: v.id("lineCaptureChats"), kind: captureKind,
    messageId: v.string(), webhookEventId: v.string(), senderDigest: v.string(),
    text: v.string(), mentioned: v.boolean(),
    state: captureState, bucket: v.union(v.literal("open"), v.literal("done")),
    revision: v.number(), messageTimestamp: v.number(), sourceTimestamp: v.number(),
    conflict: v.optional(v.boolean()), warning: v.optional(v.string()),
    correction: v.optional(v.object({ text: v.string(), mentioned: v.boolean(), timestamp: v.number() })),
    unsentAt: v.optional(v.number()),
    // Content aged out; the content-free row and its receipts remain until expiresAt again.
    redactedAt: v.optional(v.number()),
    createdAt: v.number(), updatedAt: v.number(), expiresAt: v.number(),
  }).index("by_bot_message", ["botId", "messageId"])
    .index("by_project_bucket", ["projectId", "bucket", "updatedAt"])
    .index("by_chat_sender_time", ["chatId", "joinedAt", "senderDigest", "messageTimestamp"])
    .index("by_expires_at", ["expiresAt"]),
  // Per-bot webhookEventId dedup.
  lineCaptureEvents: defineTable({
    botId: v.id("lineBots"), webhookEventId: v.string(), messageId: v.string(), expiresAt: v.number(),
  }).index("by_bot_event", ["botId", "webhookEventId"]).index("by_expires_at", ["expiresAt"]),
  // Unsend fences: an unsend wins over late, early or redelivered events for the same message.
  lineCaptureUnsends: defineTable({
    botId: v.id("lineBots"), lineChatId: v.string(), messageId: v.string(), unsentAt: v.number(), expiresAt: v.number(),
  }).index("by_bot_chat_message", ["botId", "lineChatId", "messageId"]).index("by_expires_at", ["expiresAt"]),
  // Edits that arrived before their original message was admitted.
  lineCaptureEdits: defineTable({
    captureChatId: v.id("lineCaptureChats"), botId: v.id("lineBots"), lineChatId: v.string(), messageId: v.string(), senderDigest: v.string(),
    text: v.string(), mentioned: v.boolean(), timestamp: v.number(), expiresAt: v.number(),
  }).index("by_bot_message", ["botId", "messageId", "timestamp"]).index("by_expires_at", ["expiresAt"]),
  lineCaptureReceipts: defineTable({
    intakeId: v.id("lineCaptureIntakes"), projectId: v.id("projects"), candidateKey: v.string(),
    operation: captureOperation, digest: v.string(), intakeRevision: v.number(),
    staffId: v.id("staff"), sessionId: v.id("sessionAdmissions"), sourceChatId: v.id("lineChats"),
    ticketId: v.optional(v.id("tickets")), ticketNumber: v.optional(v.string()), createdAt: v.number(),
  }).index("by_intake_candidate", ["intakeId", "candidateKey"]),
};
