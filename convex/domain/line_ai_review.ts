import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { formatTicketNumber, parseTicketReference } from "../../shared/ticket-numbers";
import { admittedLineProject } from "./line";
import { lineAiReleaseEnabled, readLineAiConnection } from "./line_ai_settings";

type DbContext = Pick<QueryCtx, "db">;
type Enrollment = Pick<Doc<"lineAiReplies">, "botId" | "chatId" | "projectId" | "joinedAt">
  & Partial<Pick<Doc<"lineAiReplies">, "chatRevision" | "botRevision" | "projectVisibilityVersion" | "connectionRevision">>;

export const replyFreshnessMs = 6 * 60 * 60_000;
export const replyHistoryMs = 7 * 24 * 60 * 60_000;
export const replyAttempts = 3;

/** The same enrollment owns analysis, approval and outbound delivery. */
export async function assistantEnrollment(ctx: DbContext, scope: Enrollment) {
  if (!await lineAiReleaseEnabled(ctx)) return null;
  const [project, bot, chat, connection] = await Promise.all([
    admittedLineProject(ctx, scope.projectId),
    ctx.db.get(scope.botId),
    ctx.db.get(scope.chatId),
    readLineAiConnection(ctx, scope.projectId),
  ]);
  if (!project || !bot || bot.state !== "active" || bot.projectId !== project._id
    || !chat || chat.state !== "active" || chat.assistantEnabled !== true || chat.botId !== bot._id
    || chat.projectId !== project._id || chat.joinedAt !== scope.joinedAt || !connection?.enabled || !connection.keyCipher) return null;
  if ((scope.chatRevision !== undefined && (chat.assistantRevision ?? 0) !== scope.chatRevision)
    || (scope.botRevision !== undefined && (bot.assistantRevision ?? 0) !== scope.botRevision)
    || (scope.projectVisibilityVersion !== undefined && (project.inboxVisibilityVersion ?? 0) !== scope.projectVisibilityVersion)
    || (scope.connectionRevision !== undefined && connection.revision !== scope.connectionRevision)) return null;
  return { project, bot, chat, connection };
}

export async function linkedTicket(
  ctx: DbContext, chat: Doc<"lineChats">, project: Doc<"projects">, reference: string | null,
) {
  const parsed = reference && parseTicketReference(reference);
  if (!parsed || parsed.projectKey !== project.key) return null;
  const link = await ctx.db.query("lineAiTicketLinks").withIndex("by_chat_ticket",
    q => q.eq("chatId", chat._id).eq("joinedAt", chat.joinedAt).eq("ticketNumber", parsed.ticketNumber)).unique();
  if (!link || link.projectId !== project._id) return null;
  const ticket = await ctx.db.get(link.ticketId);
  if (!ticket || ticket.projectId !== project._id || ticket.lifecycle !== "active" || ticket.status === "done") return null;
  return ticket;
}

export async function currentChatOwner(ctx: DbContext, chat: Doc<"lineChats">): Promise<Id<"customers"> | undefined> {
  if (!chat.ownerCustomerId) return undefined;
  const [customer, membership] = await Promise.all([
    ctx.db.get(chat.ownerCustomerId),
    ctx.db.query("projectMembers").withIndex("by_project",
      q => q.eq("projectId", chat.projectId).eq("customerId", chat.ownerCustomerId!)).unique(),
  ]);
  if (customer?.status !== "active" || !membership) throw new Error("LINE_OWNER_NOT_PROJECT_MEMBER");
  return customer._id;
}

export function validatedLineReply(input: string, ticket?: Doc<"tickets">) {
  const number = ticket && formatTicketNumber(ticket.ticketNumber, ticket.projectKey);
  const reply = input.trim();
  if (!reply) throw new Error("LINE_AI_REPLY_REQUIRED");
  const text = number
    ? reply.includes("{ticket}") ? reply.replace(/\{ticket\}/g, number) : `${reply}\n${number}`
    : reply;
  if (text.length > 2000) throw new Error("LINE_AI_REPLY_TOO_LONG");
  return { text, number };
}

export function reviewReplyDefaults(locale: "th" | "en", attachmentUnavailable: boolean) {
  if (locale === "th") return {
    create: "เปิด Ticket {ticket} แล้ว ทีมงานจะติดตามทางแชตนี้",
    close: "ปิด Ticket {ticket} แล้ว ขอบคุณที่ยืนยันผล",
    clarify: attachmentUnavailable ? "รบกวนส่งไฟล์แนบอีกครั้งได้ไหม" : "รบกวนบอกรายละเอียดเพิ่มเติมได้ไหม",
  };
  return {
    create: "We opened Ticket {ticket}. Our team will follow up here.",
    close: "We marked Ticket {ticket} done. Thanks for confirming.",
    clarify: attachmentUnavailable ? "Could you send the attachment again?" : "Could you share a little more detail?",
  };
}
