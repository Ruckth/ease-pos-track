import { v } from "convex/values";
import { feedbackStatus, mediaItemValidator } from "./schema";
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
    media: v.array(mediaItemValidator),
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);

    const title = args.title.trim();
    const description = args.description.trim();
    if (!title || !description) {
      throw new Error("Topic and description are required.");
    }
    if (args.media.length === 0) {
      throw new Error("At least one image or video is required.");
    }
    const imageCount = args.media.filter((item) => item.type.startsWith("image/")).length;
    const videoCount = args.media.filter((item) => item.type.startsWith("video/")).length;
    if (imageCount + videoCount !== args.media.length) {
      throw new Error("Only image and video media are supported.");
    }
    if (imageCount > 10 || videoCount > 3) {
      throw new Error("Up to 10 images and 3 videos per report.");
    }
    for (const item of args.media) {
      if (!item.key || !item.url.startsWith("https://")) {
        throw new Error("Invalid media reference.");
      }
    }

    const now = Date.now();
    return await ctx.db.insert("feedback", {
      title,
      description,
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

export const addAnnotation = mutation({
  args: {
    token: v.string(),
    id: v.id("feedback"),
    mediaIndex: v.number(),
    kind: v.union(v.literal("point"), v.literal("time")),
    x: v.optional(v.number()),
    y: v.optional(v.number()),
    time: v.optional(v.number()),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);

    const doc = await ctx.db.get(args.id);
    if (!doc) throw new Error("Feedback not found.");

    const text = args.text.trim();
    if (!text) throw new Error("Comment text is required.");
    if (!Number.isInteger(args.mediaIndex) || args.mediaIndex < 0 || args.mediaIndex >= doc.media.length) {
      throw new Error("Invalid media index.");
    }
    const target = doc.media[args.mediaIndex];
    if (args.kind === "point" && (args.x === undefined || args.y === undefined)) {
      throw new Error("Point annotations require x and y.");
    }
    if (args.kind === "time" && args.time === undefined) {
      throw new Error("Time annotations require a timestamp.");
    }
    if (args.kind === "time" && !target.type.startsWith("video/")) {
      throw new Error("Time marks are only valid on videos.");
    }
    if (args.kind === "point" && target.type.startsWith("video/")) {
      throw new Error("Use a time mark for videos.");
    }

    const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
    const annotations = doc.annotations ?? [];
    const label = annotations.reduce((max, item) => Math.max(max, item.label), 0) + 1;
    const annotation = {
      id: crypto.randomUUID(),
      label,
      mediaIndex: args.mediaIndex,
      kind: args.kind,
      x: args.x === undefined ? undefined : clamp01(args.x),
      y: args.y === undefined ? undefined : clamp01(args.y),
      time: args.time === undefined ? undefined : Math.max(0, args.time),
      text,
      createdAt: Date.now(),
    };

    await ctx.db.patch(args.id, {
      annotations: [...annotations, annotation],
      updatedAt: Date.now(),
    });

    return annotation.id;
  },
});

export const removeAnnotation = mutation({
  args: {
    token: v.string(),
    id: v.id("feedback"),
    annotationId: v.string(),
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);

    const doc = await ctx.db.get(args.id);
    if (!doc) throw new Error("Feedback not found.");

    const annotations = (doc.annotations ?? []).filter((item) => item.id !== args.annotationId);
    await ctx.db.patch(args.id, {
      annotations,
      updatedAt: Date.now(),
    });
  },
});
