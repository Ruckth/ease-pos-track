import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("recover media jobs", { minutes: 1 }, internal.retention.recover);
// Provider execution, recovery and purge claims check MEDIA_CLEANUP_ENABLED.
// Expiry only records intent and reservations while disabled.
crons.interval("expire abandoned uploads", { minutes: 5 }, internal.retention.expireIntents);
crons.interval("claim archived Tickets", { hours: 1 }, internal.retention.claimPurges);

// Expiry only records abandoned page uploads; reclaim deletes recorded page
// blobs and is gated by MEDIA_CLEANUP_ENABLED.
crons.interval("expire page uploads", { minutes: 5 }, internal.pages.expireStaging);
// Records interrupted page writes by their private marker; never deletes.
crons.interval("reconcile page writes", { minutes: 5 }, internal.pages.reconcileWrites);
crons.interval("reclaim page storage", { minutes: 5 }, internal.pages.reclaim);
crons.interval("expire approved pilot records", { hours: 1 }, internal.pilot_retention.expire);
crons.interval("expire LINE assistant records", { minutes: 5 }, internal.line_ai_retention.expire);
crons.interval("expire LINE intake", { minutes: 5 }, internal.line_webhook.cleanupExpiredAiIntake, {});
crons.interval("recover LINE analysis", { minutes: 1 }, internal.line_ai_processing.recover);
crons.interval("recover LINE replies", { minutes: 1 }, internal.line_ai_delivery.recover);

export default crons;
