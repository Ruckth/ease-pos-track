import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { internalJobMutation, internalJobQuery, actorQuery, staffQuery, ownerMutation } from "./functions";
import { JOB_POLICY, SWEEP_LIMIT, AUDIT_BATCH, ARCHIVE_RETENTION_MS, createMediaJob, currentAttempt, logSettlement, patchMediaJob, emptyJobCounts } from "./domain/media_jobs";
import { MAX_MEDIA_FILES } from "../shared/media-policy";
import { reserveIntentAssets, requireOwnedUploadIntent } from "./domain/media";
import { tombstoneTicketRequests } from "./domain/requests";
import { retireTicketPages } from "./domain/pages";
import { hasLegacyAccess, mediaCleanupEnabled, requireLegacyAccess } from "./pilot_access";

const fenceArgs = { jobId: v.id("mediaJobs"), attempt: v.number(), leaseId: v.string() };

async function failJob(ctx: MutationCtx, job: Doc<"mediaJobs">, lastOutcome: "ownership_conflict" | "exhausted") {
  await patchMediaJob(ctx, job, { state: "failed", leaseId: undefined, leaseExpiresAt: undefined,
    ...(lastOutcome === "ownership_conflict" ? { lastOutcome } : {}), updatedAt: Date.now() });
  logSettlement(job, lastOutcome);
  return null;
}

async function purgeAssets(ctx: MutationCtx, ticket: Doc<"tickets">) {
  const assets = await ctx.db.query("mediaAssets").withIndex("by_ticket", q => q.eq("ticketId", ticket._id)).take(MAX_MEDIA_FILES + 1);
  return assets.length === ticket.media.length && ticket.media.every(file => assets.some(asset =>
    asset.key === file.key && asset.lifecycle === "attached" && !asset.jobId)) ? assets : null;
}

export const progress = actorQuery({
  name: "retention:progress",
  args: { intentId: v.id("uploadIntents"), secret: v.string(), jobId: v.id("mediaJobs") },
  handler: async (ctx, args) => {
    await requireLegacyAccess(ctx);
    requireOwnedUploadIntent(await ctx.db.get(args.intentId), ctx.actor, args.secret);
    const job = await ctx.db.get(args.jobId);
    if (!job || job.intentId !== args.intentId) throw new Error("UPLOAD_INTENT_NOT_FOUND");
    return { jobId: job._id, state: job.state, attempt: job.attempt, maxAttempts: job.maxAttempts, phase: job.phase,
      completedCount: job.completedKeys.length, totalCount: job.keys.length, lastOutcome: job.lastOutcome };
  },
});

export const claim = internalJobMutation({
  name: "retention:claim", args: { jobId: v.id("mediaJobs") },
  handler: async (ctx, args): Promise<(Doc<"mediaJobs"> & { verifyKeys: string[] }) | null> => {
    if (!await hasLegacyAccess(ctx)) return null;
    const job = await ctx.db.get(args.jobId);
    if (!job) return null;
    const now = Date.now();
    if (job.state === "pending" ? job.availableAt > now : job.state !== "running" || (job.leaseExpiresAt ?? 0) > now) return null;
    if (process.env.MEDIA_CLEANUP_ENABLED !== "true") {
      if (job.state === "running") logSettlement(job, "cleanup_disabled");
      await patchMediaJob(ctx, job, { state: "pending", availableAt: now + JOB_POLICY.backoffMs,
        leaseId: undefined, leaseExpiresAt: undefined, updatedAt: now });
      return null;
    }
    const needsProvider = job.phase === "delete_media" && job.completedKeys.length < job.keys.length;
    if (needsProvider && job.attempt >= job.maxAttempts) return await failJob(ctx, job, "exhausted");
    if (job.state === "running") logSettlement(job, "lease_expired");
    // Only provider work spends attempts. A new lease ID still fences database recovery.
    const attempt = job.attempt + (needsProvider ? 1 : 0);
    const leaseId = crypto.randomUUID();
    const leaseExpiresAt = now + JOB_POLICY.leaseMs;
    await patchMediaJob(ctx, job, { state: "running", attempt, leaseId, leaseStartedAt: now, leaseExpiresAt, updatedAt: now });
    const verifyKeys: string[] = [];
    for (const key of job.keys) {
      const asset = await ctx.db.query("mediaAssets").withIndex("by_key", q => q.eq("key", key)).unique();
      if (!asset || asset.jobId !== job._id || (asset.lifecycle !== "deleting" && asset.lifecycle !== "deleted")) {
        return await failJob(ctx, (await ctx.db.get(job._id))!, "ownership_conflict");
      }
      if (asset.source === "staff" && !asset.ticketId) verifyKeys.push(key);
    }
    return { ...job, state: "running", attempt, leaseId, leaseExpiresAt, verifyKeys };
  },
});

export const mayStartProviderCall = internalJobQuery({
  name: "retention:mayStartProviderCall", args: fenceArgs,
  handler: async (ctx, args) => {
    if (!await mediaCleanupEnabled(ctx)) return false;
    const job = await ctx.db.get(args.jobId);
    return Boolean(job && currentAttempt(job, args));
  },
});

export const checkpoint = internalJobMutation({
  name: "retention:checkpoint", args: { ...fenceArgs, key: v.string(), outcome: v.union(
    v.literal("deleted"), v.literal("absent_verified"), v.literal("failed_retryable"), v.literal("failed_permanent"),
    v.literal("unknown"), v.literal("not_configured"), v.literal("ownership_unverified")) },
  handler: async (ctx, args) => {
    if (!await hasLegacyAccess(ctx)) return false;
    const job = await ctx.db.get(args.jobId);
    if (!job || !currentAttempt(job, args) || job.phase !== "delete_media" || !job.keys.includes(args.key)) return false;
    if (job.completedKeys.includes(args.key)) return true;
    const now = Date.now();
    if (args.outcome === "deleted" || args.outcome === "absent_verified") {
      const asset = await ctx.db.query("mediaAssets").withIndex("by_key", q => q.eq("key", args.key)).unique();
      if (!asset || asset.jobId !== job._id || asset.lifecycle !== "deleting") {
        await failJob(ctx, job, "ownership_conflict");
        return false;
      }
      await ctx.db.patch(asset._id, { lifecycle: "deleted", updatedAt: now });
      await patchMediaJob(ctx, job, { completedKeys: [...job.completedKeys, args.key], lastOutcome: args.outcome, updatedAt: now });
      return true;
    }
    const attempt = args.outcome === "not_configured" ? job.attempt - 1 : job.attempt;
    const permanent = args.outcome === "failed_permanent" || args.outcome === "ownership_unverified";
    const availableAt = now + Math.min(JOB_POLICY.maxBackoffMs, JOB_POLICY.backoffMs * 2 ** Math.max(0, attempt - 1));
    const exhausted = attempt >= job.maxAttempts;
    const state = permanent || exhausted ? "failed" : "pending";
    await patchMediaJob(ctx, job, { state, attempt, availableAt, lastOutcome: args.outcome, leaseId: undefined, leaseExpiresAt: undefined, updatedAt: now });
    logSettlement(job, exhausted ? "exhausted" : args.outcome);
    if (state === "pending" && process.env.MEDIA_CLEANUP_ENABLED === "true") await ctx.scheduler.runAfter(availableAt - now, internal.media_job_actions.run, { jobId: job._id });
    return false;
  },
});

export const advance = internalJobMutation({
  name: "retention:advance", args: fenceArgs,
  handler: async (ctx, args) => {
    if (!await hasLegacyAccess(ctx)) return false;
    const job = await ctx.db.get(args.jobId);
    if (!job || !currentAttempt(job, args)) return false;
    const now = Date.now();
    let phase = job.phase;
    if (phase === "delete_media") {
      if (job.completedKeys.length !== job.keys.length) return false;
      phase = job.kind === "ticket_purge" ? "delete_ticket" : "complete";
    } else if (phase === "delete_ticket") {
      if (!job.ticketId) { await failJob(ctx, job, "ownership_conflict"); return false; }
      const ticket = await ctx.db.get(job.ticketId);
      if (!ticket || ticket.lifecycle !== "purging") { await failJob(ctx, job, "ownership_conflict"); return false; }
      for (const key of job.keys) {
        const asset = await ctx.db.query("mediaAssets").withIndex("by_key", q => q.eq("key", key)).unique();
        if (!asset || asset.jobId !== job._id || asset.lifecycle !== "deleted") { await failJob(ctx, job, "ownership_conflict"); return false; }
      }
      await tombstoneTicketRequests(ctx, ticket._id);
      const lineLink = await ctx.db.query("lineAiTicketLinks").withIndex("by_ticket", q => q.eq("ticketId", ticket._id)).unique();
      if (lineLink) await ctx.db.delete(lineLink._id);
      await ctx.db.delete(ticket._id);
      phase = "delete_events";
    } else if (phase === "delete_events") {
      const { ticketId } = job;
      if (job.kind !== "ticket_purge" || !ticketId) { await failJob(ctx, job, "ownership_conflict"); return false; }
      const events = await ctx.db.query("ticketEvents").withIndex("by_ticket", q => q.eq("ticketId", ticketId)).take(AUDIT_BATCH);
      const annotations = await ctx.db.query("annotationEvents").withIndex("by_ticket", q => q.eq("ticketId", ticketId)).take(AUDIT_BATCH);
      const messages = await ctx.db.query("ticketMessages").withIndex("by_ticket", q => q.eq("ticketId", ticketId)).take(AUDIT_BATCH);
      const assignments = await ctx.db.query("ticketAssignmentEvents").withIndex("by_ticket", q => q.eq("ticketId", ticketId)).take(AUDIT_BATCH);
      const suggestions = await ctx.db.query("ticketRoutingSuggestions").withIndex("by_ticket", q => q.eq("ticketId", ticketId)).take(AUDIT_BATCH);
      const customerInbox = await ctx.db.query("customerInbox").withIndex("by_ticket", q => q.eq("ticketId", ticketId)).take(AUDIT_BATCH);
      const staffInbox = await ctx.db.query("staffInbox").withIndex("by_ticket", q => q.eq("ticketId", ticketId)).take(AUDIT_BATCH);
      const lineReplies = await ctx.db.query("lineAiReplies").withIndex("by_ticket", q => q.eq("ticketId", ticketId)).take(AUDIT_BATCH);
      const suggestionRequests = await ctx.db.query("ticketRoutingSuggestionRequests").withIndex("by_ticket", q => q.eq("ticketId", ticketId)).take(AUDIT_BATCH);
      const batches = [events, annotations, messages, assignments, suggestions, customerInbox, staffInbox, lineReplies];
      for (const row of batches.flat()) await ctx.db.delete(row._id);
      // Keep caller-scoped request IDs reserved while clearing every result and Ticket reference.
      // Replacing the row also removes it from the next Ticket-scoped batch.
      for (const { _id, source, caller, requestId, inputDigest } of suggestionRequests) {
        await ctx.db.replace(_id, { source, caller, requestId, inputDigest, outcome: "unavailable" });
      }
      // Hosted pages stop serving with the Ticket row; their blobs join the gated reclaim sweep.
      const pagesRetired = await retireTicketPages(ctx, ticketId);
      if (pagesRetired && [...batches, suggestionRequests].every(batch => batch.length < AUDIT_BATCH)) phase = "complete";
    }
    if (phase === "complete") {
      await patchMediaJob(ctx, job, { state: "completed", phase, leaseId: undefined, leaseExpiresAt: undefined, updatedAt: now });
      logSettlement(job, "completed");
      if (job.intentId) {
        const intent = await ctx.db.get(job.intentId);
        if (intent?.status === "expiring") {
          const pending = await ctx.db.query("mediaAssets").withIndex("by_intent", q => q.eq("intentId", intent._id).eq("lifecycle", "pending")).first();
          const deleting = await ctx.db.query("mediaAssets").withIndex("by_intent", q => q.eq("intentId", intent._id).eq("lifecycle", "deleting")).first();
          if (!pending && !deleting) await ctx.db.patch(intent._id, { status: "cleaned", updatedAt: now });
        }
      }
    } else {
      await patchMediaJob(ctx, job, { phase, leaseExpiresAt: now + JOB_POLICY.leaseMs, updatedAt: now });
      await ctx.scheduler.runAfter(0, internal.retention.advance, args);
    }
    return true;
  },
});

/** Separate bounded indexed scans keep unrelated resources moving. */
export const recover = internalJobMutation({
  name: "retention:recover", args: {},
  handler: async ctx => {
    if (!await mediaCleanupEnabled(ctx)) return 0;
    const now = Date.now();
    const pending = await ctx.db.query("mediaJobs").withIndex("by_available", q => q.eq("state", "pending").lte("availableAt", now)).take(SWEEP_LIMIT);
    const expired = await ctx.db.query("mediaJobs").withIndex("by_lease", q => q.eq("state", "running").lte("leaseExpiresAt", now)).take(SWEEP_LIMIT);
    for (const job of [...pending, ...expired]) await ctx.scheduler.runAfter(0, internal.media_job_actions.run, { jobId: job._id });
    return pending.length + expired.length;
  },
});

export const expireIntents = internalJobMutation({
  name: "retention:expireIntents", args: {},
  handler: async ctx => {
    if (!await hasLegacyAccess(ctx)) return 0;
    const intents = await ctx.db.query("uploadIntents").withIndex("by_expires_at", q => q.eq("status", "pending").lte("expiresAt", Date.now())).take(SWEEP_LIMIT);
    for (const intent of intents) {
      // Accepted pending uploads are bounded by the 10 image + 3 video budget.
      const assets = await ctx.db.query("mediaAssets").withIndex("by_intent", q => q.eq("intentId", intent._id).eq("lifecycle", "pending")).take(MAX_MEDIA_FILES);
      const jobs = await reserveIntentAssets(ctx, intent, assets, "intent_expiry");
      const deleting = await ctx.db.query("mediaAssets").withIndex("by_intent", q => q.eq("intentId", intent._id).eq("lifecycle", "deleting")).first();
      await ctx.db.patch(intent._id, { status: jobs.length || deleting ? "expiring" : "cleaned", updatedAt: Date.now() });
    }
    return intents.length;
  },
});

export const claimPurges = internalJobMutation({
  name: "retention:claimPurges", args: {},
  handler: async ctx => {
    if (!await mediaCleanupEnabled(ctx)) return 0;
    const now = Date.now();
    const tickets = await ctx.db.query("tickets").withIndex("by_lifecycle_archive", q => q.eq("lifecycle", "archived").eq("purgeBlocked", undefined).lte("archivedAt", now - ARCHIVE_RETENTION_MS)).take(SWEEP_LIMIT);
    for (const ticket of tickets) {
      const assets = await purgeAssets(ctx, ticket);
      const jobId = await createMediaJob(ctx, { kind: "ticket_purge", resourceScope: `ticket:${ticket._id}`, ticketId: ticket._id, keys: ticket.media.map(file => file.key) });
      if (!assets) {
        await failJob(ctx, (await ctx.db.get(jobId))!, "ownership_conflict");
        await ctx.db.patch(ticket._id, { purgeBlocked: true });
        continue;
      }
      for (const asset of assets) await ctx.db.patch(asset._id, { lifecycle: "deleting", jobId, updatedAt: now });
      // Archive already removed this Ticket from totals; finalization never decrements again.
      await ctx.db.patch(ticket._id, { lifecycle: "purging", version: ticket.version + 1, updatedAt: now });
    }
    return tickets.length;
  },
});

/** Ops repairs ownership/configuration first; requeue retains keys and completed progress. */
export const requeue = internalJobMutation({
  name: "retention:requeue", args: { jobId: v.id("mediaJobs") },
  handler: (ctx, args) => requeueJob(ctx, args.jobId),
});

async function requeueJob(ctx: MutationCtx, jobId: Doc<"mediaJobs">["_id"]) {
  await requireLegacyAccess(ctx);
  const job = await ctx.db.get(jobId);
  if (!job || job.state !== "failed") return false;
  const now = Date.now();
  if (job.intentId && job.phase === "delete_media") {
    for (const key of job.keys) {
      const assets = await ctx.db.query("mediaAssets").withIndex("by_key", q => q.eq("key", key)).take(2);
      const asset = assets[0];
      if (assets.length !== 1 || asset.intentId !== job.intentId || asset.ticketId) return false;
      if (asset.jobId !== job._id || (asset.lifecycle !== "deleting" && asset.lifecycle !== "deleted")) return false;
    }
  }
  if (job.kind === "ticket_purge" && job.ticketId) {
    const ticket = await ctx.db.get(job.ticketId);
    if (ticket?.lifecycle === "archived") {
      if (process.env.MEDIA_CLEANUP_ENABLED !== "true" || ticket.archivedAt === undefined
        || ticket.archivedAt > now - ARCHIVE_RETENTION_MS) return false;
      const assets = await purgeAssets(ctx, ticket);
      if (!assets || ticket.media.length !== job.keys.length || ticket.media.some(file => !job.keys.includes(file.key))) return false;
      for (const asset of assets) await ctx.db.patch(asset._id, { lifecycle: "deleting", jobId: job._id, updatedAt: now });
      await ctx.db.patch(ticket._id, { lifecycle: "purging", purgeBlocked: undefined, version: ticket.version + 1, updatedAt: now });
    } else if (job.phase !== "delete_events" && ticket?.lifecycle !== "purging") return false;
  }
  await patchMediaJob(ctx, job, { state: "pending", attempt: 0, availableAt: now, lastOutcome: undefined,
    leaseId: undefined, leaseExpiresAt: undefined, updatedAt: now });
  if (process.env.MEDIA_CLEANUP_ENABLED === "true") await ctx.scheduler.runAfter(0, internal.media_job_actions.run, { jobId: job._id });
  return true;
}

export const requeueFailed = ownerMutation({
  name: "retention:requeueFailed", args: { jobId: v.id("mediaJobs") },
  handler: (ctx, args) => requeueJob(ctx, args.jobId),
});

export const health = staffQuery({
  name: "retention:health", args: {},
  handler: async ctx => {
    await requireLegacyAccess(ctx);
    const counts = emptyJobCounts();
    for (const key of Object.keys(counts)) {
      const counter = await ctx.db.query("mediaJobCounters").withIndex("by_key", q => q.eq("key", key)).unique();
      counts[key] = counter?.count ?? 0;
    }
    const oldest = await ctx.db.query("mediaJobs").withIndex("by_state_created", q => q.eq("state", "pending")).first();
    return { counts, oldestPendingAt: oldest?.createdAt ?? null,
      configuration: { uploadThingToken: Boolean(process.env.UPLOADTHING_TOKEN),
        callbackSecret: Boolean(process.env.UPLOAD_CALLBACK_SECRET), mediaCleanupEnabled: process.env.MEDIA_CLEANUP_ENABLED === "true" } };
  },
});

export const diagnostics = staffQuery({
  name: "retention:diagnostics",
  args: { view: v.union(v.literal("failed"), v.literal("pending"), v.literal("expired")), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const now = Date.now();
    await requireLegacyAccess(ctx);
    const pagination = { ...args.paginationOpts, numItems: Math.max(1, Math.min(25, args.paginationOpts.numItems)) };
    const result = await (args.view === "expired"
      ? ctx.db.query("mediaJobs").withIndex("by_lease", q => q.eq("state", "running").lte("leaseExpiresAt", now))
      : ctx.db.query("mediaJobs").withIndex("by_state_created", q => q.eq("state", args.view === "failed" ? "failed" : "pending"))).paginate(pagination);
    return { ...result, observedAt: now, page: await Promise.all(result.page.map(async job => ({
      jobId: job._id, kind: job.kind, state: job.state, phase: job.phase, attempt: job.attempt, maxAttempts: job.maxAttempts,
      exhausted: job.state === "failed" && job.attempt >= job.maxAttempts,
      lastOutcome: job.lastOutcome ?? null, createdAt: job.createdAt, availableAt: job.availableAt,
      leaseExpiresAt: job.leaseExpiresAt ?? null,
      purgeBlocked: job.ticketId ? (await ctx.db.get(job.ticketId))?.purgeBlocked === true : false,
    }))) };
  },
});
