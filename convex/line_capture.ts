import { paginationOptsValidator } from "convex/server";
import { v, type Infer } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { actorFields } from "./authz";
import { lineChat, lineProject } from "./domain/line";
import { currentLineLifecycle, currentChatOwner } from "./domain/line_ai_review";
import {
  captureBot, captureChatOptIn, captureProject, cleanupLineCapture, currentCaptureIntake, lineCaptureEnabled, openLegacyAiWork,
} from "./domain/line_capture";
import { createTicketRecord } from "./domain/tickets";
import { internalJobMutation, ownerMutation, staffMutation, staffQuery } from "./functions";
import { hashTicketRequest } from "./ticket_requests";
import { formatTicketNumber } from "../shared/ticket-numbers";
import { validateTicketText } from "../shared/ticket-state";

const project = { projectId: v.id("projects") };
const emptyPage: { page: never[]; isDone: true; continueCursor: string } = { page: [], isDone: true, continueCursor: "" };

function requireNamedStaff(ctx: { session: Doc<"sessionAdmissions"> }) {
  const staffId = ctx.session.staffId;
  if (!staffId) throw new Error("NAMED_STAFF_REQUIRED");
  return staffId;
}

function requireCapture() {
  if (!lineCaptureEnabled()) throw new Error("LINE_CAPTURE_DISABLED");
}

export const setProjectCapture = ownerMutation({
  name: "line_capture:setProjectCapture", args: { ...project, enabled: v.boolean() },
  handler: async (ctx, { projectId, enabled }) => {
    const staffId = requireNamedStaff(ctx);
    await lineProject(ctx, projectId);
    const existing = await captureProject(ctx, projectId);
    if (!enabled) {
      if (!existing) return;
      for (const optIn of await ctx.db.query("lineCaptureChats").withIndex("by_project", q => q.eq("projectId", projectId)).take(50)) {
        await ctx.db.delete(optIn._id);
      }
      await ctx.db.delete(existing._id);
      return;
    }
    requireCapture();
    if (existing) return;
    // M1 admits one approved Project after legacy intake and delivery have settled.
    if (await ctx.db.query("lineCaptureProjects").first()) throw new Error("LINE_CAPTURE_PROJECT_LIMIT");
    if (await openLegacyAiWork(ctx, projectId)) throw new Error("LINE_CAPTURE_AI_WORK_OPEN");
    await ctx.db.insert("lineCaptureProjects", { projectId, enabledAt: Date.now(), enabledBy: staffId });
  },
});

export const setChatCapture = staffMutation({
  name: "line_capture:setChatCapture", args: { chatId: v.id("lineChats"), joinedAt: v.number(), enabled: v.boolean() },
  handler: async (ctx, { chatId, joinedAt, enabled }) => {
    const staffId = requireNamedStaff(ctx);
    const chat = await lineChat(ctx, chatId);
    if (chat.joinedAt !== joinedAt) throw new Error("LINE_CHAT_ENROLLMENT_CHANGED");
    const existing = await captureChatOptIn(ctx, chat);
    if (!enabled) {
      if (existing) await ctx.db.delete(existing._id);
      return;
    }
    requireCapture();
    if (existing) return;
    const bot = await ctx.db.get(chat.botId);
    if (!captureBot(bot) || bot!.projectId !== chat.projectId) throw new Error("LINE_CAPTURE_FIXTURE_BOT_REQUIRED");
    if (!await captureProject(ctx, chat.projectId)) throw new Error("LINE_CAPTURE_PROJECT_DISABLED");
    if (chat.kind === "user" || chat.state !== "active" || !await currentLineLifecycle(ctx, chat)) throw new Error("LINE_CHAT_STATE_CHANGED");
    if (chat.assistantEnabled) throw new Error("LINE_AI_ENABLED_FOR_CHAT");
    // M1 admits one approved group.
    if (await ctx.db.query("lineCaptureChats").first()) throw new Error("LINE_CAPTURE_CHAT_LIMIT");
    await ctx.db.insert("lineCaptureChats", {
      projectId: chat.projectId, botId: chat.botId, chatId, joinedAt, enabledAt: Date.now(), enabledBy: staffId,
    });
  },
});

export const settings = staffQuery({
  name: "line_capture:settings", args: project,
  handler: async (ctx, { projectId }) => {
    await lineProject(ctx, projectId);
    const chats = await ctx.db.query("lineCaptureChats").withIndex("by_project", q => q.eq("projectId", projectId)).take(50);
    return {
      available: lineCaptureEnabled(),
      projectEnabled: !!await captureProject(ctx, projectId),
      chats: chats.map(row => ({ chatId: row.chatId, joinedAt: row.joinedAt, enabled: true })),
    };
  },
});

async function receiptView(ctx: Pick<QueryCtx, "db">, row: Doc<"lineCaptureReceipts">) {
  const ticket = row.ticketId ? await ctx.db.get(row.ticketId) : null;
  return {
    receiptId: row._id, candidateKey: row.candidateKey, operation: row.operation,
    ...(row.ticketId ? { ticketId: row.ticketId, number: row.ticketNumber } : {}),
    ...(ticket && ticket.projectId === row.projectId && ticket.lifecycle === "active" ? { title: ticket.title } : {}),
  };
}

export const list = staffQuery({
  name: "line_capture:list",
  args: { ...project, view: v.union(v.literal("open"), v.literal("done")), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { projectId, view, paginationOpts }) => {
    const owner = await lineProject(ctx, projectId);
    if (!Number.isInteger(paginationOpts.numItems) || paginationOpts.numItems < 1 || paginationOpts.numItems > 50) throw new Error("INVALID_INPUT");
    if (!lineCaptureEnabled()) return emptyPage;
    const now = Date.now();
    const rows = await ctx.db.query("lineCaptureIntakes").withIndex("by_project_bucket", q => q.eq("projectId", projectId).eq("bucket", view))
      .order("desc").paginate({ ...paginationOpts, maximumRowsRead: 50 });
    const page = await Promise.all(rows.page.map(async intake => {
      const [chat, current, receipts] = await Promise.all([
        ctx.db.get(intake.chatId), currentCaptureIntake(ctx, intake._id, now),
        ctx.db.query("lineCaptureReceipts").withIndex("by_intake_candidate", q => q.eq("intakeId", intake._id)).take(10),
      ]);
      const open = intake.state !== "linked" && intake.state !== "dismissed" && intake.state !== "withdrawn";
      const expired = open && intake.expiresAt <= now;
      const failed = open && !current;
      // LINE-sourced content is shown only while the intake is still admitted (linked ones included).
      const visible = !!current && chat?.projectId === owner._id;
      return {
        _id: intake._id, state: failed ? "failed" as const : intake.state, revision: intake.revision, expiresAt: intake.expiresAt,
        chatName: visible ? chat!.displayNameOverride ?? chat!.name : "",
        kind: intake.kind, text: visible ? intake.text : "", createdAt: intake.createdAt, updatedAt: intake.updatedAt,
        conflict: intake.conflict === true, unsent: intake.unsentAt !== undefined,
        ...(failed ? { warning: expired ? "LINE_CAPTURE_EXPIRED" : "LINE_CAPTURE_CHAT_UNAVAILABLE" }
          : intake.warning ? { warning: intake.warning } : {}),
        correction: visible ? intake.correction ?? null : null,
        canCreate: !!current && !!chat?.allowCreate,
        receipts: await Promise.all(receipts.map(row => receiptView(ctx, row))),
      };
    }));
    return { ...rows, page };
  },
});

const operation = v.union(
  v.object({ type: v.literal("create"), title: v.string(), description: v.string() }),
  v.object({ type: v.literal("link"), ticketId: v.id("tickets"), expectedTicketVersion: v.number() }),
  v.object({ type: v.literal("dismiss") }),
);

function normalized(candidateKey: string, input: Infer<typeof operation>) {
  if (input.type === "create") return { candidateKey, type: input.type, ...validateTicketText(input.title, input.description) };
  if (input.type === "link") {
    if (!Number.isSafeInteger(input.expectedTicketVersion) || input.expectedTicketVersion < 0) throw new Error("INVALID_INPUT");
    return { candidateKey, type: input.type, ticketId: input.ticketId, expectedTicketVersion: input.expectedTicketVersion };
  }
  return { candidateKey, type: input.type };
}

export const finish = staffMutation({
  name: "line_capture:finish",
  args: { intakeId: v.id("lineCaptureIntakes"), expectedRevision: v.number(), candidateKey: v.optional(v.string()), operation },
  handler: async (ctx, { intakeId, expectedRevision, candidateKey = "primary", operation: input }) => {
    const staffId = requireNamedStaff(ctx);
    if (!/^[a-z0-9-]{1,32}$/.test(candidateKey)) throw new Error("INVALID_INPUT");
    const intake = await ctx.db.get(intakeId);
    if (!intake) throw new Error("LINE_CAPTURE_UNAVAILABLE");
    const target = await lineProject(ctx, intake.projectId);
    requireCapture();
    const { inputDigest: digest } = await hashTicketRequest(JSON.stringify(normalized(candidateKey, input)));
    const prior = await ctx.db.query("lineCaptureReceipts")
      .withIndex("by_intake_candidate", q => q.eq("intakeId", intakeId).eq("candidateKey", candidateKey)).unique();
    if (prior) {
      if (prior.digest !== digest) throw new Error("LINE_CAPTURE_CONFLICT");
      return receiptView(ctx, prior);
    }
    if (intake.revision !== expectedRevision) throw new Error("LINE_CAPTURE_REVISION_CHANGED");
    const now = Date.now();
    if (!await currentCaptureIntake(ctx, intakeId, now)) throw new Error("LINE_CAPTURE_UNAVAILABLE");
    if (input.type === "dismiss" && intake.state === "linked") throw new Error("LINE_CAPTURE_ALREADY_LINKED");
    const chat = await ctx.db.get(intake.chatId);
    if (!chat || chat.projectId !== target._id) throw new Error("LINE_CAPTURE_UNAVAILABLE");
    // Receipts are bounded so expiry can always remove them with their intake.
    if ((await ctx.db.query("lineCaptureReceipts").withIndex("by_intake_candidate", q => q.eq("intakeId", intakeId)).take(10)).length >= 10) {
      throw new Error("LINE_CAPTURE_CANDIDATE_LIMIT");
    }

    let ticket: Doc<"tickets"> | null = null;
    if (input.type === "create") {
      if (!chat.allowCreate) throw new Error("LINE_AI_CREATE_DISABLED");
      const text = validateTicketText(input.title, input.description);
      const ownerCustomerId = await currentChatOwner(ctx, chat);
      ticket = await createTicketRecord(ctx, {
        project: target, ...text, media: [],
        ownership: { origin: "staff", ...(ownerCustomerId && { ownerCustomerId }) },
        author: { ...actorFields(ctx.actor), sessionId: ctx.session._id, createdVia: "line" as const }, now,
      });
    } else if (input.type === "link") {
      ticket = await ctx.db.get(input.ticketId);
      // A Ticket from another Project is indistinguishable from a missing one.
      if (!ticket || ticket.projectId !== target._id || ticket.lifecycle !== "active") throw new Error("LINE_CAPTURE_TICKET_UNAVAILABLE");
      if (ticket.version !== input.expectedTicketVersion) throw new Error("LINE_CAPTURE_TICKET_CHANGED");
    }
    const receiptId = await ctx.db.insert("lineCaptureReceipts", {
      intakeId, projectId: target._id, candidateKey, operation: input.type, digest, intakeRevision: intake.revision,
      staffId, sessionId: ctx.session._id, sourceChatId: chat._id, createdAt: now,
      ...(ticket ? { ticketId: ticket._id, ticketNumber: formatTicketNumber(ticket.ticketNumber, ticket.projectKey) } : {}),
    });
    await ctx.db.patch(intakeId, input.type === "dismiss"
      ? { state: "dismissed", bucket: "done", text: "", correction: undefined, updatedAt: now }
      : { state: "linked", bucket: "done", conflict: undefined, updatedAt: now });
    return receiptView(ctx, (await ctx.db.get(receiptId))!);
  },
});

export const acknowledgeCorrection = staffMutation({
  name: "line_capture:acknowledgeCorrection", args: { intakeId: v.id("lineCaptureIntakes"), expectedRevision: v.number() },
  handler: async (ctx, { intakeId, expectedRevision }) => {
    requireNamedStaff(ctx);
    const intake = await currentCaptureIntake(ctx, intakeId);
    if (!intake) throw new Error("LINE_CAPTURE_UNAVAILABLE");
    await lineProject(ctx, intake.projectId);
    if (intake.revision !== expectedRevision) throw new Error("LINE_CAPTURE_REVISION_CHANGED");
    if (!intake.correction) return;
    await ctx.db.patch(intakeId, {
      correction: undefined, conflict: undefined, revision: intake.revision + 1, updatedAt: Date.now(),
    });
  },
});

export const cleanup = internalJobMutation({
  name: "line_capture:cleanup", args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => cleanupLineCapture(ctx, { limit }),
});
