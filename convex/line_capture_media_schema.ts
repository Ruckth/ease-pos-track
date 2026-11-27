import { defineTable } from "convex/server";
import { v, type Infer } from "convex/values";

export const intakeMediaState = v.union(
  v.literal("unmatched"),
  v.literal("pending"),
  v.literal("staging"),
  v.literal("ready"),
  v.literal("warning"),
  v.literal("withdrawn"),
  v.literal("expired"),
);

export const intakeMediaWarningCode = v.union(
  v.literal("IMAGE_SET_OVERFLOW"),
  v.literal("IMAGE_SET_METADATA_INCOMPLETE"),
  v.literal("MEDIA_COUNT_LIMIT_EXCEEDED"),
  v.literal("MEDIA_SIZE_LIMIT_EXCEEDED"),
  v.literal("MEDIA_MATCH_AMBIGUOUS"),
  v.literal("UNSUPPORTED_FILE_PDF"),
  v.literal("UNSUPPORTED_MEDIA_TYPE"),
  v.literal("MEDIA_EXTERNAL_UNSUPPORTED"),
  v.literal("MEDIA_CONTENT_TYPE_MISMATCH"),
  v.literal("MEDIA_MALFORMED"),
  v.literal("MEDIA_PIXEL_LIMIT_EXCEEDED"),
  v.literal("MEDIA_UPSTREAM_EXPIRED"),
  v.literal("MEDIA_DOWNLOAD_UNAVAILABLE"),
);

export const intakeMediaFileType = v.union(
  v.literal("image"),
  v.literal("video"),
  v.literal("file"),
);

export const intakeMediaContentType = v.union(
  v.literal("image/jpeg"),
  v.literal("image/png"),
);

export const intakeMediaSource = v.union(
  v.literal("fixture"),
  v.literal("line"),
);

export const intakeMediaWrite = v.object({
  marker: v.string(),
  sha256: v.string(),
  size: v.number(),
  contentType: intakeMediaContentType,
  claimedAt: v.number(),
  scannedTo: v.number(),
});

export const intakeMediaFields = {
  projectId: v.id("projects"),
  intakeId: v.optional(v.id("lineCaptureIntakes")),
  botId: v.id("lineBots"),
  chatId: v.id("lineChats"),
  lineChatId: v.string(),
  joinedAt: v.number(),
  senderDigest: v.string(),
  messageId: v.string(),
  webhookEventId: v.string(),
  messageTimestamp: v.number(),
  intakeRevision: v.optional(v.number()),
  fileType: intakeMediaFileType,
  contentProvider: v.optional(v.union(v.literal("line"), v.literal("external"))),
  source: intakeMediaSource,
  imageSetId: v.optional(v.string()),
  imageSetIndex: v.optional(v.number()),
  imageSetTotal: v.optional(v.number()),
  imageSetInvalid: v.optional(v.boolean()),
  state: intakeMediaState,
  warningCode: v.optional(intakeMediaWarningCode),
  storageId: v.optional(v.id("_storage")),
  contentType: v.optional(intakeMediaContentType),
  sha256: v.optional(v.string()),
  size: v.optional(v.number()),
  width: v.optional(v.number()),
  height: v.optional(v.number()),
  // Blobs from late settlement, concurrent overflow or reconciliation awaiting gated/fixture reclaim.
  discarded: v.array(v.id("_storage")),
  // Ownership proof issued before each blob is stored; cleared once recorded or reconciled.
  writes: v.optional(v.array(intakeMediaWrite)),
  writeCheckAt: v.optional(v.number()),
  matchAttempt: v.optional(v.number()),
  matchUntil: v.optional(v.number()),
  attempt: v.number(),
  availableAt: v.number(),
  leaseId: v.optional(v.string()),
  leaseExpiresAt: v.optional(v.number()),
  stagedAt: v.optional(v.number()),
  withdrawnAt: v.optional(v.number()),
  expiresAt: v.number(),
  reclaimAfter: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
};

/**
 * Private staged media for LINE capture intakes. Bytes live in Convex File Storage
 * and are served only through the authenticated staff bytes route.
 */
export const lineCaptureMediaTables = {
  intakeMedia: defineTable(intakeMediaFields)
    .index("by_intake", ["intakeId", "createdAt"])
    .index("by_bot_message", ["botId", "messageId"])
    .index("by_bot_event", ["botId", "webhookEventId"])
    .index("by_intake_image_set", ["intakeId", "imageSetId"])
    .index("by_state_available", ["state", "availableAt"])
    .index("by_state_lease", ["state", "leaseExpiresAt"])
    .index("by_state_expires", ["state", "expiresAt"])
    .index("by_write_check", ["writeCheckAt"])
    .index("by_reclaim", ["reclaimAfter"]),
};

export type IntakeMediaState = Infer<typeof intakeMediaState>;
export type IntakeMediaWarningCode = Infer<typeof intakeMediaWarningCode>;
export type IntakeMediaFileType = Infer<typeof intakeMediaFileType>;
export type IntakeMediaContentType = Infer<typeof intakeMediaContentType>;
export type IntakeMediaWrite = Infer<typeof intakeMediaWrite>;

export type StaffIntakeMediaItem = {
  mediaId: string;
  messageId: string;
  state: "pending" | "staging" | "ready" | "warning";
  index: number;
  url?: string;
  contentType?: IntakeMediaContentType;
  size?: number;
  width?: number;
  height?: number;
  sha256?: string;
  expiresAt: number;
  warningCode?: IntakeMediaWarningCode;
  imageSetId?: string;
  imageSetIndex?: number;
  imageSetTotal?: number;
};

export type StaffIntakeMediaSummary = {
  items: StaffIntakeMediaItem[];
  warnings: IntakeMediaWarningCode[];
  hasWarning: boolean;
  expiredCount: number;
};
