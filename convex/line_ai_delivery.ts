import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import { createLine } from "./adapters/line";
import { currentReplyDestination, replyAttempts } from "./domain/line_ai_review";
import { lineAiReleaseEnabled } from "./domain/line_ai_settings";
import { internalJobAction, internalJobMutation, internalJobQuery } from "./functions";
import { lineAiReplyResult } from "./line_ai_review_schema";
import { openLineSecret } from "./line_crypto";

const reply = { replyId: v.id("lineAiReplies") };
const lease = { ...reply, leaseId: v.string() };
const leaseMs = 45_000;

export const recover = internalJobMutation({
  name: "line_ai_delivery:recover", args: {},
  handler: async (ctx) => {
    if (!await lineAiReleaseEnabled(ctx)) return;
    const now = Date.now();
    const rows = await ctx.db.query("lineAiReplies").withIndex("by_state_updated",
      q => q.eq("state", "pending").lte("updatedAt", now - 30_000)).take(50);
    for (const row of rows) {
      if ((row.leaseExpiresAt ?? 0) <= now) await ctx.scheduler.runAfter(0, internal.line_ai_delivery.send, { replyId: row._id });
    }
  },
});

export const claim = internalJobMutation({
  name: "line_ai_delivery:claim", args: reply,
  handler: async (ctx, { replyId }) => {
    if (!await lineAiReleaseEnabled(ctx)) return null;
    const row = await ctx.db.get(replyId);
    const now = Date.now();
    if (!row || row.state !== "pending" || (row.leaseExpiresAt ?? 0) > now || !row.text) return null;
    const hadUncertainAttempt = (row.hadUncertainAttempt ?? row.attempt > 0) || !!row.leaseId;
    const target = now < row.expiresAt && row.attempt < replyAttempts ? await currentReplyDestination(ctx, row) : null;
    if (!target) {
      await ctx.db.patch(replyId, {
        state: hadUncertainAttempt ? "unknown" : "suppressed", text: undefined, eraseTextAt: undefined,
        leaseId: undefined, leaseExpiresAt: undefined, updatedAt: now,
      });
      return null;
    }
    const leaseId = crypto.randomUUID();
    await ctx.db.patch(replyId, { leaseId, leaseExpiresAt: now + leaseMs, attempt: row.attempt + 1, updatedAt: now, hadUncertainAttempt });
    await ctx.scheduler.runAfter(leaseMs, internal.line_ai_delivery.send, { replyId });
    return { ...target, leaseId, text: row.text, retryKey: row.retryKey };
  },
});

export const authorize = internalJobQuery({
  name: "line_ai_delivery:authorize", args: { ...lease, tokenCipher: v.string() },
  handler: async (ctx, { replyId, leaseId, tokenCipher }) => {
    const row = await ctx.db.get(replyId);
    const now = Date.now();
    if (!row || row.state !== "pending" || row.leaseId !== leaseId
      || (row.leaseExpiresAt ?? 0) <= now || row.expiresAt <= now) return false;
    return (await currentReplyDestination(ctx, row))?.tokenCipher === tokenCipher;
  },
});

export const finish = internalJobMutation({
  name: "line_ai_delivery:finish",
  args: { ...lease, result: v.union(lineAiReplyResult, v.literal("suppressed")) },
  handler: async (ctx, { replyId, leaseId, result }) => {
    const row = await ctx.db.get(replyId);
    if (!row || row.state !== "pending" || row.leaseId !== leaseId) return;
    const now = Date.now();
    const retryable = (result === "unknown" || result === "limited") && row.attempt < replyAttempts && row.expiresAt > now;
    // A later refusal cannot resolve an earlier attempt whose acceptance was unknown.
    const hadUncertainAttempt = (row.hadUncertainAttempt ?? row.attempt > 1) || result === "unknown";
    const state = hadUncertainAttempt && result !== "accepted" ? "unknown" : result;
    await ctx.db.patch(replyId, {
      state, hadUncertainAttempt, updatedAt: now, leaseExpiresAt: undefined, leaseId: undefined,
      ...(retryable ? {} : { text: undefined, eraseTextAt: undefined }),
    });
  },
});

export const send = internalJobAction({
  name: "line_ai_delivery:send", args: reply,
  handler: async (ctx, { replyId }): Promise<void> => {
    const job = await ctx.runMutation(internal.line_ai_delivery.claim, { replyId });
    if (!job) return;
    const { leaseId, tokenCipher, retryKey, to, text } = job;
    let result: Infer<typeof lineAiReplyResult> | "suppressed" = "suppressed";
    try {
      const line = createLine(await openLineSecret(tokenCipher));
      if (await ctx.runQuery(internal.line_ai_delivery.authorize, { replyId, leaseId, tokenCipher })) {
        result = await line.push(to, text, retryKey);
      }
    } catch {
      // A credential error or an interrupted authorization cannot prove delivery.
      result = "unknown";
    }
    await ctx.runMutation(internal.line_ai_delivery.finish, { replyId, leaseId, result });
  },
});
