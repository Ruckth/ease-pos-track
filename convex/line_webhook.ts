import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import { internalJobMutation, internalJobQuery, lineWebhookRoute } from "./functions";
import { openLineSecret, verifyLineSignature } from "./line_crypto";
import { admittedLineProject } from "./domain/line";
import {
  acceptLineAiEvents,
  cleanupExpiredLineAiRecords,
  lineAiInboundEvent,
  trimLineAiEvents,
  type LineAiScheduleHook,
} from "./domain/line_ai_intake";
import { inbound } from "./line_schema";
import { hasLegacyAccess } from "./pilot_access";

const event = v.object(inbound);
const lookup = { slug: v.string() };

const scheduleLineAiIntake: LineAiScheduleHook = async (ctx, { intakeId, availableAt }) => {
  await ctx.scheduler.runAfter(Math.max(0, availableAt - Date.now()), internal.line_ai_processing.process, { intakeId });
};

export const cleanupExpiredAiIntake = internalJobMutation({
  name: "line_webhook:cleanupExpiredAiIntake",
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => cleanupExpiredLineAiRecords(ctx, { limit }),
});

export const findBot = internalJobQuery({
  name: "line_webhook:findBot", args: lookup,
  handler: async (ctx, { slug }) => {
    if (!await hasLegacyAccess(ctx)) return null;
    return ctx.db.query("lineBots").withIndex("by_slug", q => q.eq("webhookSlug", slug)).unique();
  },
});

export const signatureFailure = internalJobMutation({
  name: "line_webhook:signatureFailure", args: { botId: v.id("lineBots"), ...lookup },
  handler: async (ctx, { botId, slug }) => {
    const bot = await ctx.db.get(botId);
    if (bot && bot.webhookSlug === slug && await admittedLineProject(ctx, bot.projectId)) await ctx.db.patch(botId, { signatureFailures: bot.signatureFailures + 1 });
  },
});

export const accept = internalJobMutation({
  name: "line_webhook:accept",
  args: {
    botId: v.id("lineBots"),
    ...lookup,
    destination: v.string(),
    verifiedSecretCipher: v.string(),
    events: v.array(event),
    assistantEvents: v.optional(v.array(lineAiInboundEvent)),
  },
  handler: async (ctx, { botId, slug, destination, verifiedSecretCipher, events, assistantEvents }) => {
    const bot = await ctx.db.get(botId);
    if (!bot || bot.webhookSlug !== slug) return 404;
    if (bot.lineUserId !== destination) return 401;
    if (bot.state === "disabled" || !await admittedLineProject(ctx, bot.projectId)) return 200;
    if (bot.secretCipher !== verifiedSecretCipher) return 503;
    // LINE can deliver once the endpoint is saved, before setup settles. Ask it to retry rather than drop the events.
    if (bot.state === "setup") return (events.length || (assistantEvents?.length ?? 0)) ? 503 : 200;
    const now = Date.now();
    await ctx.db.patch(botId, { lastWebhookAt: now });
    for (const fields of events) {
      if (await ctx.db.query("lineInboundEvents").withIndex("by_event",
        q => q.eq("webhookEventId", fields.webhookEventId)).unique()) continue;
      const eventId = await ctx.db.insert("lineInboundEvents", {
        ...fields, botId, state: "pending", attempt: 0, createdAt: now, updatedAt: now,
      });
      await ctx.scheduler.runAfter(0, internal.line_jobs.process, { eventId });
      // A scheduled action can be interrupted before it obtains a lease.
      await ctx.scheduler.runAfter(45_000, internal.line_jobs.process, { eventId });
    }
    if (assistantEvents?.length) {
      await acceptLineAiEvents(ctx, { bot, events: assistantEvents, now }, { onSchedule: scheduleLineAiIntake });
    }
    return 200;
  },
});

function string(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function trimEvent(value: unknown): Infer<typeof event> | undefined {
  if (!value || typeof value !== "object") return;
  const { type, timestamp, source, webhookEventId, replyToken } = value as Record<string, unknown>;
  if (!string(webhookEventId) || typeof timestamp !== "number" || !Number.isSafeInteger(timestamp)
    || timestamp < 0 || !source || typeof source !== "object") return;
  const fields = source as Record<string, unknown>;
  const kind = fields.type;
  if (kind !== "group" && kind !== "room" && kind !== "user") return;
  const lineChatId = fields[kind === "group" ? "groupId" : kind === "room" ? "roomId" : "userId"];
  if (!string(lineChatId)) return;
  if (type === "follow" || type === "unfollow") {
    if (kind !== "user") return;
  } else if (type === "join" || type === "leave" || type === "memberJoined" || type === "memberLeft") {
    if (kind === "user") return;
  } else return;
  return {
    webhookEventId, timestamp, kind, lineChatId, type,
    payload: type === "join" && string(replyToken) ? { replyToken } : {},
  };
}

export async function receiveLineWebhook(ctx: ActionCtx, request: Request) {
  const slug = new URL(request.url).pathname.slice(lineWebhookRoute.pathPrefix.length);
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(slug)) return new Response(null, { status: 404 });
  const bot = await ctx.runQuery(internal.line_webhook.findBot, { slug });
  if (!bot) return new Response(null, { status: 404 });
  const raw = await request.arrayBuffer();
  const signature = request.headers.get("x-line-signature");
  let verified = false;
  let verifiedPending = false;
  // Kept until an update settles, even past its lease, so an interrupted update still gets LINE to retry.
  // A pending secret never stores events: it only answers empty probes and asks LINE to redeliver.
  const pending = bot.pendingSecretCipher;
  if (signature) {
    try {
      verified = await verifyLineSignature(raw, await openLineSecret(bot.secretCipher), signature);
      verifiedPending = !!pending && await verifyLineSignature(raw, await openLineSecret(pending), signature);
    } catch { return new Response("LINE webhook credentials unavailable", { status: 503 }); }
  }
  if (!verified && !verifiedPending) {
    await ctx.runMutation(internal.line_webhook.signatureFailure, { botId: bot._id, slug });
    return new Response(null, { status: 401 });
  }
  let body: { destination?: unknown; events?: unknown };
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return new Response(null, { status: 400 });
  }
  if (body?.destination !== bot.lineUserId) return new Response(null, { status: 401 });
  if (!Array.isArray(body.events)) return new Response(null, { status: 400 });
  // LINE tests send an empty event list. Live events continue using the saved secret; live events
  // signed with the pending secret arrive before the credential update settles, so LINE should retry.
  // A pending-only signature never reaches intake: it stores nothing and leaves webhook activity untouched.
  if (pending && verifiedPending && !verified) return new Response(null, { status: body.events.length ? 503 : 200 });
  if (!(pending && body.events.length === 0 ? verifiedPending : verified)) {
    await ctx.runMutation(internal.line_webhook.signatureFailure, { botId: bot._id, slug });
    return new Response(null, { status: 401 });
  }
  const events = body.events.flatMap(value => {
    const trimmed = trimEvent(value);
    return trimmed ? [trimmed] : [];
  });
  let assistantEvents;
  try {
    assistantEvents = await trimLineAiEvents(bot._id, body.events);
  } catch {
    return new Response("LINE webhook credentials unavailable", { status: 503 });
  }
  const status = await ctx.runMutation(internal.line_webhook.accept, {
    botId: bot._id, slug, destination: body.destination, verifiedSecretCipher: bot.secretCipher, events,
    ...(assistantEvents.length ? { assistantEvents } : {}),
  });
  return new Response(null, { status });
}
