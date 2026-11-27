import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import {
  internalJobAction,
  internalJobMutation,
  internalJobQuery,
  internalStaffQuery,
  staffQuery,
} from "./functions";
import { openLineSecret } from "./line_crypto";
import { captureKind } from "./line_capture_schema";
import type { LineCaptureMediaEvent } from "./domain/line_capture";
import * as domain from "./line_capture_media_domain";
import { fetchCapturedLineContent, validateCapturedImage } from "./line_capture_media_fetch";
import {
  intakeMediaContentType,
  intakeMediaFileType,
  intakeMediaWarningCode,
} from "./line_capture_media_schema";

const mediaIdArg = { mediaId: v.id("intakeMedia") };

const mediaEventValidator = v.object({
  webhookEventId: v.string(),
  timestamp: v.number(),
  kind: captureKind,
  lineChatId: v.string(),
  messageId: v.string(),
  senderDigest: v.string(),
  fileType: intakeMediaFileType,
  contentProvider: v.optional(v.union(v.literal("line"), v.literal("external"))),
  imageSet: v.optional(v.object({ id: v.string(), index: v.number(), total: v.number() })),
  imageSetInvalid: v.optional(v.literal(true)),
});

/**
 * Webhook dispatch entry point called by `convex/line_webhook.ts` after signature
 * verification and webhook acceptance. Persists signed file metadata and schedules
 * bounded staging or image-before-text retry without blocking the webhook response.
 */
export async function receiveLineCaptureMedia(
  ctx: ActionCtx,
  args: { botId: Id<"lineBots">; events: LineCaptureMediaEvent[] },
) {
  if (!args.events.length) return [];
  return ctx.runMutation(internal.line_capture_media.ingest, args);
}

/** Staff UI query for staged private screenshots & warnings on one intake (including linked). */
export const list = staffQuery({
  name: "line_capture_media:list",
  args: { intakeId: v.id("lineCaptureIntakes") },
  handler: (ctx, { intakeId }) => domain.listIntakeMediaForStaff(ctx, { intakeId }),
});

export const ingest = internalJobMutation({
  name: "line_capture_media:ingest",
  args: { botId: v.id("lineBots"), events: v.array(mediaEventValidator) },
  handler: (ctx, args) => domain.ingestCaptureMediaEvents(ctx, args),
});

export const retryMatch = internalJobMutation({
  name: "line_capture_media:retryMatch",
  args: mediaIdArg,
  handler: (ctx, { mediaId }) => domain.retryMatchCaptureMedia(ctx, { mediaId }),
});

export const claimForStaging = internalJobMutation({
  name: "line_capture_media:claimForStaging",
  args: mediaIdArg,
  handler: (ctx, { mediaId }) => domain.claimMediaForStaging(ctx, { mediaId }),
});

export const authorizeFetch = internalJobQuery({
  name: "line_capture_media:authorizeFetch",
  args: { ...mediaIdArg, leaseId: v.string(), tokenCipher: v.string() },
  handler: (ctx, args) => domain.authorizeMediaFetch(ctx, args),
});

export const reserveWrite = internalJobMutation({
  name: "line_capture_media:reserveWrite",
  args: {
    ...mediaIdArg,
    leaseId: v.string(),
    sha256: v.string(),
    size: v.number(),
    contentType: intakeMediaContentType,
  },
  handler: (ctx, args) => domain.reserveMediaWrite(ctx, args),
});

export const recordStaged = internalJobMutation({
  name: "line_capture_media:recordStaged",
  args: {
    ...mediaIdArg,
    leaseId: v.string(),
    marker: v.string(),
    sha256: v.string(),
    size: v.number(),
    contentType: intakeMediaContentType,
    width: v.number(),
    height: v.number(),
    storageId: v.id("_storage"),
  },
  handler: (ctx, args) => domain.recordStagedMedia(ctx, args),
});

export const recordWarning = internalJobMutation({
  name: "line_capture_media:recordWarning",
  args: {
    ...mediaIdArg,
    leaseId: v.string(),
    warningCode: intakeMediaWarningCode,
    blockIntakeSet: v.optional(v.boolean()),
  },
  handler: (ctx, args) => domain.recordMediaWarning(ctx, args),
});

export const failAttempt = internalJobMutation({
  name: "line_capture_media:failAttempt",
  args: { ...mediaIdArg, leaseId: v.string() },
  handler: (ctx, args) => domain.failMediaAttempt(ctx, args),
});

/** Runs the bounded download, validation, reservation and private storage write for one item. */
export async function stageCapturedMedia(
  ctx: ActionCtx,
  mediaId: Id<"intakeMedia">,
  transport?: typeof fetch,
): Promise<void> {
  const claim = await ctx.runMutation(internal.line_capture_media.claimForStaging, { mediaId });
  if (!claim) return;
  const { leaseId, messageId, tokenCipher } = claim;

  const allowed = await ctx.runQuery(internal.line_capture_media.authorizeFetch, { mediaId, leaseId, tokenCipher });
  if (!allowed) return;

  let fetched: { bytes: Uint8Array<ArrayBuffer>; mimeType?: string };
  try {
    const token = await openLineSecret(tokenCipher);
    fetched = await fetchCapturedLineContent({ messageId, token, transport });
  } catch (error) {
    const code = error instanceof Error ? error.message : "MEDIA_DOWNLOAD_UNAVAILABLE";
    if (code === "MEDIA_UPSTREAM_EXPIRED") {
      await ctx.runMutation(internal.line_capture_media.recordWarning, {
        mediaId,
        leaseId,
        warningCode: "MEDIA_UPSTREAM_EXPIRED",
      });
      return;
    }
    if (code === "MEDIA_SIZE_LIMIT_EXCEEDED") {
      await ctx.runMutation(internal.line_capture_media.recordWarning, {
        mediaId,
        leaseId,
        warningCode: "MEDIA_SIZE_LIMIT_EXCEEDED",
        blockIntakeSet: true,
      });
      return;
    }
    await ctx.runMutation(internal.line_capture_media.failAttempt, { mediaId, leaseId });
    return;
  }

  const validated = await validateCapturedImage(fetched.bytes, fetched.mimeType);
  if (!validated.ok) {
    await ctx.runMutation(internal.line_capture_media.recordWarning, {
      mediaId,
      leaseId,
      warningCode: validated.warningCode,
      ...(validated.warningCode === "MEDIA_SIZE_LIMIT_EXCEEDED" ? { blockIntakeSet: true } : {}),
    });
    return;
  }

  // Reserve a durable write marker BEFORE storing bytes so interrupted writes stay reconcilable.
  const reservation = await ctx.runMutation(internal.line_capture_media.reserveWrite, {
    mediaId,
    leaseId,
    sha256: validated.sha256,
    size: validated.size,
    contentType: validated.contentType,
  });
  if (!reservation.ok) return;

  const storageId = await ctx.storage.store(new Blob([fetched.bytes], { type: reservation.writeContentType }));
  await ctx.runMutation(internal.line_capture_media.recordStaged, {
    mediaId,
    leaseId,
    marker: reservation.marker,
    sha256: validated.sha256,
    size: validated.size,
    contentType: validated.contentType,
    width: validated.width,
    height: validated.height,
    storageId,
  });
}

export const stage = internalJobAction({
  name: "line_capture_media:stage",
  args: mediaIdArg,
  handler: (ctx, { mediaId }) => stageCapturedMedia(ctx, mediaId),
});

export const withdrawByMessage = internalJobMutation({
  name: "line_capture_media:withdrawByMessage",
  args: { botId: v.id("lineBots"), messageId: v.string() },
  handler: (ctx, args) => domain.withdrawMediaByMessage(ctx, args),
});

export const withdrawForIntake = internalJobMutation({
  name: "line_capture_media:withdrawForIntake",
  args: { intakeId: v.id("lineCaptureIntakes") },
  handler: (ctx, args) => domain.withdrawMediaForIntake(ctx, args),
});

export const reconcileWrites = internalJobMutation({
  name: "line_capture_media:reconcileWrites",
  args: {},
  handler: ctx => domain.reconcileDueMediaWrites(ctx),
});

export const expireMedia = internalJobMutation({
  name: "line_capture_media:expireMedia",
  args: { limit: v.optional(v.number()) },
  handler: (ctx, { limit }) => domain.expireStagedMedia(ctx, { limit }),
});

export const recoverStaging = internalJobMutation({
  name: "line_capture_media:recoverStaging",
  args: { limit: v.optional(v.number()) },
  handler: (ctx, { limit }) => domain.recoverStagedMedia(ctx, { limit }),
});

export const reclaimFixture = internalJobMutation({
  name: "line_capture_media:reclaimFixture",
  args: { limit: v.optional(v.number()) },
  handler: (ctx, { limit }) => domain.reclaimFixtureMediaStorage(ctx, { limit }),
});

/** Called by the private authenticated HTTP bytes route with forwarded Convex Auth JWT. */
export const resolveForStaff = internalStaffQuery({
  name: "line_capture_media:resolveForStaff",
  args: { mediaId: v.string(), expectedRevision: v.optional(v.number()) },
  handler: (ctx, args) => domain.resolveCapturedMediaForStaff(ctx, args),
});
