import { internalJobMutation } from "./functions";
import { approvedRetention } from "./pilot_access";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const BATCH = 64;

/** Applies only the installed release's approved periods; see approvedRetention for the stop conditions. */
export const expire = internalJobMutation({
  name: "identity_retention:expire",
  args: {},
  handler: async ctx => {
    const retention = await approvedRetention(ctx);
    if (!retention) return 0;
    const now = Date.now();
    const records = await Promise.all([
      ctx.db.query("identityChallenges").withIndex("by_created", q => q.lte("createdAt", now - retention.challengeHours * HOUR)).take(BATCH),
      ctx.db.query("staffInvitations").withIndex("by_expiry", q => q.lte("expiresAt", now - retention.invitationDays * DAY)).take(BATCH),
      ctx.db.query("projectInvitations").withIndex("by_expiry", q => q.lte("expiresAt", now - retention.invitationDays * DAY)).take(BATCH),
      ctx.db.query("identityAttempts").withIndex("by_updated", q => q.lte("updatedAt", now - retention.attemptDays * DAY)).take(BATCH),
      ctx.db.query("identityAudit").withIndex("by_created", q => q.lte("createdAt", now - retention.auditDays * DAY)).take(BATCH),
    ]);
    const expired = records.flat();
    await Promise.all(expired.map(row => ctx.db.delete(row._id)));
    return expired.length;
  },
});
