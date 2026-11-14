import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { Actor } from "../authz";
import { fileSignature, validateMediaItems } from "../../shared/media-policy";

type Media = Doc<"tickets">["media"][number];

export function requireOwnedUploadIntent(intent: Doc<"uploadIntents"> | null, actor: Actor<Id<"customers">>, secret: string) {
  if (!intent || intent.secret !== secret || intent.actorRole !== actor.role || intent.actorCustomerId !== actor.customerId) {
    throw new Error("UPLOAD_INTENT_NOT_FOUND");
  }
  return intent;
}

function sameReceipt(left: Media, right: Media) {
  return left.key === right.key && left.url === right.url && left.name === right.name
    && left.size === right.size && left.type === right.type;
}

/** Reserve immutable keys before any provider work. P4 executes these pending jobs.
 * P4 must verify with the provider that a staff-sourced unattached key exists before deleting it.
 */
export async function reserveIntentAssets(ctx: MutationCtx, intent: Doc<"uploadIntents">,
  assets: Doc<"mediaAssets">[], kind: "cancellation" | "rejected_upload") {
  const jobIds: Id<"mediaJobs">[] = [];
  for (const asset of assets) {
    if (asset.intentId !== intent._id || asset.ticketId || asset.lifecycle === "attached") throw new Error("MEDIA_OWNERSHIP_CONFLICT");
    if (asset.jobId) { jobIds.push(asset.jobId); continue; }
    if (asset.lifecycle === "deleted") continue;
    const now = Date.now();
    const jobId = await ctx.db.insert("mediaJobs", {
      kind, resourceScope: `asset:${asset._id}`, intentId: intent._id, keys: [asset.key], completedKeys: [],
      phase: "delete_media", state: "pending", attempt: 0, maxAttempts: 5, availableAt: now, createdAt: now, updatedAt: now,
    });
    await ctx.db.patch(asset._id, { lifecycle: "deleting", jobId, updatedAt: now });
    jobIds.push(jobId);
  }
  return jobIds;
}

/** Only trusted callers reach here. Indexed key reads serialize competing claims. */
export async function recordUpload(ctx: MutationCtx, intent: Doc<"uploadIntents">, file: Media, trustedCallback = false) {
  if (!file.key.trim()) throw new Error("INVALID_MEDIA_REFERENCE");
  const existing = await ctx.db.query("mediaAssets").withIndex("by_key", q => q.eq("key", file.key)).unique();
  if (existing) {
    if (existing.intentId !== intent._id) throw new Error("MEDIA_OWNERSHIP_CONFLICT");
    if (!sameReceipt(existing.metadata, file)) throw new Error("UPLOAD_VERIFICATION_FAILED");
    // A receipt replay cannot cancel or delete a file, including after attachment.
    return existing.lifecycle === "pending" || existing.lifecycle === "attached"
      ? { state: "recorded" as const }
      : { state: "queued" as const, jobIds: existing.jobId ? [existing.jobId] : [] };
  }
  const expectedCount = intent.expectedFiles.filter(item => fileSignature(item) === fileSignature(file)).length;
  const recordedCount = intent.uploadedFiles.filter(item => fileSignature(item) === fileSignature(file)).length;
  let valid = true;
  try { validateMediaItems([file]); }
  catch { valid = false; }
  const accepted = valid && intent.status === "pending" && intent.expiresAt > Date.now() && recordedCount < expectedCount;
  if (!accepted && !trustedCallback) throw new Error("UPLOAD_INTENT_INVALID");
  const now = Date.now();
  const id = await ctx.db.insert("mediaAssets", {
    key: file.key, source: trustedCallback ? "callback" : "staff", intentId: intent._id, metadata: file, lifecycle: "pending", createdAt: now, updatedAt: now,
  });
  if (!accepted) {
    // Late or definitively rejected new uploads get the same guarded reservation.
    const jobIds = await reserveIntentAssets(ctx, intent, [(await ctx.db.get(id))!], "rejected_upload");
    return { state: "queued" as const, jobIds };
  }
  await ctx.db.patch(intent._id, { uploadedFiles: [...intent.uploadedFiles, file], updatedAt: now });
  return { state: "recorded" as const };
}

export async function verifyPendingUploadIntent(ctx: MutationCtx, intent: Doc<"uploadIntents">, media: Media[]) {
  if (intent.status !== "pending" || intent.expiresAt <= Date.now()) throw new Error("UPLOAD_INTENT_INVALID");
  validateMediaItems(media);
  if (intent.uploadedFiles.length !== media.length || intent.expectedFiles.length !== media.length) throw new Error("UPLOAD_INCOMPLETE");
  if (new Set(media.map(item => item.key)).size !== media.length) throw new Error("UPLOAD_VERIFICATION_FAILED");
  await verifyAssetReceipts(ctx, intent._id, media);
}

export async function verifyAssetReceipts(ctx: MutationCtx, intentId: Id<"uploadIntents">, media: Media[], ticketId?: Id<"tickets">) {
  for (const item of media) {
    const asset = await ctx.db.query("mediaAssets").withIndex("by_key", q => q.eq("key", item.key)).unique();
    if (!asset || asset.intentId !== intentId || asset.ticketId !== ticketId) throw new Error("MEDIA_OWNERSHIP_CONFLICT");
    if (asset.lifecycle !== (ticketId ? "attached" : "pending")) throw new Error("MEDIA_NOT_ATTACHABLE");
    if (!sameReceipt(asset.metadata, item)) throw new Error("UPLOAD_VERIFICATION_FAILED");
  }
}

/** Runs in the Ticket command transaction, after validation and before its receipt. */
export async function attachIntentAssets(ctx: MutationCtx, intent: Doc<"uploadIntents">, ticketId: Id<"tickets">, media: Media[]) {
  for (const item of media) {
    const asset = await ctx.db.query("mediaAssets").withIndex("by_key", q => q.eq("key", item.key)).unique();
    if (!asset || asset.intentId !== intent._id || asset.lifecycle !== "pending" || asset.ticketId) throw new Error("MEDIA_NOT_ATTACHABLE");
    await ctx.db.patch(asset._id, { ticketId, lifecycle: "attached", updatedAt: Date.now() });
  }
  await ctx.db.patch(intent._id, { status: "attached", ticketId, uploadedFiles: media, updatedAt: Date.now() });
}
