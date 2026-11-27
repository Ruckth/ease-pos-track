import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { admittedLineProject } from "./line";
import { currentLineLifecycle } from "./line_ai_review";
import { extractLineAiEvent, opaqueLineSenderDigest, LINE_AI_MAX_RAW_TEXT_LENGTH, LINE_AI_MAX_TEXT_LENGTH } from "./line_ai_intake";
import { captureKind } from "../line_capture_schema";
import { retentionHeld } from "../../shared/pilot-settings";
import { localFixturesEnabled } from "../local_fixtures";

type DbContext = Pick<QueryCtx, "db">;
type Intake = Doc<"lineCaptureIntakes">;

export const LINE_CAPTURE_WINDOW_MS = 2 * 60_000;
export const LINE_CAPTURE_TTL_MS = 24 * 60 * 60_000;
export const LINE_CAPTURE_DEDUP_TTL_MS = 7 * 24 * 60 * 60_000;
/** How long a redacted, content-free intake and its receipts stay for replay and provenance. */
export const LINE_CAPTURE_RECEIPT_TTL_MS = 30 * 24 * 60 * 60_000;
const MAX_RECEIPTS = 10;
export const LINE_CAPTURE_EDIT_HOLD_MS = 10 * 60_000;
const FUTURE_SKEW_MS = 5 * 60_000;
const MAX_HELD_EDITS = 8;

/** M1 capture runs only on local fixture deployments, for fixture bots, in one approved Project and group. */
export function lineCaptureEnabled() {
  return process.env.LINE_CAPTURE_ENABLED === "true" && localFixturesEnabled();
}

export function captureBot(bot: Pick<Doc<"lineBots">, "lineUserId" | "state"> | null) {
  return !!bot && bot.state === "active" && bot.lineUserId.startsWith("Ufixture-");
}

const base = {
  webhookEventId: v.string(), timestamp: v.number(), kind: captureKind, lineChatId: v.string(), messageId: v.string(),
};
export const lineCaptureEvent = v.union(
  v.object({ ...base, eventType: v.literal("mention"), senderDigest: v.string(), text: v.string() }),
  v.object({ ...base, eventType: v.literal("edit"), senderDigest: v.string(), text: v.string(), mentioned: v.boolean() }),
  v.object({ ...base, eventType: v.literal("unsend"), senderDigest: v.optional(v.string()) }),
);
export type LineCaptureEvent = Infer<typeof lineCaptureEvent>;

/** Signed metadata only. The staging action retrieves bytes after admission commits. */
export const captureMediaEvent = v.object({
  ...base, senderDigest: v.string(),
  fileType: v.union(v.literal("image"), v.literal("video"), v.literal("file")),
  contentProvider: v.optional(v.union(v.literal("line"), v.literal("external"))),
  imageSet: v.optional(v.object({ id: v.string(), index: v.number(), total: v.number() })),
  imageSetInvalid: v.optional(v.literal(true)),
});
export type LineCaptureMediaEvent = Infer<typeof captureMediaEvent>;

function shortId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

/** Self mentions stripped from text; `mentioned` is false when the bot is no longer mentioned. */
function mentionText(message: Record<string, unknown>) {
  if (typeof message.text !== "string") return;
  const raw = message.text.slice(0, LINE_AI_MAX_RAW_TEXT_LENGTH);
  const mentionees = (message.mention as { mentionees?: unknown } | undefined)?.mentionees;
  const spans: Array<[number, number]> = [];
  let mentioned = false;
  if (Array.isArray(mentionees)) for (const item of mentionees) {
    if (!item || typeof item !== "object") continue;
    const { isSelf, type, index, length } = item as Record<string, unknown>;
    if (isSelf !== true || (type !== undefined && type !== "user")) continue;
    mentioned = true;
    if (Number.isSafeInteger(index) && Number.isSafeInteger(length) && (index as number) >= 0
      && (length as number) > 0 && (index as number) + (length as number) <= raw.length) {
      spans.push([index as number, (index as number) + (length as number)]);
    }
  }
  let out = "";
  let cursor = 0;
  for (const [start, end] of spans.sort((a, b) => a[0] - b[0])) {
    if (start > cursor) out += raw.slice(cursor, start);
    cursor = Math.max(cursor, end);
  }
  out += raw.slice(cursor);
  const text = out.replace(/\r\n?/g, "\n").replace(/[ \t]{2,}/g, " ").replace(/[ \t]*\n[ \t]*/g, "\n").trim()
    .slice(0, LINE_AI_MAX_TEXT_LENGTH);
  return { text, mentioned };
}

type Parsed = { capture: LineCaptureEvent[]; media: LineCaptureMediaEvent[] };

/**
 * Parses signed group/room mentions, group edits, unsends and file messages for capture.
 * Unsends are parsed even while capture is off, so a pause cannot let a delayed event revive a message.
 */
export async function trimLineCaptureEvents(botId: string, rawEvents: unknown[]): Promise<Parsed> {
  const enabled = lineCaptureEnabled();
  const result: Parsed = { capture: [], media: [] };
  for (const raw of rawEvents) {
    if (!raw || typeof raw !== "object") continue;
    const fields = raw as Record<string, unknown>;
    const source = fields.source as Record<string, unknown> | undefined;
    const kind = source?.type;
    if (kind !== "group" && kind !== "room") continue;
    const { webhookEventId, timestamp } = fields;
    const lineChatId = source![kind === "group" ? "groupId" : "roomId"];
    if (!shortId(webhookEventId) || !Number.isSafeInteger(timestamp) || (timestamp as number) < 0 || !shortId(lineChatId)) continue;
    const userId = shortId(source!.userId) ? source!.userId : undefined;
    const common = { webhookEventId, timestamp: timestamp as number, kind, lineChatId } as const;

    if (fields.type === "messageEdited") {
      if (!enabled || !userId || (fields.mode !== undefined && fields.mode !== "active")) continue;
      const message = fields.message as Record<string, unknown> | undefined;
      if (!message || !shortId(message.id) || message.type !== "text") continue;
      const parsed = mentionText(message);
      if (!parsed) continue;
      result.capture.push({
        ...common, eventType: "edit", messageId: message.id, senderDigest: await opaqueLineSenderDigest(botId, lineChatId, userId),
        ...parsed,
      });
      continue;
    }
    const extracted = extractLineAiEvent(raw);
    if (!extracted || (extracted.kind !== "group" && extracted.kind !== "room")) continue;
    if (extracted.eventType === "unsend") {
      result.capture.push({
        ...common, eventType: "unsend", messageId: extracted.messageId,
        ...(extracted.senderUserId ? { senderDigest: await opaqueLineSenderDigest(botId, lineChatId, extracted.senderUserId) } : {}),
      });
      continue;
    }
    if (!enabled) continue;
    const senderDigest = await opaqueLineSenderDigest(botId, lineChatId, extracted.senderUserId);
    if (extracted.eventType === "text") {
      // extractLineAiEvent keeps only self-mentions in groups and rooms.
      result.capture.push({ ...common, eventType: "mention", messageId: extracted.messageId, senderDigest, text: extracted.text });
    } else {
      const message = fields.message as Record<string, unknown>;
      const provider = (message.contentProvider as { type?: unknown } | undefined)?.type;
      const set = message.imageSet as Record<string, unknown> | null | undefined;
      const validSet = !!set && typeof set === "object" && shortId(set.id) && Number.isSafeInteger(set.index)
        && Number.isSafeInteger(set.total) && (set.index as number) >= 1 && (set.index as number) <= (set.total as number);
      result.media.push({
        ...common, messageId: extracted.messageId, senderDigest, fileType: extracted.fileType,
        ...(provider === "line" || provider === "external" ? { contentProvider: provider } : {}),
        ...(validSet ? { imageSet: { id: set!.id as string, index: set!.index as number, total: set!.total as number } }
          : set !== undefined ? { imageSetInvalid: true as const } : {}),
      });
    }
  }
  return result;
}

// ---------- Authority ----------

export async function captureProject(ctx: DbContext, projectId: Id<"projects">) {
  return ctx.db.query("lineCaptureProjects").withIndex("by_project", q => q.eq("projectId", projectId)).unique();
}

export async function captureChatOptIn(ctx: DbContext, chat: Doc<"lineChats">) {
  return ctx.db.query("lineCaptureChats").withIndex("by_chat", q => q.eq("chatId", chat._id).eq("joinedAt", chat.joinedAt)).unique();
}

/** Current capture enrollment for a chat; the same gates admit text, media and staff finishing. */
async function enrollmentFor(ctx: DbContext, bot: Doc<"lineBots"> | null, chat: Doc<"lineChats"> | null) {
  if (!lineCaptureEnabled() || !bot || !captureBot(bot) || !chat) return null;
  const project = await admittedLineProject(ctx, bot.projectId);
  if (!project || chat.botId !== bot._id || chat.projectId !== project._id || chat.state !== "active"
    || chat.leftAt !== undefined || chat.kind === "user") return null;
  const [projectSwitch, optIn] = await Promise.all([captureProject(ctx, project._id), captureChatOptIn(ctx, chat)]);
  if (!projectSwitch || !optIn || optIn.projectId !== project._id || optIn.botId !== bot._id) return null;
  if (!await currentLineLifecycle(ctx, chat)) return null;
  return { project, bot, chat, captureChatId: optIn._id, since: Math.max(chat.joinedAt, optIn.enabledAt, projectSwitch.enabledAt) };
}

export async function captureEnrollment(ctx: DbContext, input: { botId: Id<"lineBots">; lineChatId: string; timestamp: number }) {
  const bot = await ctx.db.get(input.botId);
  const chat = await ctx.db.query("lineChats").withIndex("by_bot_chat", q => q.eq("botId", input.botId).eq("lineChatId", input.lineChatId)).unique();
  const current = await enrollmentFor(ctx, bot, chat);
  if (!current || input.timestamp < current.since) return null;
  const { project, chat: currentChat } = current;
  return { project, bot: current.bot, chat: currentChat, captureChatId: current.captureChatId };
}

function withdrawn(intake: Intake) {
  return intake.state === "withdrawn" || intake.state === "dismissed" || intake.unsentAt !== undefined;
}

/** The intake as long as it is still admitted: not withdrawn, unexpired and its enrollment is current. */
export async function currentCaptureIntake(ctx: DbContext, intakeId: Id<"lineCaptureIntakes">, now = Date.now()) {
  const intake = await ctx.db.get(intakeId);
  if (!intake || withdrawn(intake) || intake.redactedAt !== undefined || intake.expiresAt <= now) return null;
  const current = await enrollmentFor(ctx, await ctx.db.get(intake.botId), await ctx.db.get(intake.chatId));
  if (!current || current.captureChatId !== intake.captureChatId || current.chat.joinedAt !== intake.joinedAt || current.project._id !== intake.projectId) return null;
  return intake;
}

export async function captureMessageUnsent(ctx: DbContext, botId: Id<"lineBots">, lineChatId: string, messageId: string) {
  return !!await ctx.db.query("lineCaptureUnsends")
    .withIndex("by_bot_chat_message", q => q.eq("botId", botId).eq("lineChatId", lineChatId).eq("messageId", messageId)).unique();
}

export async function flagCaptureWarning(ctx: MutationCtx, intakeId: Id<"lineCaptureIntakes">, code: string) {
  if (!/^[A-Z][A-Z_]{2,63}$/.test(code)) throw new Error("INVALID_INPUT");
  const intake = await ctx.db.get(intakeId);
  if (!intake || withdrawn(intake) || intake.warning === code) return;
  await ctx.db.patch(intakeId, { warning: code, revision: intake.revision + 1, updatedAt: Date.now() });
}

/** Cut over only after the legacy writer and all recoverable deliveries have settled. */
export async function openLegacyAiWork(ctx: DbContext, projectId: Id<"projects">) {
  const draft = ctx.db.query("lineAiDrafts").withIndex("by_project_review_state",
    q => q.eq("projectId", projectId).eq("state", "review")).first();
  const processing = (["pending", "processing", "draft"] as const).map(state =>
    ctx.db.query("lineAiIntakes").withIndex("by_project_state", q => q.eq("projectId", projectId).eq("state", state)).first());
  const deliveries = (["pending", "unknown", "limited"] as const).map(state =>
    ctx.db.query("lineAiReplies").withIndex("by_project_state", q => q.eq("projectId", projectId).eq("state", state)).first());
  return (await Promise.all([draft, ...processing, ...deliveries])).some(Boolean);
}

// ---------- Accept ----------

function stateFor(intake: Pick<Intake, "text" | "conflict">): Intake["state"] {
  return intake.conflict ? "review" : intake.text ? "captured" : "needs_details";
}

async function dedup(ctx: MutationCtx, botId: Id<"lineBots">, event: LineCaptureEvent, now: number) {
  if (await ctx.db.query("lineCaptureEvents").withIndex("by_bot_event", q => q.eq("botId", botId).eq("webhookEventId", event.webhookEventId)).unique()) return true;
  await ctx.db.insert("lineCaptureEvents", {
    botId, webhookEventId: event.webhookEventId, messageId: event.messageId, expiresAt: now + LINE_CAPTURE_DEDUP_TTL_MS,
  });
  return false;
}

type Edit = { text: string; mentioned: boolean; timestamp: number };

async function applyEdit(ctx: MutationCtx, intake: Intake, edit: Edit, now: number) {
  if (withdrawn(intake) || edit.timestamp < intake.sourceTimestamp) return;
  const revision = intake.revision + 1;
  if (intake.state === "linked") {
    // After linkage the Ticket is never rewritten; staff reviews the correction.
    const previous = intake.correction;
    if (previous && edit.timestamp < previous.timestamp) return;
    const conflict = !!previous && edit.timestamp === previous.timestamp && previous.text !== edit.text;
    await ctx.db.patch(intake._id, { correction: edit, revision, updatedAt: now, ...(conflict ? { conflict: true } : {}) });
    return;
  }
  if (edit.timestamp === intake.sourceTimestamp) {
    if (edit.text === intake.text && edit.mentioned === intake.mentioned) return;
    await ctx.db.patch(intake._id, { conflict: true, state: "review", revision, updatedAt: now });
    return;
  }
  if (!edit.mentioned) {
    await ctx.db.patch(intake._id, {
      state: "withdrawn", bucket: "done", text: "", mentioned: false, sourceTimestamp: edit.timestamp, revision, updatedAt: now,
    });
    return;
  }
  await ctx.db.patch(intake._id, {
    text: edit.text, mentioned: true, sourceTimestamp: edit.timestamp,
    state: stateFor({ text: edit.text, conflict: intake.conflict }), revision, updatedAt: now,
  });
}

async function heldEdits(ctx: MutationCtx, botId: Id<"lineBots">, messageId: string) {
  return ctx.db.query("lineCaptureEdits").withIndex("by_bot_message", q => q.eq("botId", botId).eq("messageId", messageId)).take(MAX_HELD_EDITS);
}

async function acceptMention(ctx: MutationCtx, bot: Doc<"lineBots">, chat: Doc<"lineChats">, captureChatId: Id<"lineCaptureChats">, event: Extract<LineCaptureEvent, { eventType: "mention" }>, now: number) {
  if (await ctx.db.query("lineCaptureIntakes").withIndex("by_bot_message", q => q.eq("botId", bot._id).eq("messageId", event.messageId)).unique()) return;
  const fields = {
    projectId: bot.projectId, botId: bot._id, chatId: chat._id, joinedAt: chat.joinedAt, captureChatId, kind: event.kind,
    messageId: event.messageId, webhookEventId: event.webhookEventId, senderDigest: event.senderDigest,
    text: event.text, mentioned: true, revision: 1, messageTimestamp: event.timestamp, sourceTimestamp: event.timestamp,
    createdAt: now, updatedAt: now, expiresAt: now + LINE_CAPTURE_TTL_MS,
  };
  const intakeId = await ctx.db.insert("lineCaptureIntakes", { ...fields, state: stateFor(fields), bucket: "open" });
  // Reconcile edits held before this original was admitted, only from the same sender and chat.
  for (const edit of (await heldEdits(ctx, bot._id, event.messageId)).sort((a, b) => a.timestamp - b.timestamp)) {
    await ctx.db.delete(edit._id);
    if (edit.captureChatId !== captureChatId || edit.lineChatId !== event.lineChatId || edit.senderDigest !== event.senderDigest || edit.expiresAt <= now) continue;
    await applyEdit(ctx, (await ctx.db.get(intakeId))!, edit, now);
  }
}

async function acceptEdit(ctx: MutationCtx, bot: Doc<"lineBots">, captureChatId: Id<"lineCaptureChats">, event: Extract<LineCaptureEvent, { eventType: "edit" }>, now: number) {
  const intake = await ctx.db.query("lineCaptureIntakes").withIndex("by_bot_message", q => q.eq("botId", bot._id).eq("messageId", event.messageId)).unique();
  const edit = { text: event.text, mentioned: event.mentioned, timestamp: event.timestamp };
  if (intake) {
    if (intake.captureChatId !== captureChatId || intake.expiresAt <= now || intake.redactedAt !== undefined
      || intake.senderDigest !== event.senderDigest || intake.kind !== event.kind) return;
    const chat = await ctx.db.get(intake.chatId);
    if (chat?.lineChatId !== event.lineChatId) return;
    await applyEdit(ctx, intake, edit, now);
    return;
  }
  // Hold an early edit only within the capture window; it is applied if its original is later admitted.
  if (now - event.timestamp > LINE_CAPTURE_WINDOW_MS || (await heldEdits(ctx, bot._id, event.messageId)).length >= MAX_HELD_EDITS) return;
  await ctx.db.insert("lineCaptureEdits", {
    captureChatId, botId: bot._id, lineChatId: event.lineChatId, messageId: event.messageId, senderDigest: event.senderDigest,
    ...edit, expiresAt: now + LINE_CAPTURE_EDIT_HOLD_MS,
  });
}

async function acceptUnsend(ctx: MutationCtx, bot: Doc<"lineBots">, event: Extract<LineCaptureEvent, { eventType: "unsend" }>, now: number) {
  const chat = await ctx.db.query("lineChats").withIndex("by_bot_chat", q => q.eq("botId", bot._id).eq("lineChatId", event.lineChatId)).unique();
  if (!chat || chat.projectId !== bot.projectId || chat.kind !== event.kind || event.timestamp < chat.joinedAt) return;
  const intake = await ctx.db.query("lineCaptureIntakes").withIndex("by_bot_message", q => q.eq("botId", bot._id).eq("messageId", event.messageId)).unique();
  // Chats that never opted in keep their legacy behavior: no capture fences or dedup rows.
  if (!intake && !(await captureProject(ctx, bot.projectId) && await captureChatOptIn(ctx, chat))) return;
  if (await dedup(ctx, bot._id, event, now)) return;
  if (!await captureMessageUnsent(ctx, bot._id, event.lineChatId, event.messageId)) {
    await ctx.db.insert("lineCaptureUnsends", {
      botId: bot._id, lineChatId: event.lineChatId, messageId: event.messageId, unsentAt: event.timestamp,
      expiresAt: now + LINE_CAPTURE_DEDUP_TTL_MS,
    });
  }
  for (const edit of await heldEdits(ctx, bot._id, event.messageId)) await ctx.db.delete(edit._id);
  if (!intake || intake.chatId !== chat._id || intake.unsentAt !== undefined
    || (event.senderDigest && intake.senderDigest !== event.senderDigest)) return;
  // Linked Tickets keep their reference; LINE-sourced content is hidden.
  await ctx.db.patch(intake._id, {
    text: "", correction: undefined, unsentAt: event.timestamp, revision: intake.revision + 1, updatedAt: now,
    ...(intake.state === "linked" ? {} : { state: "withdrawn" as const, bucket: "done" as const }),
  });
}

/** Persists capture intake inside the webhook accept transaction. */
export async function acceptLineCaptureEvents(ctx: MutationCtx, input: { bot: Doc<"lineBots">; events: LineCaptureEvent[]; now: number }) {
  const { bot, events, now } = input;
  if (!events.length || !captureBot(bot) || !await admittedLineProject(ctx, bot.projectId)) return;
  for (const event of events) {
    if (event.eventType === "unsend") {
      await acceptUnsend(ctx, bot, event, now);
      continue;
    }
    if (event.timestamp < now - LINE_CAPTURE_TTL_MS || event.timestamp > now + FUTURE_SKEW_MS) continue;
    const enrollment = await captureEnrollment(ctx, { botId: bot._id, lineChatId: event.lineChatId, timestamp: event.timestamp });
    if (!enrollment || enrollment.chat.kind !== event.kind) continue;
    if (await captureMessageUnsent(ctx, bot._id, event.lineChatId, event.messageId)) continue;
    if (await dedup(ctx, bot._id, event, now)) continue;
    if (event.eventType === "mention") await acceptMention(ctx, bot, enrollment.chat, enrollment.captureChatId, event, now);
    else await acceptEdit(ctx, bot, enrollment.captureChatId, event, now);
  }
}

/**
 * Bounded expiry sweep. Every expired intake leaves the index head: the first pass redacts all LINE-sourced
 * content and pushes expiry out for its content-free receipts; the second deletes the row with its receipts.
 */
export async function cleanupLineCapture(ctx: MutationCtx, options?: { now?: number; limit?: number }) {
  const empty = { intakes: 0, events: 0, unsends: 0, edits: 0 };
  if (retentionHeld(process.env)) return empty;
  const now = options?.now ?? Date.now();
  const limit = Math.max(1, Math.min(Math.trunc(options?.limit ?? 100) || 100, 200));
  const counts = { ...empty };
  for (const intake of await ctx.db.query("lineCaptureIntakes").withIndex("by_expires_at", q => q.lte("expiresAt", now)).take(limit)) {
    const receipts = await ctx.db.query("lineCaptureReceipts").withIndex("by_intake_candidate", q => q.eq("intakeId", intake._id)).take(MAX_RECEIPTS);
    if (intake.redactedAt === undefined && receipts.length) {
      await ctx.db.patch(intake._id, {
        text: "", correction: undefined, senderDigest: "", redactedAt: now, bucket: "done",
        revision: intake.revision + 1, updatedAt: now, expiresAt: now + LINE_CAPTURE_RECEIPT_TTL_MS,
      });
    } else {
      for (const receipt of receipts) await ctx.db.delete(receipt._id);
      await ctx.db.delete(intake._id);
    }
    counts.intakes++;
  }
  for (const table of ["lineCaptureEvents", "lineCaptureUnsends", "lineCaptureEdits"] as const) {
    const rows = await ctx.db.query(table).withIndex("by_expires_at", q => q.lte("expiresAt", now)).take(limit);
    for (const row of rows) await ctx.db.delete(row._id);
    counts[table === "lineCaptureEvents" ? "events" : table === "lineCaptureUnsends" ? "unsends" : "edits"] = rows.length;
  }
  return counts;
}
