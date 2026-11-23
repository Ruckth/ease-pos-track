import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("clean expired sessions", { hours: 1 }, internal.auth.cleanupExpiredSessions);
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

export default crons;
