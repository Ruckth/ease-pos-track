import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mediaItemValidator, pendingFileValidator } from "./schema";

const INTENT_TTL_MS = 30 * 60 * 1000;
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const VIDEO_MAX_BYTES = 64 * 1024 * 1024;

async function requireSession(ctx: QueryCtx | MutationCtx, token: string) {
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();
  if (!session || session.expiresAt <= Date.now()) {
    throw new Error("Your session expired. Please sign in again.");
  }
  return session;
}

function makeSecret() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function validateFiles(files: Array<{ name: string; size: number; type: string }>) {
  if (files.length === 0) throw new Error("At least one image or video is required.");
  const images = files.filter((file) => file.type.startsWith("image/"));
  const videos = files.filter((file) => file.type.startsWith("video/"));
  if (images.length + videos.length !== files.length) throw new Error("Only images and videos are supported.");
  if (images.length > 10 || videos.length > 3) throw new Error("Up to 10 images and 3 videos are allowed.");
  if (images.some((file) => file.size <= 0 || file.size > IMAGE_MAX_BYTES)) {
    throw new Error("Images must be larger than 0 bytes and no more than 8MB.");
  }
  if (videos.some((file) => file.size <= 0 || file.size > VIDEO_MAX_BYTES)) {
    throw new Error("Videos must be larger than 0 bytes and no more than 64MB.");
  }
  if (files.some((file) => !file.name.trim() || file.name.length > 255 || file.type.length > 100)) {
    throw new Error("Invalid file metadata.");
  }
}

function fileSignature(file: { name: string; size: number; type: string }) {
  return `${file.name}\u0000${file.size}\u0000${file.type}`;
}

export function sameFiles(
  expected: Array<{ name: string; size: number; type: string }>,
  actual: Array<{ name: string; size: number; type: string }>,
) {
  const left = expected.map(fileSignature).sort();
  const right = actual.map(fileSignature).sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export const createUploadIntent = mutation({
  args: {
    token: v.string(),
    idempotencyKey: v.string(),
    files: v.array(pendingFileValidator),
  },
  handler: async (ctx, args) => {
    const session = await requireSession(ctx, args.token);
    const idempotencyKey = args.idempotencyKey.trim();
    if (idempotencyKey.length < 16 || idempotencyKey.length > 128) {
      throw new Error("Invalid upload request.");
    }
    validateFiles(args.files);

    const existing = await ctx.db
      .query("uploadIntents")
      .withIndex("by_idempotency", (q) => q.eq("sessionId", session._id).eq("idempotencyKey", idempotencyKey))
      .order("desc")
      .first();
    if (existing && existing.status === "pending" && existing.expiresAt > Date.now()) {
      return { intentId: existing._id, secret: existing.secret, feedbackId: existing.feedbackId };
    }
    if (existing?.status === "attached" && existing.feedbackId) {
      return { intentId: existing._id, secret: existing.secret, feedbackId: existing.feedbackId };
    }

    const now = Date.now();
    const secret = makeSecret();
    const intentId = await ctx.db.insert("uploadIntents", {
      sessionId: session._id,
      secret,
      idempotencyKey,
      expectedFiles: args.files,
      uploadedFiles: [],
      status: "pending",
      createdAt: now,
      expiresAt: now + INTENT_TTL_MS,
      updatedAt: now,
    });
    return { intentId, secret, feedbackId: undefined };
  },
});

export const validateUploadIntent = query({
  args: {
    token: v.string(),
    intentId: v.id("uploadIntents"),
    secret: v.string(),
    files: v.array(pendingFileValidator),
  },
  handler: async (ctx, args) => {
    const session = await requireSession(ctx, args.token);
    const intent = await ctx.db.get(args.intentId);
    return Boolean(
      intent
      && intent.sessionId === session._id
      && intent.secret === args.secret
      && intent.status === "pending"
      && intent.expiresAt > Date.now()
      && sameFiles(intent.expectedFiles, args.files),
    );
  },
});

export const recordUploadedFile = mutation({
  args: {
    intentId: v.id("uploadIntents"),
    secret: v.string(),
    file: mediaItemValidator,
  },
  handler: async (ctx, args) => {
    const intent = await ctx.db.get(args.intentId);
    if (!intent || intent.secret !== args.secret || intent.status !== "pending" || intent.expiresAt <= Date.now()) {
      throw new Error("Upload intent is no longer valid.");
    }
    const expectedMatch = intent.expectedFiles.some((file) => fileSignature(file) === fileSignature(args.file));
    if (!expectedMatch) throw new Error("Uploaded file was not part of this request.");
    if (!args.file.key || !args.file.url.startsWith("https://")) throw new Error("Invalid uploaded file.");
    if (intent.uploadedFiles.some((file) => file.key === args.file.key)) return;
    await ctx.db.patch(intent._id, {
      uploadedFiles: [...intent.uploadedFiles, args.file],
      updatedAt: Date.now(),
    });
  },
});

export const cancelUploadIntent = mutation({
  args: {
    token: v.string(),
    intentId: v.id("uploadIntents"),
    secret: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await requireSession(ctx, args.token);
    const intent = await ctx.db.get(args.intentId);
    if (!intent || intent.sessionId !== session._id || intent.secret !== args.secret) {
      throw new Error("Upload intent not found.");
    }
    if (intent.status === "attached") return { keys: [] as string[] };
    await ctx.db.patch(intent._id, { status: "cancelled", updatedAt: Date.now() });
    return { keys: intent.uploadedFiles.map((file) => file.key) };
  },
});

export const listExpiredIntents = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const pending = await ctx.db
      .query("uploadIntents")
      .withIndex("by_expires_at", (q) => q.eq("status", "pending").lt("expiresAt", now))
      .take(50);
    const cancelled = await ctx.db
      .query("uploadIntents")
      .withIndex("by_expires_at", (q) => q.eq("status", "cancelled").lt("expiresAt", now))
      .take(50);
    return [...pending, ...cancelled];
  },
});

export const markIntentCleaned = internalMutation({
  args: { intentId: v.id("uploadIntents") },
  handler: async (ctx, args) => {
    const intent = await ctx.db.get(args.intentId);
    if (intent && intent.status !== "attached") {
      await ctx.db.patch(args.intentId, { status: "cleaned", updatedAt: Date.now() });
    }
  },
});
