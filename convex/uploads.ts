import { validateFiles, sameFiles, fileSignature } from "../shared/media-policy";
import { actorMutation, actorQuery, trustedCallbackMutation } from "./functions";
import { v } from "convex/values";
import { mediaItemValidator, pendingFileValidator } from "./schema";
import { actorFields } from "./authz";

const INTENT_TTL_MS = 30 * 60 * 1000;

function makeSecret() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const createUploadIntent = actorMutation({
  args: {
    token: v.string(),
    idempotencyKey: v.string(),
    files: v.array(pendingFileValidator),
  },
  handler: async (ctx, args) => {
    const { session, actor } = ctx;
    const idempotencyKey = args.idempotencyKey.trim();
    if (idempotencyKey.length < 16 || idempotencyKey.length > 128) {
      throw new Error("INVALID_UPLOAD_REQUEST");
    }
    validateFiles(args.files);

    const existing = await ctx.db
      .query("uploadIntents")
      .withIndex("by_idempotency", (q) => q.eq("sessionId", session._id).eq("idempotencyKey", idempotencyKey))
      .order("desc")
      .first();
    if (existing && !sameFiles(existing.expectedFiles, args.files)) {
      throw new Error("UPLOAD_REQUEST_CONFLICT");
    }
    if (existing && existing.status === "pending" && existing.expiresAt > Date.now()) {
      return { intentId: existing._id, secret: existing.secret, ticketId: existing.ticketId, uploadedFiles: existing.uploadedFiles };
    }
    if (existing?.status === "attached" && existing.ticketId) {
      return { intentId: existing._id, secret: existing.secret, ticketId: existing.ticketId, uploadedFiles: existing.uploadedFiles };
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
      // Recorded so the ticket created from this intent can be checked against
      // the same actor that requested the upload.
      ...actorFields(actor),
      createdAt: now,
      expiresAt: now + INTENT_TTL_MS,
      updatedAt: now,
    });
    return { intentId, secret, ticketId: undefined, uploadedFiles: [] };
  },
});

export const validateUploadIntent = actorQuery({
  args: {
    token: v.string(),
    intentId: v.id("uploadIntents"),
    secret: v.string(),
    files: v.array(pendingFileValidator),
  },
  handler: async (ctx, args) => {
    const { session, actor } = ctx;
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

export const recordUploadedFile = trustedCallbackMutation({
  args: {
    token: v.optional(v.string()),
    callbackToken: v.optional(v.string()),
    intentId: v.id("uploadIntents"),
    secret: v.string(),
    file: mediaItemValidator,
  },
  handler: async (ctx, args) => {
    const intent = await ctx.db.get(args.intentId);
    if (!intent || intent.secret !== args.secret || intent.status !== "pending" || intent.expiresAt <= Date.now()) {
      throw new Error("UPLOAD_INTENT_INVALID");
    }
    if (ctx.staffSessionId && intent.sessionId !== ctx.staffSessionId) throw new Error("UPLOAD_INTENT_NOT_FOUND");
    const expectedMatch = intent.expectedFiles.some((file) => fileSignature(file) === fileSignature(args.file));
    if (!expectedMatch) throw new Error("UPLOAD_FILE_MISMATCH");
    if (!args.file.key || !args.file.url.startsWith("https://")) throw new Error("INVALID_UPLOADED_FILE");
    if (intent.uploadedFiles.some((file) => file.key === args.file.key)) return;
    // An intent never needs more uploads than it declared, so the array cannot be
    // grown past the document size limit by replaying with fresh keys.
    if (intent.uploadedFiles.length >= intent.expectedFiles.length) {
      throw new Error("UPLOAD_FILE_MISMATCH");
    }
    await ctx.db.patch(intent._id, {
      uploadedFiles: [...intent.uploadedFiles, args.file],
      updatedAt: Date.now(),
    });
  },
});

export const cancelUploadIntent = actorMutation({
  args: {
    token: v.string(),
    intentId: v.id("uploadIntents"),
    secret: v.string(),
  },
  handler: async (ctx, args) => {
    const { session, actor } = ctx;
    const intent = await ctx.db.get(args.intentId);
    if (!intent || intent.sessionId !== session._id || intent.secret !== args.secret) {
      throw new Error("UPLOAD_INTENT_NOT_FOUND");
    }
    if (intent.status === "attached") return { keys: [] as string[] };
    await ctx.db.patch(intent._id, { status: "cancelled", updatedAt: Date.now() });
    return { keys: intent.uploadedFiles.map((file) => file.key) };
  },
});
