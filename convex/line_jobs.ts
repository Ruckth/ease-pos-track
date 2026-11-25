import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { admittedLineProject } from "./domain/line";
import { createLine } from "./adapters/line";
import { internalJobAction, internalJobMutation } from "./functions";
import { openLineSecret } from "./line_crypto";

const id = { eventId: v.id("lineInboundEvents") };
const lease = { ...id, leaseId: v.string() };
const maxAttempts = 3;
const leaseMs = 45_000;

export const claim = internalJobMutation({
  name: "line_jobs:claim", args: id,
  handler: async (ctx, { eventId }) => {
    const event = await ctx.db.get(eventId);
    const now = Date.now();
    if (!event || event.state !== "pending" || (event.leaseExpiresAt ?? 0) > now) return null;
    const bot = await ctx.db.get(event.botId);
    const project = bot && await admittedLineProject(ctx, bot.projectId);
    if (!bot || bot.state === "disabled" || bot.state === "setup" || !project) {
      await ctx.db.patch(eventId, { state: "ignored", payload: {}, updatedAt: now, leaseId: undefined, leaseExpiresAt: undefined });
      return null;
    }
    if (event.attempt >= maxAttempts) {
      await ctx.db.patch(eventId, { state: "failed", error: "LINE_JOB_LEASE_EXPIRED", payload: {}, updatedAt: now,
        leaseId: undefined, leaseExpiresAt: undefined });
      return null;
    }
    const leaseId = crypto.randomUUID();
    await ctx.db.patch(eventId, { leaseId, leaseExpiresAt: now + leaseMs, attempt: event.attempt + 1, updatedAt: now });
    await ctx.scheduler.runAfter(leaseMs, internal.line_jobs.process, { eventId });
    return { event, leaseId, bot };
  },
});

export const fail = internalJobMutation({
  name: "line_jobs:fail", args: { ...lease, error: v.string() },
  handler: async (ctx, { eventId, leaseId, error }) => {
    const event = await ctx.db.get(eventId);
    if (!event || event.state !== "pending" || event.leaseId !== leaseId) return;
    const bot = await ctx.db.get(event.botId);
    if (!bot || bot.state === "disabled" || bot.state === "setup" || !await admittedLineProject(ctx, bot.projectId)) {
      await ctx.db.patch(eventId, {
        state: "ignored", payload: {}, error: undefined, updatedAt: Date.now(),
        leaseId: undefined, leaseExpiresAt: undefined,
      });
      return;
    }
    const exhausted = event.attempt >= maxAttempts;
    await ctx.db.patch(eventId, {
      state: exhausted ? "failed" : "pending", error, updatedAt: Date.now(),
      leaseId: undefined, leaseExpiresAt: undefined, ...(exhausted ? { payload: {} } : {}),
    });
    if (!exhausted) await ctx.scheduler.runAfter(event.attempt * 2_000, internal.line_jobs.process, { eventId });
  },
});

const metadata = {
  name: v.optional(v.string()), pictureUrl: v.optional(v.string()), memberCount: v.optional(v.number()),
};

export const finish = internalJobMutation({
  name: "line_jobs:finish", args: { ...lease, ...metadata },
  handler: async (ctx, { eventId, leaseId, name, pictureUrl, memberCount }) => {
    const event = await ctx.db.get(eventId);
    if (!event || event.state !== "pending" || event.leaseId !== leaseId
      || (event.leaseExpiresAt ?? 0) <= Date.now()) return false;
    const { botId, lineChatId, kind, type, timestamp } = event;
    const bot = await ctx.db.get(botId);
    const project = bot && await admittedLineProject(ctx, bot.projectId);
    const chat = await ctx.db.query("lineChats").withIndex("by_bot_chat",
      q => q.eq("botId", botId).eq("lineChatId", lineChatId)).unique();
    const members = type === "memberJoined" || type === "memberLeft";
    const leaving = type === "leave" || type === "unfollow";
    const stale = chat && (timestamp < chat.lastEventAt || (members && timestamp < (chat.lastMembershipAt ?? 0))
      || (!leaving && timestamp === chat.lastEventAt && chat.state === "left"));
    const ignored = !bot || bot.state === "disabled" || bot.state === "setup" || !project
      || stale || (members && (!chat || chat.state === "left"));
    let reply = false;
    if (!ignored) {
      if (members && chat) {
        await ctx.db.patch(chat._id, { ...known({ memberCount }), lastMembershipAt: timestamp });
      } else if (leaving) {
        if (chat) await ctx.db.patch(chat._id, {
          state: "left", leftAt: timestamp, lastEventAt: timestamp,
          assistantEnabled: false, assistantEnabledAt: undefined,
          assistantRevision: (chat.assistantRevision ?? 0) + 1,
        });
        else await ctx.db.insert("lineChats", {
          botId, projectId: bot.projectId, kind, lineChatId, name: fallbackName(kind),
          state: "left", joinedAt: timestamp, leftAt: timestamp, lastEventAt: timestamp, notify: "own", allowCreate: true,
        });
      } else {
        const newJoin = !chat || chat.state === "left" || chat.state === "rejected" || timestamp > chat.joinedAt;
        const state = kind === "user" && bot.allowDirectChats ? "active" : "pending";
        // A failed lookup keeps what is already known rather than clearing it.
        const fields = { name: name ?? chat?.name ?? fallbackName(kind), ...known({ pictureUrl, memberCount }), lastEventAt: timestamp };
        if (!chat) await ctx.db.insert("lineChats", {
          ...fields, botId, projectId: bot.projectId, kind, lineChatId, state,
          joinedAt: timestamp, notify: "own", allowCreate: true,
        });
        else await ctx.db.patch(chat._id, {
          ...fields, ...(newJoin ? {
            state, joinedAt: timestamp, leftAt: undefined, approvedAt: undefined, approvedBy: undefined,
            ownerCustomerId: undefined, displayNameOverride: undefined, notify: "own" as const, allowCreate: true,
            lastMembershipAt: undefined, assistantEnabled: false, assistantEnabledAt: undefined,
            assistantRevision: (chat.assistantRevision ?? 0) + 1,
          } : {}),
        });
        reply = newJoin && type === "join";
      }
    }
    await ctx.db.patch(eventId, {
      state: ignored ? "ignored" : "done", payload: {}, error: undefined,
      updatedAt: Date.now(), leaseId: undefined, leaseExpiresAt: undefined,
    });
    return reply;
  },
});

function known<T extends object>(values: T): Partial<T> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function fallbackName(kind: Doc<"lineChats">["kind"]) {
  return { group: "LINE group", room: "LINE room", user: "LINE user" }[kind];
}

export const process = internalJobAction({
  name: "line_jobs:process", args: id,
  handler: async (ctx, { eventId }): Promise<void> => {
    const job = await ctx.runMutation(internal.line_jobs.claim, { eventId });
    if (!job) return;
    const { event, bot, leaseId } = job;
    const { kind, type, lineChatId, payload } = event;
    try {
      if (type === "leave" || type === "unfollow") {
        await ctx.runMutation(internal.line_jobs.finish, { eventId, leaseId });
        return;
      }
      const line = createLine(await openLineSecret(bot.tokenCipher));
      const joining = type === "join" || type === "follow";
      // Names and counts are best effort: a LINE outage must never cost staff the enrollment itself.
      const optional = <T>(call: Promise<T> | undefined) => call?.catch(() => undefined);
      const [group, user, count] = await Promise.all([
        optional(joining && kind === "group" ? line.groupSummary(lineChatId) : undefined),
        optional(joining && kind === "user" ? line.profile(lineChatId) : undefined),
        optional(kind !== "user" ? line.count(kind, lineChatId) : undefined),
      ]);
      const reply = await ctx.runMutation(internal.line_jobs.finish, {
        eventId, leaseId, name: group?.groupName ?? user?.displayName,
        pictureUrl: group?.pictureUrl ?? user?.pictureUrl, memberCount: count?.count,
      });
      if (reply && payload.replyToken && Date.now() - event.createdAt < 60_000) {
        const text = bot.locale === "th" ? "ขอบคุณที่เพิ่มบอท ทีมงานจะอนุมัติกลุ่มนี้เร็ว ๆ นี้"
          : "Thanks for adding this bot. Staff will approve this group soon.";
        await line.reply(payload.replyToken, text).catch(() => {});
      }
    } catch (error) {
      await ctx.runMutation(internal.line_jobs.fail, {
        eventId, leaseId, error: error instanceof Error && error.message === "LINE_SECRETS_KEY_INVALID"
          ? error.message : "LINE_EVENT_PROCESSING_FAILED",
      });
    }
  },
});
