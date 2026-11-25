import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { actorFields } from "./authz";
import { lineProject } from "./domain/line";
import {
  assistantEnrollment, currentChatOwner, linkedTicket, replyAttempts, replyFreshnessMs, replyHistoryMs, reviewReplyDefaults, validatedLineReply,
} from "./domain/line_ai_review";
import { lineAiReleaseEnabled, readLineAiConnection } from "./domain/line_ai_settings";
import { applyTicketChange, createTicketRecord } from "./domain/tickets";
import { staffMutation, staffQuery } from "./functions";
import { formatTicketNumber } from "../shared/ticket-numbers";
import { validateTicketText } from "../shared/ticket-state";

const project = { projectId: v.id("projects") };
const draftId = { draftId: v.id("lineAiDrafts") };
const replyId = { replyId: v.id("lineAiReplies") };

async function currentDraft(ctx: Pick<QueryCtx, "db">, draft: Doc<"lineAiDrafts">, now: number) {
  if (draft.state !== "review" || draft.expiresAt <= now) return null;
  const intake = await ctx.db.get(draft.intakeId);
  if (!intake || intake.projectId !== draft.projectId || intake.state !== "draft" || intake.expiresAt <= now) return null;
  const enrollment = await assistantEnrollment(ctx, { ...intake, connectionRevision: draft.connectionRevision });
  return enrollment && { ...enrollment, intake };
}

function replyReceipt(row: Doc<"lineAiReplies">, now: number) {
  return {
    _id: row._id, draftId: row.draftId, number: row.ticketNumber,
    state: row.state, updatedAt: row.updatedAt,
    canRetry: row.state === "unknown" && !!row.text && row.attempt < replyAttempts && row.expiresAt > now,
  };
}

export const list = staffQuery({
  name: "line_ai_reviews:list", args: project,
  handler: async (ctx, { projectId }) => {
    if (!await lineAiReleaseEnabled(ctx)) return { drafts: [], replies: [] };
    await lineProject(ctx, projectId);
    const now = Date.now();
    const connection = await readLineAiConnection(ctx, projectId);
    const [rows, replies] = await Promise.all([
      connection?.enabled ? ctx.db.query("lineAiDrafts").withIndex("by_project_state",
        q => q.eq("projectId", projectId).eq("state", "review").eq("connectionRevision", connection.revision)
          .gt("expiresAt", now)).order("desc").take(25) : [],
      ctx.db.query("lineAiReplies").withIndex("by_project", q => q.eq("projectId", projectId)).order("desc").take(20),
    ]);
    const drafts = await Promise.all(rows.map(async draft => {
      const current = await currentDraft(ctx, draft, now);
      if (!current) return null;
      const { intake, bot, chat, project } = current;
      const suggested = draft.suggestion;
      const target = suggested.intent === "close" && await linkedTicket(ctx, chat, project, suggested.ticketNumber);
      return {
        _id: draft._id, warning: draft.warning, createdAt: draft.createdAt,
        chatName: chat.displayNameOverride ?? chat.name, kind: chat.kind, text: intake.text,
        suggestion: suggested, canCreate: chat.allowCreate,
        replies: reviewReplyDefaults(bot.locale, draft.warning === "LINE_AI_ATTACHMENT_UNAVAILABLE"),
        target: target ? {
          number: formatTicketNumber(target.ticketNumber, target.projectKey),
          title: target.title, version: target.version,
        } : null,
      };
    }));
    return { drafts: drafts.filter(draft => draft !== null), replies: replies.map(row => replyReceipt(row, now)) };
  },
});

const decision = v.union(
  v.object({ type: v.literal("create"), title: v.string(), description: v.string(), reply: v.string() }),
  v.object({ type: v.literal("close"), ticketVersion: v.number(), reply: v.string() }),
  v.object({ type: v.literal("clarify"), reply: v.string() }),
);

export const approve = staffMutation({
  name: "line_ai_reviews:approve", args: { ...draftId, decision },
  handler: async (ctx, { draftId, decision }) => {
    const draft = await ctx.db.get(draftId);
    if (!draft) throw new Error("LINE_AI_DRAFT_UNAVAILABLE");
    await lineProject(ctx, draft.projectId);
    const now = Date.now();
    const receipt = await ctx.db.query("lineAiReplies").withIndex("by_draft", q => q.eq("draftId", draftId)).unique();
    if (receipt) return replyReceipt(receipt, now);
    const current = await currentDraft(ctx, draft, now);
    if (!current) throw new Error("LINE_AI_DRAFT_UNAVAILABLE");
    const staffId = ctx.session.staffId;
    if (!staffId) throw new Error("NAMED_STAFF_REQUIRED");
    const { project, chat, bot, connection, intake } = current;
    const author = { ...actorFields(ctx.actor), sessionId: ctx.session._id, createdVia: "line" as const };

    let ticket: Doc<"tickets"> | undefined;
    if (decision.type === "create") {
      if (!chat.allowCreate) throw new Error("LINE_AI_CREATE_DISABLED");
      const text = validateTicketText(decision.title, decision.description);
      const ownerCustomerId = await currentChatOwner(ctx, chat);
      ticket = await createTicketRecord(ctx, {
        project, ...text, media: [],
        ownership: { origin: "staff", ...(ownerCustomerId && { ownerCustomerId }) },
        author, now,
      });
      await ctx.db.insert("lineAiTicketLinks", {
        projectId: project._id, chatId: chat._id, joinedAt: chat.joinedAt,
        ticketId: ticket._id, ticketNumber: ticket.ticketNumber,
      });
    } else if (decision.type === "close") {
      const target = draft.suggestion.intent === "close"
        ? await linkedTicket(ctx, chat, project, draft.suggestion.ticketNumber) : null;
      if (!target) throw new Error("LINE_AI_TICKET_NOT_LINKED");
      await applyTicketChange(ctx, {
        doc: target, expectedVersion: decision.ticketVersion, changes: { status: "done" },
        action: "status_changed", author, now,
      });
      ticket = target;
    }
    const { text, number } = validatedLineReply(decision.reply, ticket);
    const replyId = await ctx.db.insert("lineAiReplies", {
      draftId, projectId: project._id, botId: bot._id, chatId: chat._id,
      joinedAt: chat.joinedAt, chatRevision: chat.assistantRevision ?? 0, botRevision: bot.assistantRevision ?? 0,
      connectionRevision: connection.revision, projectVisibilityVersion: project.inboxVisibilityVersion ?? 0,
      ...(ticket && { ticketId: ticket._id, ticketNumber: number, ticketVisibilityVersion: ticket.inboxVisibilityVersion ?? 0 }),
      authorStaffId: staffId, text, retryKey: crypto.randomUUID(),
      state: "pending", attempt: 0, createdAt: now, updatedAt: now,
      expiresAt: now + replyFreshnessMs, eraseTextAt: now + replyFreshnessMs, deleteAt: now + replyHistoryMs,
    });
    await ctx.db.patch(draftId, { state: "acted" });
    await ctx.db.patch(intake._id, { state: "acted", text: "", files: [] });
    await ctx.scheduler.runAfter(0, internal.line_ai_delivery.send, { replyId });
    return replyReceipt((await ctx.db.get(replyId))!, now);
  },
});

export const dismiss = staffMutation({
  name: "line_ai_reviews:dismiss", args: draftId,
  handler: async (ctx, { draftId }) => {
    const draft = await ctx.db.get(draftId);
    if (!draft) throw new Error("LINE_AI_DRAFT_UNAVAILABLE");
    await lineProject(ctx, draft.projectId);
    const current = await currentDraft(ctx, draft, Date.now());
    if (!current) throw new Error("LINE_AI_DRAFT_UNAVAILABLE");
    await ctx.db.patch(draftId, { state: "dismissed" });
    await ctx.db.patch(current.intake._id, { state: "ignored", text: "", files: [] });
  },
});

export const retryReply = staffMutation({
  name: "line_ai_reviews:retryReply", args: replyId,
  handler: async (ctx, { replyId }) => {
    const row = await ctx.db.get(replyId);
    const now = Date.now();
    if (!row || !replyReceipt(row, now).canRetry || !await assistantEnrollment(ctx, row)) {
      throw new Error("LINE_AI_REPLY_UNAVAILABLE");
    }
    await ctx.db.patch(replyId, { state: "pending", updatedAt: now });
    await ctx.scheduler.runAfter(0, internal.line_ai_delivery.send, { replyId });
  },
});
