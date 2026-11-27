/**
 * Private staged media lifecycle for M1 LINE capture:
 * intake matching (including bounded durable retry for image-before-text),
 * upstream imageSet/type/size warnings, pre-store write reservations,
 * late-settlement fencing, interrupted-write reconciliation, immediate hiding on
 * unsend/expiry, and fixture-only bounded cleanup.
 */
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { admittedLineProject, lineProject } from "./domain/line";
import {
  captureBot,
  captureEnrollment,
  captureMessageUnsent,
  currentCaptureIntake,
  flagCaptureWarning,
  LINE_CAPTURE_WINDOW_MS,
  lineCaptureEnabled,
  type LineCaptureMediaEvent,
} from "./domain/line_capture";
import { localFixturesEnabled } from "./local_fixtures";
import { retentionHeld } from "../shared/pilot-settings";
import {
  hexToBase64,
  LINE_CAPTURE_MAX_IMAGES,
  LINE_CAPTURE_MAX_TOTAL_BYTES,
  LINE_CAPTURE_STAGING_TTL_MS,
  parseLineImageSet,
} from "./line_capture_media_fetch";
import type {
  IntakeMediaContentType,
  IntakeMediaWarningCode,
  IntakeMediaWrite,
  StaffIntakeMediaItem,
  StaffIntakeMediaSummary,
} from "./line_capture_media_schema";

export const MEDIA_LEASE_MS = 90_000;
export const MEDIA_MAX_ATTEMPTS = 2;
export const MEDIA_WRITE_WINDOW_MS = 11 * 60 * 1000;
export const MEDIA_WRITE_SCAN = 100;
const MEDIA_WRITE_SETTLE_MS = 5_000;
const MEDIA_SWEEP_LIMIT = 20;
const FUTURE_SKEW_MS = 5 * 60_000;
const MATCH_RETRY_DELAYS_MS = [2_000, 8_000, 20_000, 40_000, 50_000] as const;
const MAX_OPEN_WRITES = 4;

type DbCtx = Pick<QueryCtx, "db">;
type MediaDoc = Doc<"intakeMedia">;
type MediaId = Id<"intakeMedia">;

/** Private per-write marker carried in the stored blob's content type. Never served. */
export function mediaWriteType(marker: string): string {
  return `application/vnd.line-capture-media-write; write=${marker}`;
}

function makeWriteMarker(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

export function buildCapturedMediaPreviewUrl(mediaId: string, intakeRevision: number, baseUrl?: string): string {
  const raw = (baseUrl ?? process.env.CONVEX_SITE_URL ?? "").replace(/\/+$/, "");
  const path = `/v1/line-capture/media/${encodeURIComponent(mediaId)}?revision=${intakeRevision}`;
  return raw ? `${raw}${path}` : path;
}

function isTerminalState(state: MediaDoc["state"]): boolean {
  return state === "withdrawn" || state === "expired" || state === "warning";
}

function isActiveMediaState(state: MediaDoc["state"]): boolean {
  return state === "pending" || state === "staging" || state === "ready";
}

function discardedWith(existing: Id<"_storage">[], storageId: Id<"_storage"> | undefined): Id<"_storage">[] {
  if (!storageId || existing.includes(storageId)) return existing;
  return [...existing, storageId];
}

/**
 * Checks all eligible intakes from the same sender within the ±2 min window.
 * Returns "none", a unique "matched" intake, or "ambiguous" with candidate IDs so
 * we never silently attach media when matching is ambiguous.
 */
async function matchIntakeWindow(
  ctx: DbCtx,
  input: { botId: Id<"lineBots">; chatId: Id<"lineChats">; joinedAt: number; senderDigest: string; timestamp: number },
  now: number,
): Promise<
  | { kind: "none" }
  | { kind: "matched"; intake: Doc<"lineCaptureIntakes"> }
  | { kind: "ambiguous"; intakes: Doc<"lineCaptureIntakes">[] }
> {
  const candidates = await ctx.db
    .query("lineCaptureIntakes")
    .withIndex("by_chat_sender_time", q =>
      q.eq("chatId", input.chatId)
        .eq("joinedAt", input.joinedAt)
        .eq("senderDigest", input.senderDigest)
        .gte("messageTimestamp", input.timestamp - LINE_CAPTURE_WINDOW_MS)
        .lte("messageTimestamp", input.timestamp + LINE_CAPTURE_WINDOW_MS))
    .take(5);

  const eligible: Doc<"lineCaptureIntakes">[] = [];
  for (const row of candidates) {
    if (row.botId !== input.botId) continue;
    if (row.state === "withdrawn" || row.state === "dismissed" || row.unsentAt !== undefined) continue;
    if (row.state !== "linked" && row.expiresAt <= now) continue;
    const current = await currentCaptureIntake(ctx, row._id, now);
    if (current) eligible.push(current);
  }
  if (candidates.length === 5) return { kind: "ambiguous", intakes: eligible };
  if (eligible.length === 0) return { kind: "none" };
  if (eligible.length === 1) return { kind: "matched", intake: eligible[0] };
  return { kind: "ambiguous", intakes: eligible };
}

async function listIntakeMediaRows(ctx: DbCtx, intakeId: Id<"lineCaptureIntakes">): Promise<MediaDoc[]> {
  return ctx.db
    .query("intakeMedia")
    .withIndex("by_intake", q => q.eq("intakeId", intakeId))
    .take(25);
}

/**
 * Blocks all active siblings in an intake/imageSet when overflow, incomplete metadata,
 * or 8 MiB total byte limit triggers, so staff never sees a silently truncated subset.
 */
async function blockIntakeMediaSet(
  ctx: MutationCtx,
  intakeId: Id<"lineCaptureIntakes">,
  warningCode: IntakeMediaWarningCode,
  now: number,
  options?: { imageSetId?: string; excludeMediaId?: MediaId },
) {
  const rows = await listIntakeMediaRows(ctx, intakeId);
  for (const row of rows) {
    if (row._id === options?.excludeMediaId) continue;
    if (row.state === "withdrawn" || row.state === "expired") continue;
    if (options?.imageSetId && row.imageSetId !== options.imageSetId) continue;
    const discarded = discardedWith(row.discarded, row.storageId);
    await ctx.db.patch(row._id, {
      state: "warning",
      warningCode,
      storageId: undefined,
      discarded,
      leaseId: undefined,
      leaseExpiresAt: undefined,
      ...(discarded.length ? { reclaimAfter: row.reclaimAfter ?? now } : {}),
      updatedAt: now,
    });
  }
  await flagCaptureWarning(ctx, intakeId, warningCode);
}

/**
 * Binds an unmatched or newly created media row to its matched intake, enforcing
 * fileType, contentProvider, imageSet metadata/overflow, and max-2 image rules.
 */
async function bindRowToIntake(
  ctx: MutationCtx,
  row: MediaDoc,
  intake: Doc<"lineCaptureIntakes">,
  rawImageSet: unknown,
  now: number,
  scheduleStage: boolean,
): Promise<MediaDoc> {
  const existingRows = (await listIntakeMediaRows(ctx, intake._id)).filter(
    item => item._id !== row._id && item.state !== "withdrawn" && item.state !== "expired",
  );

  let warningCode: IntakeMediaWarningCode | undefined;
  let blockSet = false;
  let blockImageSetId: string | undefined;

  if (row.fileType === "file") {
    warningCode = "UNSUPPORTED_FILE_PDF";
  } else if (row.fileType !== "image") {
    warningCode = "UNSUPPORTED_MEDIA_TYPE";
  } else if (row.contentProvider === "external") {
    warningCode = "MEDIA_EXTERNAL_UNSUPPORTED";
  } else if (row.imageSetInvalid) {
    warningCode = "IMAGE_SET_METADATA_INCOMPLETE";
    blockSet = true;
    blockImageSetId = row.imageSetId;
  } else {
    const parsedSet = rawImageSet !== undefined
      ? parseLineImageSet(rawImageSet)
      : row.imageSetId !== undefined
        ? parseLineImageSet({ id: row.imageSetId, index: row.imageSetIndex, total: row.imageSetTotal })
        : { kind: "none" as const };

    if (parsedSet.kind === "invalid") {
      warningCode = parsedSet.warning;
      blockSet = true;
      blockImageSetId = parsedSet.rawId;
    } else if (parsedSet.kind === "overflow") {
      warningCode = parsedSet.warning;
      blockSet = true;
      blockImageSetId = parsedSet.id;
    } else if (parsedSet.kind === "valid") {
      const sameSet = existingRows.filter(item => item.imageSetId === parsedSet.id);
      const conflict = sameSet.some(
        item => item.imageSetTotal !== parsedSet.total || item.imageSetIndex === parsedSet.index,
      );
      if (conflict) {
        warningCode = "IMAGE_SET_METADATA_INCOMPLETE";
        blockSet = true;
        blockImageSetId = parsedSet.id;
      } else if (sameSet.some(item => item.warningCode === "IMAGE_SET_OVERFLOW" || item.warningCode === "IMAGE_SET_METADATA_INCOMPLETE")) {
        warningCode = sameSet.find(item => item.warningCode)?.warningCode ?? "IMAGE_SET_METADATA_INCOMPLETE";
      }
    }

    if (!warningCode) {
      const existingImages = existingRows.filter(item => item.fileType === "image");
      if (existingImages.some(item => item.warningCode === "MEDIA_COUNT_LIMIT_EXCEEDED" || item.warningCode === "IMAGE_SET_OVERFLOW")) {
        warningCode = existingImages.find(item => item.warningCode)?.warningCode ?? "MEDIA_COUNT_LIMIT_EXCEEDED";
      } else if (existingImages.length >= LINE_CAPTURE_MAX_IMAGES) {
        warningCode = "MEDIA_COUNT_LIMIT_EXCEEDED";
        blockSet = true;
      }
    }
  }

  const expiresAt = Math.min(row.expiresAt, intake.createdAt + LINE_CAPTURE_STAGING_TTL_MS);
  if (warningCode) {
    await ctx.db.patch(row._id, {
      intakeId: intake._id,
      intakeRevision: intake.revision,
      state: "warning",
      warningCode,
      expiresAt,
      matchUntil: undefined,
      leaseId: undefined,
      leaseExpiresAt: undefined,
      updatedAt: now,
    });
    if (blockSet) {
      await blockIntakeMediaSet(ctx, intake._id, warningCode, now, {
        imageSetId: blockImageSetId,
        excludeMediaId: row._id,
      });
    } else {
      await flagCaptureWarning(ctx, intake._id, warningCode);
    }
    return (await ctx.db.get(row._id))!;
  }

  await ctx.db.patch(row._id, {
    intakeId: intake._id,
    intakeRevision: intake.revision,
    state: "pending",
    expiresAt,
    matchUntil: undefined,
    availableAt: now,
    updatedAt: now,
  });
  if (scheduleStage) {
    await ctx.scheduler.runAfter(0, internal.line_capture_media.stage, { mediaId: row._id });
  }
  return (await ctx.db.get(row._id))!;
}

/**
 * Durable intake of signed LINE media webhook events.
 * Handles immediate matching, bounded durable retry for image-before-text,
 * ambiguity warnings, and upstream imageSet/fileType validation.
 */
export async function ingestCaptureMediaEvents(
  ctx: MutationCtx,
  input: { botId: Id<"lineBots">; events: LineCaptureMediaEvent[]; now?: number; schedule?: boolean },
): Promise<Array<{ mediaId: MediaId; state: MediaDoc["state"]; warningCode?: IntakeMediaWarningCode; created: boolean }>> {
  const now = input.now ?? Date.now();
  const schedule = input.schedule ?? true;
  if (!input.events.length || !lineCaptureEnabled()) return [];

  const bot = await ctx.db.get(input.botId);
  if (!bot || !captureBot(bot) || !await admittedLineProject(ctx, bot.projectId)) return [];

  const results: Array<{ mediaId: MediaId; state: MediaDoc["state"]; warningCode?: IntakeMediaWarningCode; created: boolean }> = [];

  for (const event of input.events) {
    if (event.timestamp < now - LINE_CAPTURE_STAGING_TTL_MS || event.timestamp > now + FUTURE_SKEW_MS) continue;
    const enrollment = await captureEnrollment(ctx, {
      botId: bot._id,
      lineChatId: event.lineChatId,
      timestamp: event.timestamp,
    });
    if (!enrollment || enrollment.chat.kind !== event.kind) continue;
    if (await captureMessageUnsent(ctx, bot._id, event.lineChatId, event.messageId, event.senderDigest)) continue;

    const existingByMsg = await ctx.db.query("intakeMedia")
      .withIndex("by_bot_message", q => q.eq("botId", bot._id).eq("messageId", event.messageId))
      .unique();
    if (existingByMsg) {
      results.push({ mediaId: existingByMsg._id, state: existingByMsg.state, warningCode: existingByMsg.warningCode, created: false });
      continue;
    }
    const existingByEvent = await ctx.db.query("intakeMedia")
      .withIndex("by_bot_event", q => q.eq("botId", bot._id).eq("webhookEventId", event.webhookEventId))
      .unique();
    if (existingByEvent) {
      results.push({ mediaId: existingByEvent._id, state: existingByEvent.state, warningCode: existingByEvent.warningCode, created: false });
      continue;
    }

    const parsedSet = event.imageSetInvalid
      ? { kind: "invalid" as const, warning: "IMAGE_SET_METADATA_INCOMPLETE" as const }
      : parseLineImageSet(event.imageSet);
    const imageSetFields = parsedSet.kind === "valid" || parsedSet.kind === "overflow"
      ? { imageSetId: parsedSet.id, imageSetIndex: parsedSet.index, imageSetTotal: parsedSet.total }
      : parsedSet.kind === "invalid"
        ? { ...(parsedSet.rawId ? { imageSetId: parsedSet.rawId } : {}), imageSetInvalid: true }
        : {};

    const matchUntil = Math.min(now, event.timestamp) + LINE_CAPTURE_WINDOW_MS + 10_000;
    const mediaId = await ctx.db.insert("intakeMedia", {
      projectId: enrollment.project._id,
      botId: bot._id,
      chatId: enrollment.chat._id,
      lineChatId: enrollment.chat.lineChatId,
      joinedAt: enrollment.chat.joinedAt,
      senderDigest: event.senderDigest,
      messageId: event.messageId,
      webhookEventId: event.webhookEventId,
      messageTimestamp: event.timestamp,
      fileType: event.fileType,
      ...(event.contentProvider ? { contentProvider: event.contentProvider } : {}),
      source: bot.lineUserId.startsWith("Ufixture-") ? "fixture" : "line",
      ...imageSetFields,
      state: "unmatched",
      discarded: [],
      matchAttempt: 0,
      matchUntil,
      attempt: 0,
      availableAt: now,
      expiresAt: now + LINE_CAPTURE_STAGING_TTL_MS,
      createdAt: now,
      updatedAt: now,
    });

    const row = (await ctx.db.get(mediaId))!;
    const match = await matchIntakeWindow(ctx, {
      botId: bot._id,
      chatId: enrollment.chat._id,
      joinedAt: enrollment.chat.joinedAt,
      senderDigest: event.senderDigest,
      timestamp: event.timestamp,
    }, now);

    if (match.kind === "matched") {
      const bound = await bindRowToIntake(ctx, row, match.intake, event.imageSet, now, schedule);
      results.push({ mediaId, state: bound.state, warningCode: bound.warningCode, created: true });
    } else if (match.kind === "ambiguous") {
      await ctx.db.patch(mediaId, {
        state: "warning",
        warningCode: "MEDIA_MATCH_AMBIGUOUS",
        matchUntil: undefined,
        updatedAt: now,
      });
      for (const candidate of match.intakes) {
        await flagCaptureWarning(ctx, candidate._id, "MEDIA_MATCH_AMBIGUOUS");
      }
      results.push({ mediaId, state: "warning", warningCode: "MEDIA_MATCH_AMBIGUOUS", created: true });
    } else {
      // Image arrived before text mention: schedule bounded durable retry.
      if (schedule) {
        const delay = MATCH_RETRY_DELAYS_MS[0];
        await ctx.db.patch(mediaId, { availableAt: now + delay });
        await ctx.scheduler.runAfter(delay, internal.line_capture_media.retryMatch, { mediaId });
      }
      results.push({ mediaId, state: "unmatched", created: true });
    }
  }

  return results;
}

/**
 * Bounded durable retry for image-before-text events waiting for a mention webhook.
 */
export async function retryMatchCaptureMedia(
  ctx: MutationCtx,
  input: { mediaId: MediaId; now?: number; schedule?: boolean },
): Promise<{ state: MediaDoc["state"]; matched: boolean; warningCode?: IntakeMediaWarningCode }> {
  const now = input.now ?? Date.now();
  const schedule = input.schedule ?? true;
  const row = await ctx.db.get(input.mediaId);
  if (!row || row.state !== "unmatched") {
    return { state: row?.state ?? "expired", matched: false, warningCode: row?.warningCode };
  }

  if (await captureMessageUnsent(ctx, row.botId, row.lineChatId, row.messageId, row.senderDigest)) {
    await ctx.db.patch(row._id, { state: "withdrawn", withdrawnAt: now, matchUntil: undefined, updatedAt: now });
    return { state: "withdrawn", matched: false };
  }

  const enrollment = await captureEnrollment(ctx, {
    botId: row.botId,
    lineChatId: row.lineChatId,
    timestamp: row.messageTimestamp,
  });
  if (!enrollment || enrollment.chat._id !== row.chatId || enrollment.chat.joinedAt !== row.joinedAt
    || row.expiresAt <= now) {
    await ctx.db.patch(row._id, { state: "expired", matchUntil: undefined, updatedAt: now });
    return { state: "expired", matched: false };
  }

  const match = await matchIntakeWindow(ctx, {
    botId: row.botId,
    chatId: row.chatId,
    joinedAt: row.joinedAt,
    senderDigest: row.senderDigest,
    timestamp: row.messageTimestamp,
  }, now);

  if (match.kind === "matched") {
    const rawSet = row.imageSetId !== undefined
      ? { id: row.imageSetId, index: row.imageSetIndex, total: row.imageSetTotal }
      : undefined;
    const bound = await bindRowToIntake(ctx, row, match.intake, rawSet, now, schedule);
    return { state: bound.state, matched: true, warningCode: bound.warningCode };
  }

  if (match.kind === "ambiguous") {
    await ctx.db.patch(row._id, {
      state: "warning",
      warningCode: "MEDIA_MATCH_AMBIGUOUS",
      matchUntil: undefined,
      updatedAt: now,
    });
    for (const candidate of match.intakes) {
      await flagCaptureWarning(ctx, candidate._id, "MEDIA_MATCH_AMBIGUOUS");
    }
    return { state: "warning", matched: false, warningCode: "MEDIA_MATCH_AMBIGUOUS" };
  }

  const nextAttempt = (row.matchAttempt ?? 0) + 1;
  const deadline = row.matchUntil ?? row.messageTimestamp + LINE_CAPTURE_WINDOW_MS;
  if (now >= deadline || nextAttempt >= MATCH_RETRY_DELAYS_MS.length) {
    await ctx.db.patch(row._id, { state: "expired", matchAttempt: nextAttempt, matchUntil: undefined, updatedAt: now });
    return { state: "expired", matched: false };
  }

  const delay = Math.min(MATCH_RETRY_DELAYS_MS[nextAttempt], Math.max(500, deadline - now));
  await ctx.db.patch(row._id, { matchAttempt: nextAttempt, availableAt: now + delay, updatedAt: now });
  if (schedule) {
    await ctx.scheduler.runAfter(delay, internal.line_capture_media.retryMatch, { mediaId: row._id });
  }
  return { state: "unmatched", matched: false };
}

/** A later webhook may introduce a second matching mention after staging. */
async function stillMatches(ctx: DbCtx, row: MediaDoc, now: number) {
  const match = await matchIntakeWindow(ctx, { botId: row.botId, chatId: row.chatId, joinedAt: row.joinedAt,
    senderDigest: row.senderDigest, timestamp: row.messageTimestamp }, now);
  return match.kind === "matched" && match.intake._id === row.intakeId;
}

/**
 * Checks capture authority, intake, bot and unsend fence for a bound media row.
 * A later second mention from an otherwise authorized source returns `ambiguous`.
 */
async function checkMediaAuthority(ctx: DbCtx, row: MediaDoc, now: number): Promise<
  | { kind: "authorized"; intake: Doc<"lineCaptureIntakes">; bot: Doc<"lineBots"> }
  | { kind: "ambiguous"; intakes: Doc<"lineCaptureIntakes">[] }
  | null
> {
  if (!row.intakeId || !lineCaptureEnabled()) return null;
  if (row.withdrawnAt !== undefined || row.expiresAt <= now) return null;
  if (await captureMessageUnsent(ctx, row.botId, row.lineChatId, row.messageId, row.senderDigest)) return null;
  const intake = await currentCaptureIntake(ctx, row.intakeId, now);
  if (!intake || intake.projectId !== row.projectId || intake.botId !== row.botId
    || intake.chatId !== row.chatId || intake.joinedAt !== row.joinedAt) return null;
  const bot = await ctx.db.get(row.botId);
  if (!bot || !captureBot(bot) || bot.projectId !== row.projectId) return null;
  const match = await matchIntakeWindow(ctx, { botId: row.botId, chatId: row.chatId, joinedAt: row.joinedAt,
    senderDigest: row.senderDigest, timestamp: row.messageTimestamp }, now);
  if (match.kind === "ambiguous") return { kind: "ambiguous", intakes: match.intakes };
  if (match.kind !== "matched" || match.intake._id !== row.intakeId) return null;
  return { kind: "authorized", intake, bot };
}

async function verifyMediaAuthority(ctx: DbCtx, row: MediaDoc, now: number) {
  const auth = await checkMediaAuthority(ctx, row, now);
  return auth?.kind === "authorized" ? auth : null;
}

/** Keeps a leased row private as a staff warning on every candidate intake. */
async function markMediaAmbiguous(ctx: MutationCtx, row: MediaDoc, intakes: Doc<"lineCaptureIntakes">[], now: number) {
  await ctx.db.patch(row._id, {
    state: "warning",
    warningCode: "MEDIA_MATCH_AMBIGUOUS",
    leaseId: undefined,
    leaseExpiresAt: undefined,
    updatedAt: now,
  });
  for (const intake of intakes) await flagCaptureWarning(ctx, intake._id, "MEDIA_MATCH_AMBIGUOUS");
}

/** Claims a fenced lease for bounded media download and staging. */
export async function claimMediaForStaging(
  ctx: MutationCtx,
  input: { mediaId: MediaId; now?: number; scheduleRecovery?: boolean },
) {
  const now = input.now ?? Date.now();
  const row = await ctx.db.get(input.mediaId);
  if (!row || (row.state !== "pending" && row.state !== "staging")) return null;
  if (row.availableAt > now || (row.leaseExpiresAt ?? 0) > now) return null;

  if (await captureMessageUnsent(ctx, row.botId, row.lineChatId, row.messageId, row.senderDigest)) {
    await ctx.db.patch(row._id, { state: "withdrawn", withdrawnAt: now, leaseId: undefined, leaseExpiresAt: undefined, updatedAt: now });
    return null;
  }
  if (row.expiresAt <= now) {
    await ctx.db.patch(row._id, { state: "expired", leaseId: undefined, leaseExpiresAt: undefined, updatedAt: now });
    return null;
  }

  const auth = await checkMediaAuthority(ctx, row, now);
  if (auth?.kind === "ambiguous") {
    await markMediaAmbiguous(ctx, row, auth.intakes, now);
    return null;
  }
  if (!auth) {
    await ctx.db.patch(row._id, { state: "withdrawn", withdrawnAt: now, leaseId: undefined, leaseExpiresAt: undefined, updatedAt: now });
    return null;
  }

  const attempt = row.attempt + 1;
  if (attempt > MEDIA_MAX_ATTEMPTS) {
    await ctx.db.patch(row._id, {
      state: "warning",
      warningCode: "MEDIA_DOWNLOAD_UNAVAILABLE",
      attempt,
      leaseId: undefined,
      leaseExpiresAt: undefined,
      updatedAt: now,
    });
    await flagCaptureWarning(ctx, auth.intake._id, "MEDIA_DOWNLOAD_UNAVAILABLE");
    return null;
  }

  const leaseId = crypto.randomUUID();
  const leaseExpiresAt = now + MEDIA_LEASE_MS;
  await ctx.db.patch(row._id, {
    state: "staging",
    attempt,
    leaseId,
    leaseExpiresAt,
    updatedAt: now,
  });
  if (input.scheduleRecovery !== false) {
    await ctx.scheduler.runAfter(MEDIA_LEASE_MS, internal.line_capture_media.stage, { mediaId: row._id });
  }
  return {
    mediaId: row._id,
    messageId: row.messageId,
    tokenCipher: auth.bot.tokenCipher,
    leaseId,
    attempt,
  };
}

/** Rechecks active lease, signed authority, unsend fence and tokenCipher immediately before fetching bytes. */
export async function authorizeMediaFetch(
  ctx: QueryCtx,
  input: { mediaId: MediaId; leaseId: string; tokenCipher: string; now?: number },
): Promise<boolean> {
  const now = input.now ?? Date.now();
  const row = await ctx.db.get(input.mediaId);
  if (!row || row.state !== "staging" || row.leaseId !== input.leaseId || (row.leaseExpiresAt ?? 0) <= now) {
    return false;
  }
  const auth = await verifyMediaAuthority(ctx, row, now);
  return auth?.bot.tokenCipher === input.tokenCipher;
}

/** Sums staged byte sizes for other ready rows in the same intake. */
async function otherIntakeMediaBytes(ctx: DbCtx, intakeId: Id<"lineCaptureIntakes">, excludeId: MediaId): Promise<number> {
  const rows = await listIntakeMediaRows(ctx, intakeId);
  let total = 0;
  for (const row of rows) {
    if (row._id === excludeId) continue;
    if (row.state === "ready" && row.size) total += row.size;
  }
  return total;
}

/**
 * Reserves a private write marker BEFORE storing bytes in Convex `_storage`.
 * Also enforces the 8 MiB combined intake budget (blocking the set with a warning
 * rather than silently keeping a partial subset).
 */
export async function reserveMediaWrite(
  ctx: MutationCtx,
  input: {
    mediaId: MediaId;
    leaseId: string;
    sha256: string;
    size: number;
    contentType: IntakeMediaContentType;
    now?: number;
  },
): Promise<
  | { ok: true; marker: string; writeContentType: string }
  | { ok: false; code: string }
> {
  const now = input.now ?? Date.now();
  const row = await ctx.db.get(input.mediaId);
  if (!row || row.state !== "staging" || row.leaseId !== input.leaseId || (row.leaseExpiresAt ?? 0) <= now) {
    return { ok: false, code: "LEASE_EXPIRED" };
  }
  if (!/^[0-9a-f]{64}$/.test(input.sha256) || !Number.isSafeInteger(input.size) || input.size <= 0) {
    return { ok: false, code: "MEDIA_MALFORMED" };
  }

  const auth = await checkMediaAuthority(ctx, row, now);
  if (auth?.kind === "ambiguous") {
    await markMediaAmbiguous(ctx, row, auth.intakes, now);
    return { ok: false, code: "MEDIA_MATCH_AMBIGUOUS" };
  }
  if (!auth) return { ok: false, code: "AUTHORITY_REVOKED" };

  const otherBytes = await otherIntakeMediaBytes(ctx, auth.intake._id, row._id);
  if (input.size > LINE_CAPTURE_MAX_TOTAL_BYTES || otherBytes + input.size > LINE_CAPTURE_MAX_TOTAL_BYTES) {
    await ctx.db.patch(row._id, {
      state: "warning",
      warningCode: "MEDIA_SIZE_LIMIT_EXCEEDED",
      leaseId: undefined,
      leaseExpiresAt: undefined,
      updatedAt: now,
    });
    await blockIntakeMediaSet(ctx, auth.intake._id, "MEDIA_SIZE_LIMIT_EXCEEDED", now, { excludeMediaId: row._id });
    return { ok: false, code: "MEDIA_SIZE_LIMIT_EXCEEDED" };
  }

  const open = row.writes ?? [];
  if (open.length >= MAX_OPEN_WRITES) return { ok: false, code: "MEDIA_WRITE_BUSY" };

  const marker = makeWriteMarker();
  const write: IntakeMediaWrite = {
    marker,
    sha256: input.sha256,
    size: input.size,
    contentType: input.contentType,
    claimedAt: now,
    scannedTo: now - 1_000,
  };
  await ctx.db.patch(row._id, {
    writes: [...open, write],
    writeCheckAt: row.writeCheckAt ?? now + MEDIA_WRITE_WINDOW_MS,
    updatedAt: now,
  });
  return { ok: true, marker, writeContentType: mediaWriteType(marker) };
}

/**
 * Records a stored blob against its reservation.
 * Ownership is ALWAYS recorded: if the lease expired, the message was unsent,
 * the row expired, authority ended, or the 8 MiB cap was exceeded concurrently,
 * the blob is added to `discarded` (never exposed and never leaving an unowned orphan).
 */
export async function recordStagedMedia(
  ctx: MutationCtx,
  input: {
    mediaId: MediaId;
    leaseId: string;
    marker: string;
    sha256: string;
    size: number;
    contentType: IntakeMediaContentType;
    width: number;
    height: number;
    storageId: Id<"_storage">;
    now?: number;
  },
): Promise<{ settled: boolean; state: MediaDoc["state"] }> {
  const now = input.now ?? Date.now();
  const row = await ctx.db.get(input.mediaId);
  if (!row) throw new Error("MEDIA_UNAVAILABLE");

  // Reconciliation may already have recorded this exact blob.
  if (row.storageId === input.storageId || row.discarded.includes(input.storageId)) {
    return { settled: row.storageId === input.storageId && row.state === "ready", state: row.state };
  }

  const open = row.writes ?? [];
  const write = open.find(item => item.marker === input.marker);
  const blob = write ? await ctx.db.system.get("_storage", input.storageId) : null;
  const owned = !!write
    && !!blob
    && blob.contentType === mediaWriteType(write.marker)
    && blob.size === write.size
    && blob.sha256 === hexToBase64(write.sha256);

  // Never adopt or mark an unverified/unowned storageId for deletion.
  if (!owned) {
    return { settled: false, state: row.state };
  }

  const remaining = open.filter(item => item.marker !== input.marker);
  const writeClaim = { writes: remaining, writeCheckAt: remaining.length ? row.writeCheckAt : undefined };

  const unsent = await captureMessageUnsent(ctx, row.botId, row.lineChatId, row.messageId, row.senderDigest);
  const checked = !unsent ? await checkMediaAuthority(ctx, row, now) : null;
  const auth = checked?.kind === "authorized" ? checked : null;
  const otherBytes = auth ? await otherIntakeMediaBytes(ctx, auth.intake._id, row._id) : 0;
  const sizeExceeded = write.size > LINE_CAPTURE_MAX_TOTAL_BYTES || otherBytes + write.size > LINE_CAPTURE_MAX_TOTAL_BYTES;
  const leaseHeld = row.state === "staging" && row.leaseId === input.leaseId && (row.leaseExpiresAt ?? 0) > now;
  const ambiguous = leaseHeld && checked?.kind === "ambiguous" ? checked.intakes : null;

  const settleable = leaseHeld
    && !unsent
    && row.expiresAt > now
    && !!auth
    && !sizeExceeded
    && input.size === write.size
    && input.sha256 === write.sha256
    && input.contentType === write.contentType;

  if (ambiguous) {
    await ctx.db.patch(row._id, {
      ...writeClaim,
      discarded: discardedWith(row.discarded, input.storageId),
      reclaimAfter: row.reclaimAfter ?? now,
    });
    await markMediaAmbiguous(ctx, row, ambiguous, now);
    return { settled: false, state: "warning" };
  }

  if (!settleable) {
    const discarded = discardedWith(row.discarded, input.storageId);
    const nextState: MediaDoc["state"] =
      unsent ? "withdrawn"
        : row.expiresAt <= now && !isTerminalState(row.state) ? "expired"
          : sizeExceeded && row.state === "staging" && row.leaseId === input.leaseId ? "warning"
            : row.state;
    await ctx.db.patch(row._id, {
      ...writeClaim,
      discarded,
      reclaimAfter: row.reclaimAfter ?? now,
      ...(nextState !== row.state ? {
        state: nextState,
        ...(nextState === "withdrawn" ? { withdrawnAt: row.withdrawnAt ?? now } : {}),
        ...(nextState === "warning" ? { warningCode: "MEDIA_SIZE_LIMIT_EXCEEDED" as const } : {}),
        leaseId: undefined,
        leaseExpiresAt: undefined,
      } : {}),
      updatedAt: now,
    });
    if (sizeExceeded && auth && row.state === "staging" && row.leaseId === input.leaseId) {
      await blockIntakeMediaSet(ctx, auth.intake._id, "MEDIA_SIZE_LIMIT_EXCEEDED", now, { excludeMediaId: row._id });
    }
    return { settled: false, state: nextState };
  }

  await ctx.db.patch(row._id, {
    ...writeClaim,
    state: "ready",
    storageId: input.storageId,
    contentType: write.contentType,
    sha256: write.sha256,
    size: write.size,
    width: input.width,
    height: input.height,
    intakeRevision: auth!.intake.revision,
    stagedAt: now,
    leaseId: undefined,
    leaseExpiresAt: undefined,
    updatedAt: now,
  });
  return { settled: true, state: "ready" };
}

/** Records a validation or upstream warning under an active lease (late calls ignored). */
export async function recordMediaWarning(
  ctx: MutationCtx,
  input: {
    mediaId: MediaId;
    leaseId: string;
    warningCode: IntakeMediaWarningCode;
    blockIntakeSet?: boolean;
    now?: number;
  },
): Promise<boolean> {
  const now = input.now ?? Date.now();
  const row = await ctx.db.get(input.mediaId);
  if (!row || row.state !== "staging" || row.leaseId !== input.leaseId || (row.leaseExpiresAt ?? 0) <= now) {
    return false;
  }
  if (await captureMessageUnsent(ctx, row.botId, row.lineChatId, row.messageId, row.senderDigest)) {
    await ctx.db.patch(row._id, { state: "withdrawn", withdrawnAt: now, leaseId: undefined, leaseExpiresAt: undefined, updatedAt: now });
    return false;
  }
  await ctx.db.patch(row._id, {
    state: "warning",
    warningCode: input.warningCode,
    leaseId: undefined,
    leaseExpiresAt: undefined,
    updatedAt: now,
  });
  if (row.intakeId) {
    if (input.blockIntakeSet) {
      await blockIntakeMediaSet(ctx, row.intakeId, input.warningCode, now, { excludeMediaId: row._id });
    } else {
      await flagCaptureWarning(ctx, row.intakeId, input.warningCode);
    }
  }
  return true;
}

/** Handles transient download errors under an active lease with bounded retry. */
export async function failMediaAttempt(
  ctx: MutationCtx,
  input: { mediaId: MediaId; leaseId: string; now?: number; scheduleRetry?: boolean },
): Promise<void> {
  const now = input.now ?? Date.now();
  const row = await ctx.db.get(input.mediaId);
  if (!row || row.state !== "staging" || row.leaseId !== input.leaseId || (row.leaseExpiresAt ?? 0) <= now) return;

  if (row.attempt < MEDIA_MAX_ATTEMPTS && row.expiresAt > now) {
    const backoff = 5_000 * row.attempt;
    await ctx.db.patch(row._id, {
      state: "pending",
      availableAt: now + backoff,
      leaseId: undefined,
      leaseExpiresAt: undefined,
      updatedAt: now,
    });
    if (input.scheduleRetry !== false) {
      await ctx.scheduler.runAfter(backoff, internal.line_capture_media.stage, { mediaId: row._id });
    }
    return;
  }

  await ctx.db.patch(row._id, {
    state: "warning",
    warningCode: "MEDIA_DOWNLOAD_UNAVAILABLE",
    leaseId: undefined,
    leaseExpiresAt: undefined,
    updatedAt: now,
  });
  if (row.intakeId) await flagCaptureWarning(ctx, row.intakeId, "MEDIA_DOWNLOAD_UNAVAILABLE");
}

/**
 * Resolves unrecorded writes from `_storage` metadata using the exact private marker,
 * size and SHA-256. Never touches or deletes unowned blobs.
 */
export async function reconcileMediaWrites(ctx: MutationCtx, mediaId: MediaId, now = Date.now()) {
  const row = await ctx.db.get(mediaId);
  const writes = row?.writes ?? [];
  if (!row || writes.length === 0) return row;

  const settled = now - MEDIA_WRITE_SETTLE_MS;
  const from = Math.min(...writes.map(write => write.scannedTo));
  const until = Math.min(now, Math.max(...writes.map(write => write.claimedAt + MEDIA_WRITE_WINDOW_MS)));
  const blobs = await ctx.db.system.query("_storage")
    .withIndex("by_creation_time", q => q.gt("_creationTime", from).lte("_creationTime", until))
    .take(MEDIA_WRITE_SCAN);

  const complete = blobs.length < MEDIA_WRITE_SCAN;
  const reached = complete ? Math.min(until, settled) : blobs[blobs.length - 1]._creationTime;
  const byType = new Map(blobs.flatMap(blob => blob.contentType ? [[blob.contentType, blob] as const] : []));

  let storageId = row.storageId;
  let state = row.state;
  let sha256 = row.sha256;
  let size = row.size;
  let contentType = row.contentType;
  let stagedAt = row.stagedAt;
  const discarded = [...row.discarded];
  const remaining: IntakeMediaWrite[] = [];

  const auth = state === "staging" ? await verifyMediaAuthority(ctx, row, now) : null;
  const otherBytes = auth ? await otherIntakeMediaBytes(ctx, auth.intake._id, row._id) : 0;

  for (const write of writes) {
    const blob = byType.get(mediaWriteType(write.marker));
    const windowEnd = write.claimedAt + MEDIA_WRITE_WINDOW_MS;
    if (!blob) {
      if (reached < windowEnd) remaining.push({ ...write, scannedTo: Math.max(write.scannedTo, reached) });
      continue;
    }
    if (storageId === blob._id || discarded.includes(blob._id)) continue;

    const validBlob = blob.size === write.size && blob.sha256 === hexToBase64(write.sha256);
    const usable = validBlob
      && state === "staging"
      && !storageId
      && !!auth
      && otherBytes + write.size <= LINE_CAPTURE_MAX_TOTAL_BYTES;

    if (usable) {
      storageId = blob._id;
      state = "ready";
      sha256 = write.sha256;
      size = write.size;
      contentType = write.contentType;
      stagedAt = now;
    } else {
      discarded.push(blob._id);
    }
  }

  await ctx.db.patch(row._id, {
    state,
    storageId,
    sha256,
    size,
    contentType,
    stagedAt,
    discarded,
    writes: remaining,
    writeCheckAt: remaining.length ? now + 60_000 : undefined,
    ...(state === "ready" ? { leaseId: undefined, leaseExpiresAt: undefined } : {}),
    ...(discarded.length > row.discarded.length ? { reclaimAfter: row.reclaimAfter ?? now } : {}),
    updatedAt: now,
  });
  return (await ctx.db.get(row._id))!;
}

export async function reconcileDueMediaWrites(ctx: MutationCtx, now = Date.now()): Promise<number> {
  const rows = await ctx.db
    .query("intakeMedia")
    .withIndex("by_write_check", q => q.gte("writeCheckAt", 0).lte("writeCheckAt", now))
    .take(MEDIA_SWEEP_LIMIT);
  for (const row of rows) await reconcileMediaWrites(ctx, row._id, now);
  return rows.length;
}

/** Immediately hides media for an unsent message and marks blobs for gated/fixture reclaim. */
export async function withdrawMediaByMessage(
  ctx: MutationCtx,
  input: { botId: Id<"lineBots">; messageId: string; now?: number },
): Promise<{ withdrawn: boolean; mediaId?: MediaId }> {
  const now = input.now ?? Date.now();
  const row = await ctx.db.query("intakeMedia")
    .withIndex("by_bot_message", q => q.eq("botId", input.botId).eq("messageId", input.messageId))
    .unique();
  if (!row) return { withdrawn: false };
  if (row.state === "withdrawn") return { withdrawn: false, mediaId: row._id };
  const hasBlobs = !!row.storageId || row.discarded.length > 0;
  await ctx.db.patch(row._id, {
    state: "withdrawn",
    withdrawnAt: row.withdrawnAt ?? now,
    leaseId: undefined,
    leaseExpiresAt: undefined,
    matchUntil: undefined,
    ...(hasBlobs ? { reclaimAfter: row.reclaimAfter ?? now } : {}),
    updatedAt: now,
  });
  return { withdrawn: true, mediaId: row._id };
}

/** Immediately hides all media for a withdrawn intake. */
export async function withdrawMediaForIntake(
  ctx: MutationCtx,
  input: { intakeId: Id<"lineCaptureIntakes">; now?: number },
): Promise<{ withdrawnCount: number }> {
  const now = input.now ?? Date.now();
  const rows = await listIntakeMediaRows(ctx, input.intakeId);
  let withdrawnCount = 0;
  for (const row of rows) {
    if (row.state === "withdrawn") continue;
    const hasBlobs = !!row.storageId || row.discarded.length > 0;
    await ctx.db.patch(row._id, {
      state: "withdrawn",
      withdrawnAt: row.withdrawnAt ?? now,
      leaseId: undefined,
      leaseExpiresAt: undefined,
      matchUntil: undefined,
      ...(hasBlobs ? { reclaimAfter: row.reclaimAfter ?? now } : {}),
      updatedAt: now,
    });
    withdrawnCount++;
  }
  return { withdrawnCount };
}

/**
 * Expiry sweep: marks expired rows as `expired` and syncs unsent/withdrawn active rows
 * to `withdrawn`. Never deletes storage blobs itself.
 */
export async function expireStagedMedia(
  ctx: MutationCtx,
  options?: { now?: number; limit?: number },
): Promise<{ expired: number; withdrawn: number }> {
  const now = options?.now ?? Date.now();
  const limit = Math.max(1, Math.min(Math.trunc(options?.limit ?? MEDIA_SWEEP_LIMIT) || MEDIA_SWEEP_LIMIT, 100));
  let expired = 0;
  let withdrawn = 0;

  for (const state of ["unmatched", "pending", "staging", "ready"] as const) {
    const due = await ctx.db.query("intakeMedia")
      .withIndex("by_state_expires", q => q.eq("state", state).lte("expiresAt", now))
      .take(limit);
    for (const row of due) {
      const hasBlobs = !!row.storageId || row.discarded.length > 0;
      await ctx.db.patch(row._id, {
        state: "expired",
        leaseId: undefined,
        leaseExpiresAt: undefined,
        matchUntil: undefined,
        ...(hasBlobs ? { reclaimAfter: row.reclaimAfter ?? now } : {}),
        updatedAt: now,
      });
      expired++;
    }
  }

  // Also sweep active ready rows whose message was unsent or intake withdrawn so fixture cleanup can reclaim them.
  const activeReady = await ctx.db.query("intakeMedia")
    .withIndex("by_state_expires", q => q.eq("state", "ready").gt("expiresAt", now))
    .take(limit);
  for (const row of activeReady) {
    const unsent = await captureMessageUnsent(ctx, row.botId, row.lineChatId, row.messageId, row.senderDigest);
    const intake = row.intakeId ? await ctx.db.get(row.intakeId) : null;
    const intakeGone = !intake || intake.state === "withdrawn" || intake.state === "dismissed"
      || intake.unsentAt !== undefined || intake.redactedAt !== undefined;
    if (unsent || intakeGone) {
      const hasBlobs = !!row.storageId || row.discarded.length > 0;
      await ctx.db.patch(row._id, {
        state: "withdrawn",
        withdrawnAt: row.withdrawnAt ?? now,
        leaseId: undefined,
        leaseExpiresAt: undefined,
        ...(hasBlobs ? { reclaimAfter: row.reclaimAfter ?? now } : {}),
        updatedAt: now,
      });
      withdrawn++;
    }
  }

  return { expired, withdrawn };
}

/** Recovers expired staging leases, stuck pending items and due unmatched retries. */
export async function recoverStagedMedia(
  ctx: MutationCtx,
  options?: { now?: number; limit?: number },
): Promise<{ staged: number; retriedMatch: number }> {
  if (!lineCaptureEnabled()) return { staged: 0, retriedMatch: 0 };
  const now = options?.now ?? Date.now();
  const limit = Math.max(1, Math.min(Math.trunc(options?.limit ?? MEDIA_SWEEP_LIMIT) || MEDIA_SWEEP_LIMIT, 50));

  const [waiting, expiredLeases, unmatched] = await Promise.all([
    ctx.db.query("intakeMedia").withIndex("by_state_available", q => q.eq("state", "pending").lte("availableAt", now)).take(limit),
    ctx.db.query("intakeMedia").withIndex("by_state_lease", q => q.eq("state", "staging").lte("leaseExpiresAt", now)).take(limit),
    ctx.db.query("intakeMedia").withIndex("by_state_available", q => q.eq("state", "unmatched").lte("availableAt", now)).take(limit),
  ]);

  let staged = 0;
  for (const row of [...waiting, ...expiredLeases]) {
    if (row.expiresAt <= now) continue;
    await ctx.scheduler.runAfter(0, internal.line_capture_media.stage, { mediaId: row._id });
    staged++;
  }

  let retriedMatch = 0;
  for (const row of unmatched) {
    await ctx.scheduler.runAfter(0, internal.line_capture_media.retryMatch, { mediaId: row._id });
    retriedMatch++;
  }

  return { staged, retriedMatch };
}

/**
 * Fixture-only bounded storage reclaim.
 * Deletes ONLY blobs explicitly recorded on `intakeMedia` rows with `source === "fixture"`.
 * Never touches unowned blobs, never touches non-fixture rows, and honors retention holds.
 * Real media cleanup (UploadThing / MEDIA_CLEANUP_ENABLED) stays disabled in preview.
 */
export async function reclaimFixtureMediaStorage(
  ctx: MutationCtx,
  options?: { now?: number; limit?: number },
): Promise<{ rows: number; deletedBlobs: number }> {
  if (!localFixturesEnabled() || retentionHeld(process.env)) return { rows: 0, deletedBlobs: 0 };
  const now = options?.now ?? Date.now();
  const limit = Math.max(1, Math.min(Math.trunc(options?.limit ?? MEDIA_SWEEP_LIMIT) || MEDIA_SWEEP_LIMIT, 50));

  const due = await ctx.db.query("intakeMedia")
    .withIndex("by_reclaim", q => q.gte("reclaimAfter", 0).lte("reclaimAfter", now))
    .take(limit);

  let rowsReclaimed = 0;
  let deletedBlobs = 0;

  for (const row of due) {
    if (row.source !== "fixture") continue;
    // Wait until any in-flight write claims have settled/reconciled.
    if ((row.writes?.length ?? 0) > 0) continue;

    const terminal = isTerminalState(row.state);
    const remainingDiscarded: Id<"_storage">[] = [];
    let failed = false;

    for (const storageId of row.discarded) {
      try {
        if (await ctx.db.system.get("_storage", storageId)) {
          await ctx.storage.delete(storageId);
          deletedBlobs++;
        }
      } catch {
        remainingDiscarded.push(storageId);
        failed = true;
      }
    }

    let remainingStorageId = row.storageId;
    if (terminal && row.storageId) {
      try {
        if (await ctx.db.system.get("_storage", row.storageId)) {
          await ctx.storage.delete(row.storageId);
          deletedBlobs++;
        }
        remainingStorageId = undefined;
      } catch {
        failed = true;
      }
    }

    const pending = remainingDiscarded.length > 0 || (terminal && remainingStorageId !== undefined);
    await ctx.db.patch(row._id, {
      discarded: remainingDiscarded,
      ...(terminal ? { storageId: remainingStorageId } : {}),
      reclaimAfter: pending ? now + 60_000 : undefined,
      updatedAt: now,
    });
    if (!failed) rowsReclaimed++;
  }

  return { rows: rowsReclaimed, deletedBlobs };
}

export type ResolvedStaffMedia =
  | {
    ok: true;
    storageId: Id<"_storage">;
    contentType: IntakeMediaContentType;
    sha256: string;
    size: number;
    expiresAt: number;
    intakeRevision: number;
  }
  | {
    ok: false;
    status: 400 | 403 | 404 | 409 | 410;
    code: string;
  };

/**
 * Authorizes a private staff bytes fetch: rechecks active project, capture enabled,
 * live intake enrollment, unsend fence, 24h media expiry, and exact source revision.
 */
export async function resolveCapturedMediaForStaff(
  ctx: QueryCtx,
  input: { mediaId: string; expectedRevision?: number; now?: number },
): Promise<ResolvedStaffMedia> {
  const now = input.now ?? Date.now();
  if (!lineCaptureEnabled()) return { ok: false, status: 404, code: "MEDIA_UNAVAILABLE" };

  const normalizedId = ctx.db.normalizeId("intakeMedia", input.mediaId);
  if (!normalizedId) return { ok: false, status: 404, code: "MEDIA_UNAVAILABLE" };
  const row = await ctx.db.get(normalizedId);
  if (!row || !row.intakeId) return { ok: false, status: 404, code: "MEDIA_UNAVAILABLE" };

  const project = await admittedLineProject(ctx, row.projectId);
  if (!project) return { ok: false, status: 404, code: "MEDIA_UNAVAILABLE" };

  const intake = await ctx.db.get(row.intakeId);
  if (!intake || intake.projectId !== row.projectId || intake.botId !== row.botId
    || intake.chatId !== row.chatId || intake.joinedAt !== row.joinedAt) {
    return { ok: false, status: 404, code: "MEDIA_UNAVAILABLE" };
  }

  // Unsend or withdrawal immediately hides bytes even before cleanup runs.
  if (row.state === "withdrawn" || row.withdrawnAt !== undefined
    || intake.state === "withdrawn" || intake.state === "dismissed"
    || intake.unsentAt !== undefined || intake.redactedAt !== undefined
    || await captureMessageUnsent(ctx, row.botId, row.lineChatId, row.messageId, row.senderDigest)) {
    return { ok: false, status: 410, code: "MEDIA_WITHDRAWN" };
  }

  // Linked and unlinked screenshots share the 24-hour staging expiry in rehearsal.
  if (row.state === "expired" || row.expiresAt <= now) {
    return { ok: false, status: 410, code: "MEDIA_EXPIRED" };
  }

  const liveIntake = await currentCaptureIntake(ctx, row.intakeId, now);
  if (!liveIntake || !await stillMatches(ctx, row, now)) return { ok: false, status: 404, code: "MEDIA_UNAVAILABLE" };

  if (input.expectedRevision !== undefined && input.expectedRevision !== liveIntake.revision) {
    return { ok: false, status: 409, code: "MEDIA_REVISION_MISMATCH" };
  }

  if (row.state !== "ready" || !row.storageId || !row.contentType || !row.sha256 || !row.size) {
    return { ok: false, status: 404, code: "MEDIA_UNAVAILABLE" };
  }

  return {
    ok: true,
    storageId: row.storageId,
    contentType: row.contentType,
    sha256: row.sha256,
    size: row.size,
    expiresAt: row.expiresAt,
    intakeRevision: liveIntake.revision,
  };
}

/**
 * Staff UI summary for one intake (including linked intakes within the 24h staging expiry).
 * Never exposes Convex public storage URLs; returns authenticated preview route URLs only.
 */
export async function listIntakeMediaForStaff(
  ctx: QueryCtx,
  input: { intakeId: Id<"lineCaptureIntakes">; now?: number; siteUrl?: string },
): Promise<StaffIntakeMediaSummary | null> {
  const now = input.now ?? Date.now();
  const intake = await ctx.db.get(input.intakeId);
  if (!intake) return null;
  await lineProject(ctx, intake.projectId);
  if (!lineCaptureEnabled()) return null;

  const live = await currentCaptureIntake(ctx, input.intakeId, now);
  if (!live) return null;

  const rows = await listIntakeMediaRows(ctx, input.intakeId);
  const warnings = new Set<IntakeMediaWarningCode>();
  let expiredCount = 0;

  const visible: MediaDoc[] = [];
  for (const row of rows) {
    if (row.state === "withdrawn" || row.withdrawnAt !== undefined) continue;
    if (await captureMessageUnsent(ctx, row.botId, row.lineChatId, row.messageId, row.senderDigest)) continue;
    if (row.state === "expired" || row.expiresAt <= now) {
      expiredCount++;
      continue;
    }
    if (isActiveMediaState(row.state) && !await stillMatches(ctx, row, now)) {
      warnings.add("MEDIA_MATCH_AMBIGUOUS");
      continue;
    }
    if (row.warningCode) warnings.add(row.warningCode);
    if (isActiveMediaState(row.state) || row.state === "warning") {
      visible.push(row);
    }
  }

  visible.sort((a, b) => {
    if (a.imageSetId && b.imageSetId && a.imageSetId === b.imageSetId) {
      const idxDiff = (a.imageSetIndex ?? 0) - (b.imageSetIndex ?? 0);
      if (idxDiff !== 0) return idxDiff;
    }
    if (a.messageTimestamp !== b.messageTimestamp) return a.messageTimestamp - b.messageTimestamp;
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.messageId.localeCompare(b.messageId);
  });

  const items: StaffIntakeMediaItem[] = visible.map((row, idx) => ({
    mediaId: row._id,
    messageId: row.messageId,
    state: row.state as StaffIntakeMediaItem["state"],
    index: row.imageSetIndex ?? idx + 1,
    ...(row.state === "ready" && row.storageId ? {
      url: buildCapturedMediaPreviewUrl(row._id, live.revision, input.siteUrl),
      contentType: row.contentType,
      size: row.size,
      width: row.width,
      height: row.height,
      sha256: row.sha256,
    } : {}),
    expiresAt: row.expiresAt,
    ...(row.warningCode ? { warningCode: row.warningCode } : {}),
    ...(row.imageSetId ? { imageSetId: row.imageSetId } : {}),
    ...(row.imageSetIndex !== undefined ? { imageSetIndex: row.imageSetIndex } : {}),
    ...(row.imageSetTotal !== undefined ? { imageSetTotal: row.imageSetTotal } : {}),
  }));

  const warningList = Array.from(warnings);
  return {
    items,
    warnings: warningList,
    hasWarning: warningList.length > 0,
    expiredCount,
  };
}
