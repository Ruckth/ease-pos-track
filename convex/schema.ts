import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const feedbackStatus = v.union(
  v.literal("new"),
  v.literal("in_progress"),
  v.literal("waiting"),
  v.literal("done"),
);

export default defineSchema({
  feedback: defineTable({
    title: v.string(),
    description: v.string(),
    status: feedbackStatus,
    media: v.object({
      key: v.string(),
      name: v.string(),
      size: v.number(),
      type: v.string(),
      url: v.string(),
    }),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_created_at", ["createdAt"]),
  sessions: defineTable({
    token: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_token", ["token"])
    .index("by_expires_at", ["expiresAt"]),
});
