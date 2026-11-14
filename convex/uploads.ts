import { validateFiles, sameFiles, fileSignature } from "../shared/media-policy";
import { actorMutation, actorQuery, trustedCallbackMutation, requireCallbackCredential } from "./functions";
import { v } from "convex/values";
import { mediaItemValidator, pendingFileValidator } from "./schema";
import { actorFields } from "./authz";
import { requireOwnedUploadIntent, recordUpload, reserveIntentAssets } from "./domain/media";

const INTENT_TTL_MS = 30 * 60 * 1000;

function makeSecret() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const createUploadIntent = actorMutation({
  name: "uploads:createUploadIntent",
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
      .withIndex("by_idempotency", (q) => q.eq("actorRole", actor.role).eq("actorCustomerId", actor.customerId).eq("idempotencyKey", idempotencyKey))
      .order("desc")
      .first();
    const reusable = existing && (existing.status === "attached" || (existing.status === "pending" && existing.expiresAt > Date.now()));
    if (reusable && !sameFiles(existing.expectedFiles, args.files)) {
      throw new Error("UPLOAD_REQUEST_CONFLICT");
    }
    if (existing && existing.status === "pending" && existing.expiresAt > Date.now()) {
      // Ownership is durable; the privileged staff recording capability is bound
      // to the session which most recently acquired this intent.
      await ctx.db.patch(existing._id, { sessionId: session._id });
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
  name: "uploads:validateUploadIntent",
  args: {
    token: v.string(),
    callbackToken: v.string(),
    intentId: v.id("uploadIntents"),
    secret: v.string(),
    files: v.array(pendingFileValidator),
  },
  handler: async (ctx, args) => {
    requireCallbackCredential(args.callbackToken);
    const { actor } = ctx;
    const intent = await ctx.db.get(args.intentId);
    const files = [...(intent?.uploadedFiles ?? []), ...args.files];
    try { validateFiles(files); }
    catch { return false; }
    return Boolean(
      intent
      && intent.actorRole === actor.role
      && intent.actorCustomerId === actor.customerId
      && intent.secret === args.secret
      && intent.status === "pending"
      && intent.expiresAt > Date.now()
      && args.files.length > 0
      && files.every((file, index) => files.slice(0, index + 1).filter(item => fileSignature(item) === fileSignature(file)).length
        <= intent.expectedFiles.filter(item => fileSignature(item) === fileSignature(file)).length),
    );
  },
});

export const recordUploadedFile = trustedCallbackMutation({
  name: "uploads:recordUploadedFile",
  args: {
    token: v.optional(v.string()),
    callbackToken: v.optional(v.string()),
    intentId: v.id("uploadIntents"),
    secret: v.string(),
    file: mediaItemValidator,
  },
  handler: async (ctx, args) => {
    const intent = await ctx.db.get(args.intentId);
    if (!intent || intent.secret !== args.secret) {
      throw new Error("UPLOAD_INTENT_INVALID");
    }
    if (ctx.staffSessionId && intent.sessionId !== ctx.staffSessionId) throw new Error("UPLOAD_INTENT_NOT_FOUND");
    return await recordUpload(ctx, intent, args.file, !ctx.staffSessionId);
  },
});

export const cancelUploadIntent = actorMutation({
  name: "uploads:cancelUploadIntent",
  args: {
    token: v.string(),
    intentId: v.id("uploadIntents"),
    secret: v.string(),
  },
  handler: async (ctx, args) => {
    const intent = requireOwnedUploadIntent(await ctx.db.get(args.intentId), ctx.actor, args.secret);
    if (intent.status === "attached" || intent.status === "cleaned") return { state: "completed" as const, jobIds: [] };
    const assets = await ctx.db.query("mediaAssets").withIndex("by_intent", q => q.eq("intentId", intent._id)).collect();
    const jobIds = await reserveIntentAssets(ctx, intent, assets, "cancellation");
    if (intent.status !== "cancelled") await ctx.db.patch(intent._id, { status: "cancelled", updatedAt: Date.now() });
    return { state: jobIds.length ? "queued" as const : "completed" as const, jobIds };
  },
});
