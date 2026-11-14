import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { JobFence } from "../../shared/ticket-contracts";

// The lease leaves forty seconds beyond the provider budget for settlement.
export const JOB_POLICY = { maxAttempts: 8, backoffMs: 30_000, maxBackoffMs: 15 * 60_000, actionBudgetMs: 20_000, leaseMs: 60_000 };
export const SWEEP_LIMIT = 25;
export const AUDIT_BATCH = 100;
export const ARCHIVE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export async function createMediaJob(ctx: MutationCtx, input: Pick<Doc<"mediaJobs">,
  "kind" | "resourceScope" | "keys"> & Partial<Pick<Doc<"mediaJobs">, "intentId" | "ticketId">>): Promise<Id<"mediaJobs">> {
  // Reservations keep the resource exclusive even after terminal failure.
  const existing = await ctx.db.query("mediaJobs").withIndex("by_scope", q => q.eq("resourceScope", input.resourceScope)).first();
  if (existing) return existing._id;
  const now = Date.now();
  const enabled = process.env.MEDIA_CLEANUP_ENABLED === "true";
  const id = await ctx.db.insert("mediaJobs", { ...input, completedKeys: [], phase: "delete_media", state: "pending",
    attempt: 0, maxAttempts: JOB_POLICY.maxAttempts, availableAt: now, createdAt: now, updatedAt: now });
  if (enabled) await ctx.scheduler.runAfter(0, internal.media_job_actions.run, { jobId: id });
  return id;
}

export function currentAttempt(job: Doc<"mediaJobs">, fence: JobFence) {
  return job.state === "running" && job.attempt === fence.attempt && job.leaseId === fence.leaseId
    && (job.leaseExpiresAt ?? 0) > Date.now();
}

export function logSettlement(job: Doc<"mediaJobs">, outcome: string) {
  console.info({ jobId: job._id, kind: job.kind, attempt: job.attempt, outcome,
    durationMs: Math.max(0, Date.now() - ((job.leaseExpiresAt ?? Date.now()) - JOB_POLICY.leaseMs)),
    keyCount: job.keys.length });
}
