import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("clean abandoned uploads", { minutes: 30 }, internal.upload_cleanup.cleanupExpiredUploads);
crons.interval("clean expired sessions", { hours: 1 }, internal.auth.cleanupExpiredSessions);

export default crons;
