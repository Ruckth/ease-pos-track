import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { admittedLineProject } from "./line";
import { readLineAiConnection } from "./line_ai_settings";
import { kind, lineAiFileType } from "../line_schema";
import { retentionHeld } from "../../shared/pilot-settings";

export const LINE_AI_MAX_TEXT_LENGTH = 2000;
export const LINE_AI_MAX_RAW_TEXT_LENGTH = 20_000;
export const LINE_AI_MAX_FILES = 2;
export const LINE_AI_FILE_WINDOW_MS = 2 * 60 * 1000;
export const LINE_AI_INTAKE_TTL_MS = 24 * 60 * 60 * 1000;
export const LINE_AI_DEDUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const LINE_AI_CLEANUP_BATCH = 100;

const baseEventFields = {
  webhookEventId: v.string(),
  timestamp: v.number(),
  kind,
  lineChatId: v.string(),
  messageId: v.string(),
};

export const lineAiInboundEvent = v.union(
  v.object({
    ...baseEventFields,
    eventType: v.literal("text"),
    senderDigest: v.string(),
    text: v.string(),
  }),
  v.object({
    ...baseEventFields,
    eventType: v.literal("file"),
    senderDigest: v.string(),
    fileType: lineAiFileType,
  }),
  v.object({
    ...baseEventFields,
    eventType: v.literal("unsend"),
    senderDigest: v.optional(v.string()),
  }),
);

export type LineAiInboundEvent = Infer<typeof lineAiInboundEvent>;

export type ExtractedLineAiEvent =
  | {
    eventType: "text";
    webhookEventId: string;
    timestamp: number;
    kind: Doc<"lineChats">["kind"];
    lineChatId: string;
    messageId: string;
    senderUserId: string;
    text: string;
  }
  | {
    eventType: "file";
    webhookEventId: string;
    timestamp: number;
    kind: Doc<"lineChats">["kind"];
    lineChatId: string;
    messageId: string;
    senderUserId: string;
    fileType: Infer<typeof lineAiFileType>;
  }
  | {
    eventType: "unsend";
    webhookEventId: string;
    timestamp: number;
    kind: Doc<"lineChats">["kind"];
    lineChatId: string;
    messageId: string;
    senderUserId?: string;
  };

export type LineAiScheduleNotification = {
  intakeId: Id<"lineAiIntakes">;
  availableAt: number;
};

/**
 * Integration seam for parent processor scheduling.
 * Called inside the intake acceptance mutation whenever a new durable intake is
 * created or a follow-up file attaches to a pending intake.
 */
export type LineAiScheduleHook = (
  ctx: MutationCtx,
  notification: LineAiScheduleNotification,
) => Promise<void>;

type DbContext = Pick<QueryCtx, "db">;
type IntakeAuthority = { connectionRevision: number; connectionUpdatedAt: number; projectVisibilityVersion: number };
const encode = new TextEncoder();

/** Assistant intake requires LINE_AI_ENABLED to be strictly "true". */
export function lineAiEnabled(): boolean {
  return process.env.LINE_AI_ENABLED === "true";
}

/** Named-pilot, archived-Project and LINE_AI_ENABLED gate for assistant intake. */
export async function admittedLineAiProject(ctx: DbContext, projectId: Id<"projects">) {
  if (!lineAiEnabled()) return null;
  return admittedLineProject(ctx, projectId);
}

function shortId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function isFileMessageType(value: unknown): value is Infer<typeof lineAiFileType> {
  return value === "image" || value === "video" || value === "file";
}

async function senderDigestKey() {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = Uint8Array.from(atob(process.env.LINE_SECRETS_KEY ?? ""), c => c.charCodeAt(0));
  } catch {
    throw new Error("LINE_SECRETS_KEY_INVALID");
  }
  if (bytes.length !== 32) throw new Error("LINE_SECRETS_KEY_INVALID");
  return crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

/**
 * Opaque, deterministic sender digest scoped to one bot and one LINE chat.
 * Keyed with LINE_SECRETS_KEY so database rows never expose raw LINE userIds
 * and cannot be reversed offline or correlated across chats/bots.
 */
export async function opaqueLineSenderDigest(
  botId: string,
  lineChatId: string,
  senderUserId: string,
): Promise<string> {
  const key = await senderDigestKey();
  const scope = `line-ai-sender:v1:${botId}:${lineChatId}:${senderUserId}`;
  const mac = await crypto.subtle.sign("HMAC", key, encode.encode(scope));
  return Array.from(new Uint8Array(mac), byte => byte.toString(16).padStart(2, "0")).join("");
}

type MentionSpan = { start: number; end: number };

function parseSelfMentions(mention: unknown, textLength: number): { hasSelf: boolean; spans: MentionSpan[] } {
  if (!mention || typeof mention !== "object") return { hasSelf: false, spans: [] };
  const mentionees = (mention as Record<string, unknown>).mentionees;
  if (!Array.isArray(mentionees)) return { hasSelf: false, spans: [] };
  let hasSelf = false;
  const spans: MentionSpan[] = [];
  for (const item of mentionees) {
    if (!item || typeof item !== "object") continue;
    const fields = item as Record<string, unknown>;
    if (fields.isSelf !== true) continue;
    if (fields.type !== undefined && fields.type !== "user") continue;
    hasSelf = true;
    const index = fields.index;
    const length = fields.length;
    if (typeof index === "number" && Number.isSafeInteger(index) && index >= 0
      && typeof length === "number" && Number.isSafeInteger(length) && length > 0
      && index + length <= textLength) {
      spans.push({ start: index, end: index + length });
    }
  }
  return { hasSelf, spans };
}

function normalizeTriggerText(rawText: string, spans: MentionSpan[]): string {
  const bounded = rawText.length > LINE_AI_MAX_RAW_TEXT_LENGTH
    ? rawText.slice(0, LINE_AI_MAX_RAW_TEXT_LENGTH) : rawText;
  let stripped = bounded;
  if (spans.length > 0) {
    const sorted = spans
      .filter(span => span.end <= bounded.length)
      .sort((a, b) => a.start - b.start);
    let cursor = 0;
    let out = "";
    for (const span of sorted) {
      if (span.start > cursor) out += bounded.slice(cursor, span.start);
      if (span.end > cursor) cursor = span.end;
    }
    out += bounded.slice(cursor);
    stripped = out;
  }
  const normalized = stripped
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .trim();
  return normalized.slice(0, LINE_AI_MAX_TEXT_LENGTH);
}

/**
 * Pure parser for LINE assistant events (`message` text/file and `unsend`).
 * Drops non-active modes, non-trigger group chatter, unsupported message types,
 * and malformed payloads before they reach database mutations.
 */
export function extractLineAiEvent(value: unknown): ExtractedLineAiEvent | undefined {
  if (!value || typeof value !== "object") return;
  const fields = value as Record<string, unknown>;
  const { type, timestamp, source, webhookEventId, mode } = fields;
  if (mode !== undefined && mode !== "active") return;
  if (!shortId(webhookEventId) || typeof timestamp !== "number" || !Number.isSafeInteger(timestamp)
    || timestamp < 0 || !source || typeof source !== "object") return;

  const src = source as Record<string, unknown>;
  const chatKind = src.type;
  if (chatKind !== "group" && chatKind !== "room" && chatKind !== "user") return;
  const lineChatId = src[chatKind === "group" ? "groupId" : chatKind === "room" ? "roomId" : "userId"];
  if (!shortId(lineChatId)) return;
  const senderUserId = chatKind === "user" ? lineChatId : (shortId(src.userId) ? src.userId : undefined);

  if (type === "unsend") {
    const unsend = fields.unsend;
    if (!unsend || typeof unsend !== "object") return;
    const messageId = (unsend as Record<string, unknown>).messageId;
    if (!shortId(messageId)) return;
    return {
      eventType: "unsend",
      webhookEventId,
      timestamp,
      kind: chatKind,
      lineChatId,
      messageId,
      ...(senderUserId ? { senderUserId } : {}),
    };
  }

  if (type !== "message" || !senderUserId) return;
  const message = fields.message;
  if (!message || typeof message !== "object") return;
  const msg = message as Record<string, unknown>;
  if (!shortId(msg.id)) return;

  if (msg.type === "text") {
    if (typeof msg.text !== "string") return;
    const { hasSelf, spans } = parseSelfMentions(msg.mention, msg.text.length);
    if (chatKind !== "user" && !hasSelf) return;
    const text = normalizeTriggerText(msg.text, spans);
    if (!text) return;
    return {
      eventType: "text",
      webhookEventId,
      timestamp,
      kind: chatKind,
      lineChatId,
      messageId: msg.id,
      senderUserId,
      text,
    };
  }

  if (isFileMessageType(msg.type)) {
    return {
      eventType: "file",
      webhookEventId,
      timestamp,
      kind: chatKind,
      lineChatId,
      messageId: msg.id,
      senderUserId,
      fileType: msg.type,
    };
  }

  return;
}

/** Parses and seals sender identities for a webhook batch when LINE_AI_ENABLED === "true". */
export async function trimLineAiEvents(botId: string, rawEvents: unknown[]): Promise<LineAiInboundEvent[]> {
  if (!lineAiEnabled()) return [];
  const parsed: LineAiInboundEvent[] = [];
  for (const raw of rawEvents) {
    const extracted = extractLineAiEvent(raw);
    if (!extracted) continue;
    if (extracted.eventType === "unsend") {
      const senderDigest = extracted.senderUserId
        ? await opaqueLineSenderDigest(botId, extracted.lineChatId, extracted.senderUserId)
        : undefined;
      parsed.push({
        eventType: "unsend",
        webhookEventId: extracted.webhookEventId,
        timestamp: extracted.timestamp,
        kind: extracted.kind,
        lineChatId: extracted.lineChatId,
        messageId: extracted.messageId,
        ...(senderDigest ? { senderDigest } : {}),
      });
      continue;
    }
    const senderDigest = await opaqueLineSenderDigest(botId, extracted.lineChatId, extracted.senderUserId);
    if (extracted.eventType === "text") {
      parsed.push({
        eventType: "text",
        webhookEventId: extracted.webhookEventId,
        timestamp: extracted.timestamp,
        kind: extracted.kind,
        lineChatId: extracted.lineChatId,
        messageId: extracted.messageId,
        senderDigest,
        text: extracted.text,
      });
    } else {
      parsed.push({
        eventType: "file",
        webhookEventId: extracted.webhookEventId,
        timestamp: extracted.timestamp,
        kind: extracted.kind,
        lineChatId: extracted.lineChatId,
        messageId: extracted.messageId,
        senderDigest,
        fileType: extracted.fileType,
      });
    }
  }
  return parsed;
}

function isEligibleAssistantChat(bot: Doc<"lineBots">, chat: Doc<"lineChats"> | null, eventKind: Doc<"lineChats">["kind"], timestamp: number): chat is Doc<"lineChats"> {
  return Boolean(
    chat
    && chat.projectId === bot.projectId
    && chat.kind === eventKind
    && chat.state === "active"
    && chat.leftAt === undefined
    && chat.assistantEnabled === true
    && timestamp >= Math.max(chat.joinedAt, chat.assistantEnabledAt ?? 0),
  );
}

async function hasDedupEvent(ctx: MutationCtx, botId: Id<"lineBots">, webhookEventId: string) {
  return Boolean(await ctx.db.query("lineAiEvents")
    .withIndex("by_bot_event", q => q.eq("botId", botId).eq("webhookEventId", webhookEventId))
    .unique());
}

async function recordDedupEvent(
  ctx: MutationCtx,
  botId: Id<"lineBots">,
  webhookEventId: string,
  messageId: string,
  outcome: Doc<"lineAiEvents">["outcome"],
  now: number,
) {
  await ctx.db.insert("lineAiEvents", {
    botId,
    webhookEventId,
    messageId,
    outcome,
    expiresAt: now + LINE_AI_DEDUP_TTL_MS,
    createdAt: now,
  });
}

async function isMessageUnsent(ctx: MutationCtx, botId: Id<"lineBots">, lineChatId: string, messageId: string) {
  return Boolean(await ctx.db.query("lineAiUnsends")
    .withIndex("by_bot_chat_message", q => q.eq("botId", botId).eq("lineChatId", lineChatId).eq("messageId", messageId))
    .unique());
}

async function ensureUnsendFence(
  ctx: MutationCtx,
  botId: Id<"lineBots">,
  lineChatId: string,
  messageId: string,
  webhookEventId: string,
  unsentAt: number,
  now: number,
) {
  const existing = await ctx.db.query("lineAiUnsends")
    .withIndex("by_bot_chat_message", q => q.eq("botId", botId).eq("lineChatId", lineChatId).eq("messageId", messageId))
    .unique();
  if (existing) return;
  await ctx.db.insert("lineAiUnsends", {
    botId,
    lineChatId,
    messageId,
    webhookEventId,
    unsentAt,
    expiresAt: now + LINE_AI_DEDUP_TTL_MS,
    createdAt: now,
  });
}

async function handleTextEvent(
  ctx: MutationCtx,
  bot: Doc<"lineBots">,
  event: Extract<LineAiInboundEvent, { eventType: "text" }>,
  now: number,
  authority: IntakeAuthority,
  onSchedule?: LineAiScheduleHook,
) {
  if (!event.senderDigest || event.senderDigest.length > 128) return;
  const text = event.text.trim().slice(0, LINE_AI_MAX_TEXT_LENGTH);
  if (!text) return;

  const chat = await ctx.db.query("lineChats")
    .withIndex("by_bot_chat", q => q.eq("botId", bot._id).eq("lineChatId", event.lineChatId))
    .unique();
  if (!isEligibleAssistantChat(bot, chat, event.kind, event.timestamp)) return;
  if (await hasDedupEvent(ctx, bot._id, event.webhookEventId)) return;
  if (await isMessageUnsent(ctx, bot._id, event.lineChatId, event.messageId)) return;

  const existing = await ctx.db.query("lineAiIntakes")
    .withIndex("by_bot_message", q => q.eq("botId", bot._id).eq("messageId", event.messageId))
    .unique();
  if (existing) return;

  const windowEndsAt = event.timestamp + LINE_AI_FILE_WINDOW_MS;
  const expiresAt = now + LINE_AI_INTAKE_TTL_MS;
  const availableAt = Math.max(now, Math.min(windowEndsAt, now + LINE_AI_FILE_WINDOW_MS));
  const intakeId = await ctx.db.insert("lineAiIntakes", {
    projectId: bot.projectId,
    botId: bot._id,
    chatId: chat._id,
    joinedAt: chat.joinedAt,
    chatRevision: chat.assistantRevision ?? 0,
    botRevision: bot.assistantRevision ?? 0,
    connectionRevision: authority.connectionRevision,
    projectVisibilityVersion: authority.projectVisibilityVersion,
    kind: chat.kind,
    webhookEventId: event.webhookEventId,
    messageId: event.messageId,
    senderDigest: event.senderDigest,
    text,
    files: [],
    state: "pending",
    messageTimestamp: event.timestamp,
    windowEndsAt,
    expiresAt,
    availableAt,
    attempt: 0,
    createdAt: now,
    updatedAt: now,
  });
  await recordDedupEvent(ctx, bot._id, event.webhookEventId, event.messageId, "created", now);
  if (onSchedule) await onSchedule(ctx, { intakeId, availableAt });
}

async function handleFileEvent(
  ctx: MutationCtx,
  bot: Doc<"lineBots">,
  event: Extract<LineAiInboundEvent, { eventType: "file" }>,
  now: number,
  authority: IntakeAuthority,
) {
  if (!event.senderDigest || event.senderDigest.length > 128) return;

  const chat = await ctx.db.query("lineChats")
    .withIndex("by_bot_chat", q => q.eq("botId", bot._id).eq("lineChatId", event.lineChatId))
    .unique();
  if (!isEligibleAssistantChat(bot, chat, event.kind, event.timestamp)) return;
  if (await hasDedupEvent(ctx, bot._id, event.webhookEventId)) return;
  if (await isMessageUnsent(ctx, bot._id, event.lineChatId, event.messageId)) return;

  const alreadyAttached = await ctx.db.query("lineAiIntakeFiles")
    .withIndex("by_bot_message", q => q.eq("botId", bot._id).eq("messageId", event.messageId))
    .unique();
  if (alreadyAttached) return;

  // Match the latest trigger from the same bot, chat, active enrollment, and sender
  // at or before this file's timestamp (rejects pre-trigger, cross-sender, and stale enrollment).
  const candidate = await ctx.db.query("lineAiIntakes")
    .withIndex("by_chat_sender_window", q => q
      .eq("chatId", chat._id)
      .eq("joinedAt", chat.joinedAt)
      .eq("senderDigest", event.senderDigest)
      .lte("messageTimestamp", event.timestamp))
    .order("desc")
    .first();

  if (!candidate) return;
  if (candidate.botId !== bot._id || candidate.projectId !== bot.projectId) return;
  if (candidate.chatRevision !== (chat.assistantRevision ?? 0) || candidate.botRevision !== (bot.assistantRevision ?? 0)
    || candidate.connectionRevision !== authority.connectionRevision
    || candidate.projectVisibilityVersion !== authority.projectVisibilityVersion) return;
  if (candidate.state !== "pending") return;
  if (event.timestamp > candidate.windowEndsAt || now > candidate.expiresAt) return;
  if (candidate.files.length >= LINE_AI_MAX_FILES) return;
  if (candidate.files.some(file => file.messageId === event.messageId)) return;

  const files = [...candidate.files, { messageId: event.messageId, type: event.fileType }];
  await ctx.db.patch(candidate._id, { files, updatedAt: now });
  await ctx.db.insert("lineAiIntakeFiles", {
    botId: bot._id,
    messageId: event.messageId,
    intakeId: candidate._id,
    chatId: chat._id,
    joinedAt: chat.joinedAt,
    expiresAt: candidate.expiresAt,
  });
  await recordDedupEvent(ctx, bot._id, event.webhookEventId, event.messageId, "file_attached", now);
}

async function discardAssistantDraft(ctx: MutationCtx, intakeId: Id<"lineAiIntakes">) {
  const draft = await ctx.db.query("lineAiDrafts").withIndex("by_intake", q => q.eq("intakeId", intakeId)).unique();
  if (draft?.state === "review") await ctx.db.delete(draft._id);
}

async function handleUnsendEvent(
  ctx: MutationCtx,
  bot: Doc<"lineBots">,
  event: Extract<LineAiInboundEvent, { eventType: "unsend" }>,
  now: number,
  onSchedule?: LineAiScheduleHook,
) {
  const chat = await ctx.db.query("lineChats")
    .withIndex("by_bot_chat", q => q.eq("botId", bot._id).eq("lineChatId", event.lineChatId))
    .unique();
  if (!chat || chat.projectId !== bot.projectId || chat.kind !== event.kind) return;
  if (event.timestamp < chat.joinedAt) return;
  if (await hasDedupEvent(ctx, bot._id, event.webhookEventId)) return;

  const sameEnrollment = (intake: Doc<"lineAiIntakes">) =>
    intake.botId === bot._id
    && intake.projectId === bot.projectId
    && intake.chatId === chat._id
    && intake.joinedAt === chat.joinedAt
    && (!event.senderDigest || intake.senderDigest === event.senderDigest);

  // 1. Check whether the unsent message is an intake trigger message.
  const triggerIntake = await ctx.db.query("lineAiIntakes")
    .withIndex("by_bot_message", q => q.eq("botId", bot._id).eq("messageId", event.messageId))
    .unique();
  if (triggerIntake) {
    if (!sameEnrollment(triggerIntake)) return;
    await ensureUnsendFence(ctx, bot._id, event.lineChatId, event.messageId, event.webhookEventId, event.timestamp, now);
    if (triggerIntake.state !== "acted" && triggerIntake.state !== "ignored") {
      await discardAssistantDraft(ctx, triggerIntake._id);
      await ctx.db.patch(triggerIntake._id, {
        state: "ignored",
        text: "",
        files: [],
        unsentAt: event.timestamp,
        leaseId: undefined,
        leaseExpiresAt: undefined,
        updatedAt: now,
      });
      const fileLinks = await ctx.db.query("lineAiIntakeFiles")
        .withIndex("by_intake", q => q.eq("intakeId", triggerIntake._id))
        .collect();
      for (const link of fileLinks) await ctx.db.delete(link._id);
    }
    await recordDedupEvent(ctx, bot._id, event.webhookEventId, event.messageId, "unsent", now);
    return;
  }

  // 2. Check whether the unsent message is an attached follow-up file.
  const fileLink = await ctx.db.query("lineAiIntakeFiles")
    .withIndex("by_bot_message", q => q.eq("botId", bot._id).eq("messageId", event.messageId))
    .unique();
  if (fileLink) {
    const intake = await ctx.db.get(fileLink.intakeId);
    if (!intake || !sameEnrollment(intake)) return;
    await ensureUnsendFence(ctx, bot._id, event.lineChatId, event.messageId, event.webhookEventId, event.timestamp, now);
    if (intake.state !== "acted" && intake.state !== "ignored") {
      const files = intake.files.filter(file => file.messageId !== event.messageId);
      if (intake.state === "draft" || intake.state === "processing") {
        await discardAssistantDraft(ctx, intake._id);
        await ctx.db.patch(intake._id, {
          files, state: "pending", availableAt: now,
          leaseId: undefined, leaseExpiresAt: undefined, updatedAt: now,
        });
        if (onSchedule) await onSchedule(ctx, { intakeId: intake._id, availableAt: now });
      } else {
        await ctx.db.patch(intake._id, { files, updatedAt: now });
      }
      await ctx.db.delete(fileLink._id);
    }
    await recordDedupEvent(ctx, bot._id, event.webhookEventId, event.messageId, "unsent", now);
    return;
  }

  // 3. Out-of-order unsend before message delivery: only fence chats eligible for assistant intake.
  if (!isEligibleAssistantChat(bot, chat, event.kind, event.timestamp)) return;
  await ensureUnsendFence(ctx, bot._id, event.lineChatId, event.messageId, event.webhookEventId, event.timestamp, now);
  await recordDedupEvent(ctx, bot._id, event.webhookEventId, event.messageId, "unsend_fenced", now);
}

/**
 * Persists eligible assistant text triggers, follow-up files and unsend fences
 * inside the webhook accept transaction.
 */
export async function acceptLineAiEvents(
  ctx: MutationCtx,
  input: { bot: Doc<"lineBots">; events: LineAiInboundEvent[]; now: number },
  options?: { onSchedule?: LineAiScheduleHook },
) {
  const { bot, events, now } = input;
  if (!events.length || bot.state !== "active") return;
  const project = await admittedLineAiProject(ctx, bot.projectId);
  if (!project) return;
  const connection = await readLineAiConnection(ctx, bot.projectId);
  const authority = connection?.enabled && connection.keyCipher ? {
    connectionRevision: connection.revision, connectionUpdatedAt: connection.updatedAt,
    projectVisibilityVersion: project.inboxVisibilityVersion ?? 0,
  } : null;

  for (const event of events) {
    if (event.eventType === "unsend") {
      await handleUnsendEvent(ctx, bot, event, now, options?.onSchedule);
      continue;
    }
    if (!authority || event.timestamp < Math.max(authority.connectionUpdatedAt, now - LINE_AI_INTAKE_TTL_MS)
      || event.timestamp > now + 5 * 60_000) continue;
    if (event.eventType === "text") {
      await handleTextEvent(ctx, bot, event, now, authority, options?.onSchedule);
    } else {
      await handleFileEvent(ctx, bot, event, now, authority);
    }
  }
}

/**
 * Bounded cleanup sweep over all AI intake tables using their `by_expires_at` indexes.
 * Intended to be called from a scheduled maintenance cron owned by the parent integration.
 */
export async function cleanupExpiredLineAiRecords(
  ctx: MutationCtx,
  options?: { now?: number; limit?: number },
) {
  if (retentionHeld(process.env)) return { deletedIntakes: 0, deletedFiles: 0, deletedEvents: 0, deletedUnsends: 0 };
  const now = options?.now ?? Date.now();
  const rawLimit = options?.limit ?? LINE_AI_CLEANUP_BATCH;
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(Math.trunc(rawLimit), 200))
    : LINE_AI_CLEANUP_BATCH;
  let deletedIntakes = 0;
  let deletedFiles = 0;
  let deletedEvents = 0;
  let deletedUnsends = 0;

  const expiredIntakes = await ctx.db.query("lineAiIntakes")
    .withIndex("by_expires_at", q => q.lte("expiresAt", now))
    .take(limit);
  for (const intake of expiredIntakes) {
    if (intake.state === "processing" && (intake.leaseExpiresAt ?? 0) > now) continue;
    const links = await ctx.db.query("lineAiIntakeFiles")
      .withIndex("by_intake", q => q.eq("intakeId", intake._id))
      .collect();
    for (const link of links) {
      await ctx.db.delete(link._id);
      deletedFiles++;
    }
    await ctx.db.delete(intake._id);
    deletedIntakes++;
  }

  const expiredFiles = await ctx.db.query("lineAiIntakeFiles")
    .withIndex("by_expires_at", q => q.lte("expiresAt", now))
    .take(limit);
  for (const link of expiredFiles) {
    const parent = await ctx.db.get(link.intakeId);
    if (parent && parent.state === "processing" && (parent.leaseExpiresAt ?? 0) > now) continue;
    await ctx.db.delete(link._id);
    deletedFiles++;
  }

  const expiredEvents = await ctx.db.query("lineAiEvents")
    .withIndex("by_expires_at", q => q.lte("expiresAt", now))
    .take(limit);
  for (const row of expiredEvents) {
    await ctx.db.delete(row._id);
    deletedEvents++;
  }

  const expiredUnsends = await ctx.db.query("lineAiUnsends")
    .withIndex("by_expires_at", q => q.lte("expiresAt", now))
    .take(limit);
  for (const row of expiredUnsends) {
    await ctx.db.delete(row._id);
    deletedUnsends++;
  }

  return { deletedIntakes, deletedFiles, deletedEvents, deletedUnsends };
}
