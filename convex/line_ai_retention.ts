import { internalJobMutation } from "./functions";
import { retentionHeld } from "../shared/pilot-settings";

const batch = 100;
const dayMs = 24 * 60 * 60_000;

/** Scrub volatile input and reply bodies independently of external I/O. */
export const expire = internalJobMutation({
  name: "line_ai_retention:expire", args: {},
  handler: async (ctx) => {
    if (retentionHeld(process.env)) return;
    const now = Date.now();
    const [drafts, expiredBodies, replies, usage] = await Promise.all([
      ctx.db.query("lineAiDrafts").withIndex("by_expiry", q => q.lte("expiresAt", now)).take(batch),
      ctx.db.query("lineAiReplies").withIndex("by_erase_text",
        q => q.gt("eraseTextAt", 0).lte("eraseTextAt", now)).take(batch),
      ctx.db.query("lineAiReplies").withIndex("by_deletion", q => q.lte("deleteAt", now)).take(batch),
      ctx.db.query("lineAiUsage").withIndex("by_day", q => q.lt("day", Math.floor(now / dayMs) - 7)).take(batch),
    ]);
    const replyDeletions = new Set(replies.map(row => row._id));
    for (const row of expiredBodies) {
      if (replyDeletions.has(row._id)) continue;
      if (row.leaseExpiresAt && row.leaseExpiresAt > now) {
        await ctx.db.patch(row._id, { eraseTextAt: row.leaseExpiresAt });
        continue;
      }
      await ctx.db.patch(row._id, {
        text: undefined, eraseTextAt: undefined, leaseId: undefined, leaseExpiresAt: undefined,
        state: row.state === "pending" ? (row.attempt ? "unknown" : "suppressed") : row.state,
      });
    }
    for (const row of [...drafts, ...replies, ...usage]) await ctx.db.delete(row._id);
  },
});
