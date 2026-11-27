import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { mediaJobKind, mediaJobState } from "../schema";
import { mediaCleanupEnabled } from "../pilot_access";
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
  const enabled = await mediaCleanupEnabled(ctx);
  const id = await ctx.db.insert("mediaJobs", { ...input, completedKeys: [], phase: "delete_media", state: "pending",
    attempt: 0, maxAttempts: JOB_POLICY.maxAttempts, availableAt: now, createdAt: now, updatedAt: now });
  await updateJobCounters(ctx, null, (await ctx.db.get(id))!);
  if (enabled) await ctx.scheduler.runAfter(0, internal.media_job_actions.run, { jobId: id });
  return id;
}

export function currentAttempt(job: Doc<"mediaJobs">, fence: JobFence) {
  return job.state === "running" && job.attempt === fence.attempt && job.leaseId === fence.leaseId
    && (job.leaseExpiresAt ?? 0) > Date.now();
}

export function logSettlement(job: Doc<"mediaJobs">, outcome: NonNullable<Doc<"mediaJobs">["lastOutcome"]> | "completed" | "exhausted" | "lease_expired" | "cleanup_disabled") {
  console.info({ jobId: job._id, kind: job.kind, attempt: job.attempt, outcome,
    durationMs: Math.max(0, Date.now() - (job.leaseStartedAt ?? Date.now())),
    keyCount: job.keys.length });
}

export function emptyJobCounts(): Record<string, number> {
  return Object.fromEntries(mediaJobKind.members.flatMap(kind => mediaJobState.members.map(state => [`${kind.value}:${state.value}`, 0])));
}

async function updateJobCounters(ctx: MutationCtx, before: Doc<"mediaJobs"> | null, after: Doc<"mediaJobs">) {
  async function adjust(job: Doc<"mediaJobs">, delta: number) {
    const key = `${job.kind}:${job.state}`;
    const counter = await ctx.db.query("mediaJobCounters").withIndex("by_key", q => q.eq("key", key)).unique();
    const count = (counter?.count ?? 0) + delta;
    if (counter) await ctx.db.patch(counter._id, { count });
    else await ctx.db.insert("mediaJobCounters", { key, count });
  }
  if (before) await adjust(before, -1);
  await adjust(after, 1);
}

/** All execution state transitions update the projection in the same transaction. */
export async function patchMediaJob(ctx: MutationCtx, job: Doc<"mediaJobs">, patch: Partial<Doc<"mediaJobs">>) {
  await ctx.db.patch(job._id, patch);
  if (patch.state && patch.state !== job.state) await updateJobCounters(ctx, job, { ...job, ...patch });
}
