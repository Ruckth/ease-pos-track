import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { hasLegacyAccess } from "../pilot_access";

type DbContext = Pick<QueryCtx, "db">;

export async function lineProject(ctx: DbContext, id: Id<"projects">) {
  if (!await hasLegacyAccess(ctx)) throw new Error("LEGACY_ACCESS_DISABLED");
  if (!await currentLineProject(ctx, id)) throw new Error("PROJECT_NOT_FOUND");
}

export async function admittedLineProject(ctx: DbContext, id: Id<"projects">) {
  return await hasLegacyAccess(ctx) ? currentLineProject(ctx, id) : null;
}

async function currentLineProject(ctx: DbContext, id: Id<"projects">) {
  const project = await ctx.db.get(id);
  return project && project.archivedAt === undefined ? project : null;
}

export async function lineBot(ctx: DbContext, id: Id<"lineBots">) {
  const bot = await ctx.db.get(id);
  if (!bot) throw new Error("LINE_BOT_NOT_FOUND");
  await lineProject(ctx, bot.projectId);
  return bot;
}

export async function lineChat(ctx: DbContext, id: Id<"lineChats">) {
  const chat = await ctx.db.get(id);
  if (!chat) throw new Error("LINE_CHAT_NOT_FOUND");
  await lineProject(ctx, chat.projectId);
  return chat;
}

export function webhookUrl(slug: string) {
  if (!process.env.CONVEX_SITE_URL) throw new Error("LINE_SITE_URL_MISSING");
  return new URL("/line/webhook/" + slug, process.env.CONVEX_SITE_URL).href;
}

export function publicBot(bot: Doc<"lineBots">) {
  const { secretCipher, tokenCipher, endpointLease, pendingSecretCipher, ...publicFields } = bot;
  return { ...publicFields, webhookUrl: webhookUrl(bot.webhookSlug) };
}
