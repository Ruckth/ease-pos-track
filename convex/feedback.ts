import { v } from "convex/values";
import { feedbackStatus } from "./schema";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";

async function requireSession(ctx: QueryCtx | MutationCtx, token: string) {
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();

  if (!session || session.expiresAt <= Date.now()) {
    throw new Error("Your session expired. Please sign in again.");
  }
}

const mediaValidator = v.object({
  key: v.string(),
  name: v.string(),
  size: v.number(),
  type: v.string(),
  url: v.string(),
});

export const listFeedback = query({
  args: {
    token: v.string(),
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);

    return await ctx.db.query("feedback").withIndex("by_created_at").order("desc").collect();
  },
});

export const getFeedback = query({
  args: {
    token: v.string(),
    id: v.id("feedback"),
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    return await ctx.db.get(args.id);
  },
});

export const createFeedback = mutation({
  args: {
    token: v.string(),
    title: v.string(),
    description: v.string(),
    media: mediaValidator,
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);

    const now = Date.now();
    return await ctx.db.insert("feedback", {
      title: args.title.trim(),
      description: args.description.trim(),
      status: "new",
      media: args.media,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateFeedbackStatus = mutation({
  args: {
    token: v.string(),
    id: v.id("feedback"),
    status: feedbackStatus,
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);

    await ctx.db.patch(args.id, {
      status: args.status,
      updatedAt: Date.now(),
    });
  },
});
