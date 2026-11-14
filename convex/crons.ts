import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("clean expired sessions", { hours: 1 }, internal.auth.cleanupExpiredSessions);

export default crons;
