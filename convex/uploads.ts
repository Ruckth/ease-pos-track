import { validateFiles, sameFiles, fileSignature, MAX_MEDIA_FILES } from "../shared/media-policy";
import { actorMutation, actorQuery, trustedCallbackMutation, requireCallbackCredential, legacyUploadTransportQuery, internalJobMutation } from "./functions";
import { v } from "convex/values";
import { mediaItemValidator, pendingFileValidator } from "./schema";
import { requireClosedPilot, requireCurrentPilotEpoch, requireLegacyMedia } from "./pilot_access";
import { actorFields } from "./authz";
import { requireOwnedUploadIntent, recordUpload, reserveIntentAssets } from "./domain/media";

export const legacyTransportAvailable = legacyUploadTransportQuery();

const INTENT_TTL_MS = 30 * 60 * 1000;

function makeSecret() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const createUploadIntent = actorMutation({
  name: "uploads:createUploadIntent",
  args: {
    idempotencyKey: v.string(),
    files: v.array(pendingFileValidator),
  },
  handler: async (ctx, args) => {
    requireLegacyMedia();
    const { session, actor } = ctx;
    const idempotencyKey = args.idempotencyKey.trim();
    if (idempotencyKey.length < 16 || idempotencyKey.length > 128) {
      throw new Error("INVALID_UPLOAD_REQUEST");
    }
    validateFiles(args.files);

    const existing = await ctx.db
      .query("uploadIntents")
      .withIndex("by_idempotency", (q) => q.eq("actorRole", actor.role).eq("actorCustomerId", actor.customerId)
        .eq("actorStaffId", actor.staffId).eq("idempotencyKey", idempotencyKey))
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
    callbackToken: v.string(),
    intentId: v.id("uploadIntents"),
    secret: v.string(),
    files: v.array(pendingFileValidator),
  },
  handler: async (ctx, args) => {
    requireLegacyMedia();
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
      && intent.actorStaffId === actor.staffId
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
    callbackToken: v.optional(v.string()),
    intentId: v.id("uploadIntents"),
    secret: v.string(),
    file: mediaItemValidator,
  },
  handler: async (ctx, args) => {
    requireLegacyMedia();
    const intent = await ctx.db.get(args.intentId);
    if (!intent || intent.secret !== args.secret) {
      throw new Error("UPLOAD_INTENT_INVALID");
    }
    if (ctx.staffSessionId && intent.sessionId !== ctx.staffSessionId) throw new Error("UPLOAD_INTENT_NOT_FOUND");
    return await recordUpload(ctx, intent, args.file, ctx.staffSessionId ? "staff" : "callback");
  },
});

export const cancelUploadIntent = actorMutation({
  name: "uploads:cancelUploadIntent",
  args: {
    intentId: v.string(),
    secret: v.string(),
  },
  handler: async (ctx, args) => {
    requireLegacyMedia();
    const intentId = ctx.db.normalizeId("uploadIntents", args.intentId);
    if (!intentId) throw new Error("UPLOAD_INTENT_NOT_FOUND");
    const intent = requireOwnedUploadIntent(await ctx.db.get(intentId), ctx.actor, args.secret);
    // Separate lifecycle reads keep historical deletions from hiding the bounded
    // accepted uploads which still need a reservation.
    const assets = (await Promise.all((["pending", "deleting", "deleted"] as const).map(lifecycle =>
      ctx.db.query("mediaAssets").withIndex("by_intent", q => q.eq("intentId", intent._id).eq("lifecycle", lifecycle)).take(MAX_MEDIA_FILES)))).flat();
    const jobIds = await reserveIntentAssets(ctx, intent, assets.filter(asset => !asset.ticketId), "cancellation");
    if (intent.status === "pending" || intent.status === "expiring") await ctx.db.patch(intent._id, { status: "cancelled", updatedAt: Date.now() });
    const jobs = await Promise.all(jobIds.map(id => ctx.db.get(id)));
    // A terminal failure is data, so this response cannot roll back reservations
    // for other assets newly cancelled in this transaction.
    if (jobs.some(job => job?.state === "failed")) return { state: "failed" as const, jobIds };
    return { state: jobs.some(job => job?.state !== "completed") ? "queued" as const : "completed" as const, jobIds };
  },
});

/** Operator reconciliation of a known late outcome. Public callback credentials
 * have no authority here. Keep the original intent and reserve any orphan.
 */
export const reconcileLateCallback = internalJobMutation({
  name: "uploads:reconcileLateCallback",
  args: {
    epoch: v.string(),
    intentId: v.id("uploadIntents"),
    intentSecret: v.string(),
    file: mediaItemValidator,
  },
  handler: async (ctx, args) => {
    requireCurrentPilotEpoch(args.epoch, requireClosedPilot().epoch);
    const intent = await ctx.db.get(args.intentId);
    if (!intent || intent.secret !== args.intentSecret) throw new Error("UPLOAD_INTENT_INVALID");
    return await recordUpload(ctx, intent, args.file, "history");
  },
});
