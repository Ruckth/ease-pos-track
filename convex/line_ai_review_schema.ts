import { defineTable } from "convex/server";
import { v } from "convex/values";

export const lineAiIntent = v.union(v.literal("create"), v.literal("close"), v.literal("clarify"), v.literal("skip"));
export const lineAiSuggestion = v.object({
  intent: lineAiIntent,
  title: v.union(v.string(), v.null()),
  description: v.union(v.string(), v.null()),
  ticketNumber: v.union(v.string(), v.null()),
  reply: v.union(v.string(), v.null()),
  evidence: v.array(v.string()),
});

export const lineAiReplyResult = v.union(v.literal("accepted"), v.literal("rejected"), v.literal("unknown"), v.literal("limited"));
const replyState = v.union(
  v.literal("pending"), v.literal("accepted"), v.literal("rejected"), v.literal("unknown"),
  v.literal("limited"), v.literal("suppressed"),
);

export const lineAiReviewTables = {
  lineAiDrafts: defineTable({
    intakeId: v.id("lineAiIntakes"), projectId: v.id("projects"),
    state: v.union(v.literal("review"), v.literal("acted"), v.literal("dismissed")),
    suggestion: lineAiSuggestion, warning: v.optional(v.string()),
    connectionRevision: v.number(), authorizationRevision: v.optional(v.number()), createdAt: v.number(), expiresAt: v.number(),
  }).index("by_intake", ["intakeId"])
    .index("by_project_review_state", ["projectId", "state", "expiresAt"])
    .index("by_expiry", ["expiresAt"]),
  lineAiTicketLinks: defineTable({
    chatId: v.id("lineChats"), projectId: v.id("projects"), ticketId: v.id("tickets"),
    joinedAt: v.number(), ticketNumber: v.number(),
  }).index("by_chat_ticket", ["chatId", "joinedAt", "ticketNumber"])
    .index("by_ticket", ["ticketId"]),
  lineAiReplies: defineTable({
    draftId: v.id("lineAiDrafts"), projectId: v.id("projects"), botId: v.id("lineBots"),
    chatId: v.id("lineChats"), joinedAt: v.number(), chatRevision: v.number(), botRevision: v.number(),
    connectionRevision: v.number(), authorizationRevision: v.optional(v.number()), projectVisibilityVersion: v.number(),
    ticketId: v.optional(v.id("tickets")), ticketNumber: v.optional(v.string()), ticketVisibilityVersion: v.optional(v.number()),
    authorStaffId: v.id("staff"), text: v.optional(v.string()), retryKey: v.string(), decisionDigest: v.optional(v.string()),
    state: replyState, attempt: v.number(), leaseId: v.optional(v.string()), leaseExpiresAt: v.optional(v.number()),
    hadUncertainAttempt: v.optional(v.boolean()),
    createdAt: v.number(), updatedAt: v.number(), expiresAt: v.number(), eraseTextAt: v.optional(v.number()), deleteAt: v.number(),
  }).index("by_draft", ["draftId"])
    .index("by_project", ["projectId", "createdAt"])
    .index("by_ticket", ["ticketId"])
    .index("by_state_updated", ["state", "updatedAt"])
    .index("by_erase_text", ["eraseTextAt"])
    .index("by_deletion", ["deleteAt"]),
  lineAiUsage: defineTable({
    projectId: v.id("projects"), day: v.number(), scans: v.number(),
  }).index("by_project_day", ["projectId", "day"])
    .index("by_day", ["day"]),
};
