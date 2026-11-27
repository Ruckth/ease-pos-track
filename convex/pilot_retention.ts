import { components, internal } from "./_generated/api";
import { internalJobMutation } from "./functions";
import { approvedRetention } from "./pilot_access";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const BATCH = 64;

/** Applies only the installed release's approved periods; see approvedRetention for the stop conditions. */
export const expire = internalJobMutation({
  name: "pilot_retention:expire",
  args: {},
  handler: async (ctx): Promise<number> => {
    const retention = await approvedRetention(ctx);
    if (!retention) return 0;
    const now = Date.now();
    const inboxCutoff = now - retention.inboxDays * DAY;
    const [challenges, staffInvites, projectInvites, attempts, audits, customerInbox, staffInbox] = await Promise.all([
      ctx.db.query("identityChallenges").withIndex("by_created", q => q.lte("createdAt", now - retention.challengeHours * HOUR)).take(BATCH),
      ctx.db.query("staffInvitations").withIndex("by_expiry", q => q.lte("expiresAt", now - retention.invitationDays * DAY)).take(BATCH),
      ctx.db.query("projectInvitations").withIndex("by_expiry", q => q.lte("expiresAt", now - retention.invitationDays * DAY)).take(BATCH),
      ctx.db.query("identityAttempts").withIndex("by_updated", q => q.lte("updatedAt", now - retention.attemptDays * DAY)).take(BATCH),
      ctx.db.query("identityAudit").withIndex("by_created", q => q.lte("createdAt", now - retention.auditDays * DAY)).take(BATCH),
      ctx.db.query("customerInbox").withIndex("by_creation_time", q => q.lt("_creationTime", inboxCutoff)).take(BATCH),
      ctx.db.query("staffInbox").withIndex("by_creation_time", q => q.lt("_creationTime", inboxCutoff)).take(BATCH),
    ]);
    for (const row of attempts) {
      if (row.key.startsWith("customer:")) {
        await ctx.runMutation(components.authPassword.public.forgetVerification, { key: row.key });
      }
    }
    const batches = [challenges, staffInvites, projectInvites, attempts, audits, customerInbox, staffInbox];
    const expired = batches.flat();
    await Promise.all(expired.map(row => ctx.db.delete(row._id)));
    if (batches.some(batch => batch.length === BATCH)) {
      await ctx.scheduler.runAfter(0, internal.pilot_retention.expire, {});
    }
    return expired.length;
  },
});
