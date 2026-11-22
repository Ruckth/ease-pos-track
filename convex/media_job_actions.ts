"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalJobAction } from "./functions";
import { createStorage } from "./adapters/storage";
import { JOB_POLICY } from "./domain/media_jobs";
import { StorageConfigurationError, type Storage } from "../shared/storage";
import type { StorageDeletionOutcome } from "../shared/ticket-contracts";

export const run = internalJobAction({
  name: "media_job_actions:run", args: { jobId: v.id("mediaJobs") },
  handler: async (ctx, args): Promise<void> => {
    const job = await ctx.runMutation(internal.retention.claim, args);
    if (!job) return;
    const fence = { jobId: job._id, attempt: job.attempt, leaseId: job.leaseId! };
    const keys = job.keys.filter(key => !job.completedKeys.includes(key));
    if (job.phase === "delete_media" && keys.length) {
      let storage: Storage;
      try { storage = createStorage(); }
      catch (error) {
        await ctx.runMutation(internal.retention.checkpoint, { ...fence, key: keys[0],
          outcome: error instanceof StorageConfigurationError ? "not_configured" : "unknown" });
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      try {
        // One time budget covers verification and all provider calls. Timing out
        // cannot cancel network I/O; only fenced checkpoints may advance ownership.
        const deadline = new Promise<"timeout">(resolve => {
          timer = setTimeout(() => { timedOut = true; resolve("timeout"); }, JOB_POLICY.actionBudgetMs);
        });
        for (const key of keys) {
          if (timedOut) return;
          if (!await ctx.runQuery(internal.retention.mayStartProviderCall, fence) || timedOut) return;
          const request = async (): Promise<StorageDeletionOutcome | { outcome: "ownership_unverified" }> => {
            if (job.verifyKeys.includes(key)) {
              if (!await storage.verifyAppKey(key)) return { outcome: "ownership_unverified" };
              if (!await ctx.runQuery(internal.retention.mayStartProviderCall, fence)) return { outcome: "unknown" };
            }
            if (timedOut) return { outcome: "unknown" };
            return await storage.deleteFiles([key]);
          };
          const result = await Promise.race([request().catch(() => ({ outcome: "unknown" as const })), deadline]);
          const outcome = result === "timeout" ? "unknown" : result.outcome;
          if (!await ctx.runMutation(internal.retention.checkpoint, { ...fence, key, outcome })) return;
        }
      } finally { if (timer !== undefined) clearTimeout(timer); }
    }
    await ctx.runMutation(internal.retention.advance, fence);
  },
});
