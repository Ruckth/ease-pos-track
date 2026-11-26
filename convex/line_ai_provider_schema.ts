import { defineTable } from "convex/server";
import { v } from "convex/values";

export const lineAiProvider = v.union(v.literal("gemini"), v.literal("openrouter"), v.literal("claude"), v.literal("openai"));

export const lineAiTables = {
  /** Configuration changes fence scans. Pause and disconnect also revoke approvals. */
  lineAiConnections: defineTable({
    projectId: v.id("projects"), provider: lineAiProvider, model: v.string(),
    // Absent once disabled; a new key must pass the synthetic test again.
    keyCipher: v.optional(v.string()), keyHint: v.optional(v.string()),
    enabled: v.boolean(), revision: v.number(), authorizationRevision: v.optional(v.number()),
    testedAt: v.optional(v.number()), updatedAt: v.number(), updatedBy: v.optional(v.id("staff")),
  }).index("by_project", ["projectId"]),
  lineAiConnectionEvents: defineTable({
    projectId: v.id("projects"), provider: lineAiProvider, model: v.string(), revision: v.number(),
    action: v.union(v.literal("saved"), v.literal("paused"), v.literal("resumed"), v.literal("disconnected")),
    enabled: v.boolean(), createdAt: v.number(), staffId: v.optional(v.id("staff")),
  }).index("by_project_revision", ["projectId", "revision"]),
};
