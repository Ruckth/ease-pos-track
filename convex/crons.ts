import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("recover media jobs", { minutes: 1 }, internal.retention.recover);
// Provider execution, recovery and purge claims check MEDIA_CLEANUP_ENABLED.
// Expiry only records intent and reservations while disabled.
crons.interval("expire abandoned uploads", { minutes: 5 }, internal.retention.expireIntents);
crons.interval("claim archived Tickets", { hours: 1 }, internal.retention.claimPurges);

crons.interval("expire inbox updates", { minutes: 5 }, internal.inbox.expire);

crons.interval("expire approved identity records", { hours: 1 }, internal.identity_retention.expire);

export default crons;
