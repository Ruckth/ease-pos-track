import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import schema from "../../convex/schema";
import { modules } from "./modules";
import { ARCHIVE_RETENTION_MS, AUDIT_BATCH, JOB_POLICY, SWEEP_LIMIT } from "../../convex/domain/media_jobs";
import type { Storage } from "../../shared/storage";
import { StorageConfigurationError } from "../../shared/storage";
import type { StorageDeletionOutcome } from "../../shared/ticket-contracts";
import { cancelUploadHandler } from "../../server/handlers/cancel-upload";
import { createUploadApp } from "../../server/app";
import { POST } from "../../api/uploads/cancel";
import * as retention from "../../convex/retention";
import type { FunctionArgs } from "convex/server";
import type { MutationCtx } from "../../convex/_generated/server";
import { MAX_MEDIA_FILES } from "../../shared/media-policy";

const provider = vi.hoisted(() => ({ factory: vi.fn() }));
vi.mock("../../convex/adapters/storage", () => ({ createStorage: provider.factory }));
const httpRuntime = vi.hoisted(() => ({ cancelUpload: vi.fn() }));
vi.mock("../../server/runtime", () => ({ createServerRuntime: () => ({
  cancelUpload: (request: Request) => httpRuntime.cancelUpload(request),
}) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-14T00:00:00Z"));
  vi.stubEnv("LOCAL_FIXTURES_ENABLED", "true");
  vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3212");
  vi.stubEnv("UPLOAD_CALLBACK_SECRET", "fake-callback");
  vi.stubEnv("MEDIA_CLEANUP_ENABLED", "true");
  provider.factory.mockReset();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function fixture(testModules = modules) {
  const t = convexTest(schema, testModules);
  const seed = await t.mutation(internal.seed.install, {
    passwordAlgorithm: "fixture", passwordSalt: "fixture", passwordHash: "fixture", passwordIterations: 1,
  });
  const [staff, alice, bob] = seed.sessions;
  const storage: Storage = { deleteFiles: vi.fn<Storage["deleteFiles"]>(async () => ({ outcome: "deleted" })), verifyAppKey: vi.fn(async () => true) };
  provider.factory.mockReturnValue(storage);
  let sequence = 0;
  async function upload(count = 1, source: "callback" | "staff" = "callback") {
    const serial = ++sequence;
    const files = Array.from({ length: count }, (_, index) => ({ key: `fake-${serial}-${index}`, url: `https://fake.invalid/${serial}/${index}`,
      name: `${index}.png`, size: 1, type: "image/png" }));
    const handle = await t.mutation(api.uploads.createUploadIntent, {
      token: source === "staff" ? staff : alice, idempotencyKey: `media-job-request-${serial}`, files: files.map(({ name, size, type }) => ({ name, size, type })),
    });
    for (const file of files) await t.mutation(api.uploads.recordUploadedFile, {
      intentId: handle.intentId, secret: handle.secret, file,
      ...(source === "callback" ? { callbackToken: "fake-callback" } : { token: staff }),
    });
    return { ...handle, files, token: source === "staff" ? staff : alice };
  }
  const cancel = (input: Awaited<ReturnType<typeof upload>>) => t.mutation(api.uploads.cancelUploadIntent, {
    token: input.token, intentId: input.intentId, secret: input.secret,
  });
  const job = (id: Id<"mediaJobs">) => t.run(ctx => ctx.db.get(id));
  const assets = () => t.run(ctx => ctx.db.query("mediaAssets").collect());
  const drain = () => t.finishAllScheduledFunctions(() => vi.runAllTimers(), 100);
  async function archived(count = 2) {
    const handle = await upload(count);
    const requestId = `purge-${sequence}-request`;
    const ticketId = await t.mutation(api.tickets.createTicket, { token: alice, projectId: seed.projects[0].id, title: "Purge fixture", description: "Fixture",
      media: handle.files, requestId, uploadIntentId: handle.intentId, uploadIntentSecret: handle.secret });
    await t.mutation(api.tickets.archiveTicket, { token: alice, id: ticketId, expectedVersion: 0 });
    await t.run(ctx => ctx.db.patch(ticketId, { archivedAt: Date.now() - ARCHIVE_RETENTION_MS }));
    return { ...handle, ticketId, requestId };
  }
  const fence = (row: Doc<"mediaJobs">) => ({ jobId: row._id, attempt: row.attempt, leaseId: row.leaseId! });
  return { t, seed, staff, alice, bob, storage, upload, cancel, job, assets, drain, archived, fence };
}

test("lease expiry recovers a held provider action, rejects stale settlement and isolates an unrelated job", async () => {
  const f = await fixture();
  const first = await f.upload();
  const other = await f.upload();
  const response = deferred<StorageDeletionOutcome>();
  const started = deferred<void>();
  let attempts = 0;
  f.storage.deleteFiles = vi.fn<Storage["deleteFiles"]>(async keys => {
    if (keys[0] === first.files[0].key && ++attempts === 1) { started.resolve(); return response.promise; }
    return { outcome: "deleted" };
  });
  const [id] = (await f.cancel(first)).jobIds;
  vi.runAllTimers();
  await started.promise;
  const [otherId] = (await f.cancel(other)).jobIds;
  await f.t.action(internal.media_job_actions.run, { jobId: otherId });
  const old = (await f.job(id))!;
  expect(old).toMatchObject({ state: "running", attempt: 1, completedKeys: [] });
  // Advance the clock without firing the action's timeout: model a frozen/lost runtime.
  vi.setSystemTime(Date.now() + JOB_POLICY.leaseMs + 1);
  expect(await f.t.mutation(internal.retention.recover, {})).toBeGreaterThanOrEqual(1);
  await f.t.action(internal.media_job_actions.run, { jobId: id });
  expect(await f.job(id)).toMatchObject({ state: "completed", attempt: 2, completedKeys: [first.files[0].key] });
  expect(await f.t.mutation(internal.retention.checkpoint, { ...f.fence(old), key: first.files[0].key, outcome: "deleted" })).toBe(false);
  const checkpointed = await f.job(id);
  response.resolve({ outcome: "failed_permanent" });
  await f.t.finishInProgressScheduledFunctions();
  expect(await f.job(id)).toEqual(checkpointed);
  await f.drain();
  expect(await f.job(id)).toMatchObject({ state: "completed", attempt: 2 });
  expect(await f.job(otherId)).toMatchObject({ state: "completed", attempt: 1 });
  expect(attempts).toBe(2);
  expect((await f.assets()).every(asset => asset.lifecycle === "deleted")).toBe(true);
});

test("permanent, exhausted and unknown failures remain reserved and visible through authorized progress", async () => {
  for (const outcome of ["failed_permanent", "failed_retryable", "unknown"] as const) {
    const f = await fixture();
    const handle = await f.upload();
    f.storage.deleteFiles = vi.fn<Storage["deleteFiles"]>(async () => ({ outcome }));
    const [id] = (await f.cancel(handle)).jobIds;
    await f.drain();
    const row = (await f.job(id))!;
    expect(row).toMatchObject({ state: "failed", lastOutcome: outcome, completedKeys: [],
      attempt: outcome === "failed_permanent" ? 1 : JOB_POLICY.maxAttempts });
    expect(await f.assets()).toMatchObject([{ lifecycle: "deleting", jobId: id }]);
    const args = { token: f.alice, intentId: handle.intentId, secret: handle.secret, jobId: id };
    expect(await f.t.query(api.retention.progress, args)).toMatchObject({ state: "failed", completedCount: 0, lastOutcome: outcome });
    await expect(f.t.query(api.retention.progress, { ...args, token: f.bob })).rejects.toThrow("UPLOAD_INTENT_NOT_FOUND");
    expect(await f.cancel(handle)).toEqual({ state: "failed", jobIds: [id] });
    const logs = vi.mocked(console.info).mock.calls;
    expect(logs[logs.length - 1][0]).toEqual({ jobId: id, kind: "cancellation", attempt: row.attempt,
      outcome: row.attempt === row.maxAttempts ? "exhausted" : outcome, durationMs: expect.any(Number), keyCount: 1 });
    expect(JSON.stringify(logs)).not.toContain(handle.files[0].key);
    expect(JSON.stringify(logs)).not.toContain(handle.secret);
    await f.t.mutation(internal.retention.recover, {});
    await f.drain();
    expect(await f.job(id)).toEqual(row);
  }
});

test("staff unattached keys need positive app verification; unverified keys are never deleted", async () => {
  const f = await fixture();
  f.storage.verifyAppKey = vi.fn(async () => false);
  const handle = await f.upload(1, "staff");
  const [id] = (await f.cancel(handle)).jobIds;
  await f.drain();
  expect(f.storage.verifyAppKey).toHaveBeenCalledWith(handle.files[0].key);
  expect(f.storage.deleteFiles).not.toHaveBeenCalled();
  expect(await f.job(id)).toMatchObject({ state: "failed", lastOutcome: "ownership_unverified" });
  expect(await f.assets()).toMatchObject([{ lifecycle: "deleting", jobId: id }]);
  const verified = await f.upload(1, "staff");
  f.storage.verifyAppKey = vi.fn(async () => true);
  const [verifiedId] = (await f.cancel(verified)).jobIds;
  await f.drain();
  expect(await f.job(verifiedId)).toMatchObject({ state: "completed" });
  expect(f.storage.deleteFiles).toHaveBeenCalledExactlyOnceWith([verified.files[0].key]);
});

test("an ownership-conflicted archived Ticket does not block later purge batches", async () => {
  const f = await fixture();
  const bad = await f.archived(1);
  await f.t.run(async ctx => {
    const asset = (await ctx.db.query("mediaAssets").withIndex("by_ticket", q => q.eq("ticketId", bad.ticketId)).first())!;
    await ctx.db.delete(asset._id);
  });
  const good = await f.archived(1);
  await f.t.mutation(internal.retention.claimPurges, {});
  const jobs = await f.t.run(ctx => ctx.db.query("mediaJobs").collect());
  expect(jobs.find(job => job.ticketId === bad.ticketId)).toMatchObject({ state: "failed", lastOutcome: "ownership_conflict" });
  expect(await f.t.run(ctx => ctx.db.get(bad.ticketId))).toMatchObject({ lifecycle: "archived" });
  await f.drain();
  expect(await f.t.run(ctx => ctx.db.get(good.ticketId))).toBeNull();
  expect(await f.t.mutation(internal.retention.claimPurges, {})).toBe(0);
});

test("a bad job fails durably and does not occupy the bounded recovery queue", async () => {
  const f = await fixture();
  const handle = await f.upload();
  const [badId] = (await f.cancel(handle)).jobIds;
  await f.t.run(async ctx => { await ctx.db.delete((await ctx.db.query("mediaAssets").first())!._id); });
  const [goodId] = (await f.cancel(await f.upload())).jobIds;
  await f.t.mutation(internal.retention.recover, {});
  await f.drain();
  expect(await f.job(badId)).toMatchObject({ state: "failed", attempt: 1, lastOutcome: "ownership_conflict" });
  expect(await f.job(goodId)).toMatchObject({ state: "completed" });
  expect(await f.t.mutation(internal.retention.recover, {})).toBe(0);
});

test("disabled destructive sweeps leave archived Tickets restorable while expiry queues reserved assets", async () => {
  const f = await fixture();
  const archived = await f.archived(1);
  const expired = await f.upload();
  await f.t.run(ctx => ctx.db.patch(expired.intentId, { expiresAt: Date.now() - 1 }));
  vi.stubEnv("MEDIA_CLEANUP_ENABLED", "false");
  expect(await f.t.mutation(internal.retention.claimPurges, {})).toBe(0);
  expect(await f.t.mutation(internal.retention.expireIntents, {})).toBe(1);
  const [job] = await f.t.run(ctx => ctx.db.query("mediaJobs").collect());
  expect(job).toMatchObject({ kind: "intent_expiry", state: "pending", attempt: 0, keys: [expired.files[0].key] });
  expect((await f.assets()).map(asset => asset.lifecycle)).toEqual(["attached", "deleting"]);
  expect((await f.assets())[1].jobId).toBe(job._id);
  expect(await f.t.run(ctx => ctx.db.get(expired.intentId))).toMatchObject({ status: "expiring" });
  expect(await f.t.mutation(internal.retention.recover, {})).toBe(0);
  expect(await f.t.run(ctx => ctx.db.system.query("_scheduled_functions").collect())).toEqual([]);
  expect(vi.mocked(console.info).mock.calls).toEqual([]);
  await f.drain();
  expect(provider.factory).not.toHaveBeenCalled();
  await f.t.mutation(api.tickets.restoreTicket, { token: f.staff, id: archived.ticketId, expectedVersion: 1 });
  vi.stubEnv("MEDIA_CLEANUP_ENABLED", "true");
  expect(await f.t.mutation(internal.retention.recover, {})).toBe(1);
  await f.drain();
  expect(await f.job(job._id)).toMatchObject({ state: "completed" });
  expect(await f.t.run(ctx => ctx.db.get(expired.intentId))).toMatchObject({ status: "cleaned" });
});

test("missing provider configuration retries without consuming attempts and recovers when configured", async () => {
  const f = await fixture();
  const [id] = (await f.cancel(await f.upload())).jobIds;
  provider.factory.mockImplementation(() => { throw new StorageConfigurationError(); });
  for (let index = 0; index < 10; index++) {
    await f.t.action(internal.media_job_actions.run, { jobId: id });
    const job = (await f.job(id))!;
    expect(job).toMatchObject({ state: "pending", attempt: 0, lastOutcome: "not_configured", completedKeys: [] });
    expect(job.availableAt).toBeGreaterThan(Date.now());
    vi.setSystemTime(job.availableAt);
  }
  provider.factory.mockReturnValue(f.storage);
  await f.drain();
  expect(await f.job(id)).toMatchObject({ state: "completed", attempt: 1 });
});

test("disabled cancellation queues reservations and defers execution without consuming attempts", async () => {
  const f = await fixture();
  const handle = await f.upload();
  vi.stubEnv("MEDIA_CLEANUP_ENABLED", "false");
  const result = await f.cancel(handle);
  const [id] = result.jobIds;
  expect(result.state).toBe("queued");
  expect(await f.cancel(handle)).toEqual(result);
  expect(await f.job(id)).toMatchObject({ state: "pending", attempt: 0 });
  expect(await f.assets()).toMatchObject([{ lifecycle: "deleting", jobId: id }]);
  expect(await f.t.run(ctx => ctx.db.get(handle.intentId))).toMatchObject({ status: "cancelled" });
  expect(await f.t.query(api.retention.progress, { token: f.alice, intentId: handle.intentId, secret: handle.secret, jobId: id }))
    .toMatchObject({ state: "pending", attempt: 0, completedCount: 0, totalCount: 1 });
  expect(await f.t.run(ctx => ctx.db.system.query("_scheduled_functions").collect())).toEqual([]);
  await f.t.action(internal.media_job_actions.run, { jobId: id });
  const deferredJob = (await f.job(id))!;
  expect(deferredJob).toMatchObject({ state: "pending", attempt: 0 });
  expect(deferredJob.availableAt - deferredJob.updatedAt).toBe(JOB_POLICY.backoffMs);
  expect(deferredJob).not.toHaveProperty("leaseId");
  expect(deferredJob).not.toHaveProperty("lastOutcome");
  expect(provider.factory).not.toHaveBeenCalled();
  expect(f.storage.verifyAppKey).not.toHaveBeenCalled();
  expect(f.storage.deleteFiles).not.toHaveBeenCalled();
  expect(vi.mocked(console.info).mock.calls).toEqual([[{ jobId: id, kind: "cancellation", attempt: 0, outcome: "cleanup_disabled" }]]);
  // Duplicate wakeups before availableAt neither log nor change the job.
  await f.t.action(internal.media_job_actions.run, { jobId: id });
  expect(await f.job(id)).toEqual(deferredJob);
  expect(vi.mocked(console.info).mock.calls).toHaveLength(1);
  vi.setSystemTime(deferredJob.availableAt);
  expect(await f.t.mutation(internal.retention.recover, {})).toBe(0);
  expect(await f.t.mutation(internal.retention.requeue, { jobId: id })).toBe(false);
  await f.drain();
  expect(await f.job(id)).toEqual(deferredJob);
  expect(provider.factory).not.toHaveBeenCalled();
});

test("disabled cancellation queues and reserves, then enabling recovery completes with a fake provider without requeue", async () => {
  const f = await fixture();
  const handle = await f.upload();
  vi.stubEnv("MEDIA_CLEANUP_ENABLED", "");
  const [id] = (await f.cancel(handle)).jobIds;
  expect(await f.job(id)).toMatchObject({ state: "pending", attempt: 0 });
  expect(await f.assets()).toMatchObject([{ lifecycle: "deleting", jobId: id }]);
  await f.drain();
  expect(provider.factory).not.toHaveBeenCalled();
  vi.stubEnv("MEDIA_CLEANUP_ENABLED", "true");
  expect(await f.t.mutation(internal.retention.recover, {})).toBe(1);
  await f.drain();
  expect(await f.job(id)).toMatchObject({ state: "completed", attempt: 1 });
  expect(await f.assets()).toMatchObject([{ lifecycle: "deleted", jobId: id }]);
  expect(f.storage.deleteFiles).toHaveBeenCalledExactlyOnceWith([handle.files[0].key]);
  expect(await f.cancel(handle)).toEqual({ state: "completed", jobIds: [id] });
});

test("disabling cleanup fences expired leases and pauses already scheduled provider work", async () => {
  const f = await fixture();
  const [runningId] = (await f.cancel(await f.upload())).jobIds;
  const claimed = (await f.t.mutation(internal.retention.claim, { jobId: runningId }))!;
  const [pendingId] = (await f.cancel(await f.upload())).jobIds;
  vi.stubEnv("MEDIA_CLEANUP_ENABLED", "false");
  vi.setSystemTime(claimed.leaseExpiresAt! + 1);
  const scheduled = await f.t.run(ctx => ctx.db.system.query("_scheduled_functions").collect());
  expect(await f.t.mutation(internal.retention.recover, {})).toBe(0);
  expect(await f.t.run(ctx => ctx.db.system.query("_scheduled_functions").collect())).toEqual(scheduled);
  await f.drain();
  expect(await f.job(runningId)).toMatchObject({ state: "pending", attempt: 1 });
  expect(await f.job(pendingId)).toMatchObject({ state: "pending", attempt: 0 });
  expect(provider.factory).not.toHaveBeenCalled();
  expect(await f.t.mutation(internal.retention.checkpoint, { ...f.fence(claimed), key: claimed.keys[0], outcome: "deleted" })).toBe(false);
  expect((await f.assets()).every(asset => asset.lifecycle === "deleting")).toBe(true);
  expect(vi.mocked(console.info).mock.calls).toHaveLength(2);
  const availableAt = Math.max((await f.job(runningId))!.availableAt, (await f.job(pendingId))!.availableAt);
  vi.setSystemTime(availableAt);
  vi.stubEnv("MEDIA_CLEANUP_ENABLED", "true");
  expect(await f.t.mutation(internal.retention.recover, {})).toBe(2);
  await f.drain();
  expect(await f.job(runningId)).toMatchObject({ state: "completed", attempt: 2 });
  expect(await f.job(pendingId)).toMatchObject({ state: "completed", attempt: 1 });
});

test("disabled rejected callbacks queue reserved receipts without scheduling deletion or allowing attachment", async () => {
  const f = await fixture();
  const handle = await f.upload();
  const late = { ...handle.files[0], key: "disabled-extra-key" };
  vi.stubEnv("MEDIA_CLEANUP_ENABLED", "");
  const args = { callbackToken: "fake-callback", intentId: handle.intentId, secret: handle.secret, file: late };
  const result = await f.t.mutation(api.uploads.recordUploadedFile, args);
  expect(result).toMatchObject({ state: "queued", jobIds: [expect.any(String)] });
  expect(await f.t.mutation(api.uploads.recordUploadedFile, args)).toEqual(result);
  const asset = (await f.assets()).find(row => row.key === late.key)!;
  expect(asset.lifecycle).toBe("deleting");
  const [id] = (await f.t.run(ctx => ctx.db.query("mediaJobs").collect())).map(job => job._id);
  expect(asset.jobId).toBe(id);
  expect(await f.job(id)).toMatchObject({ state: "pending", attempt: 0 });
  expect(await f.t.run(ctx => ctx.db.system.query("_scheduled_functions").collect())).toEqual([]);
  await f.drain();
  expect(provider.factory).not.toHaveBeenCalled();
  await expect(f.t.mutation(api.tickets.createTicket, { token: f.alice, projectId: f.seed.projects[0].id,
    title: "Blocked attachment", description: "", requestId: "disabled-rejected-attachment", media: [late],
    uploadIntentId: handle.intentId, uploadIntentSecret: handle.secret })).rejects.toThrow("MEDIA_NOT_ATTACHABLE");
  vi.stubEnv("MEDIA_CLEANUP_ENABLED", "true");
  expect(await f.t.mutation(internal.retention.recover, {})).toBe(1);
  await f.drain();
  expect((await f.assets()).find(row => row.key === late.key)).toMatchObject({ lifecycle: "deleted" });
  expect((await f.assets()).find(row => row.key === handle.files[0].key)).toMatchObject({ lifecycle: "pending" });
});

test("failed jobs can be requeued internally without releasing reservations or replaying completed keys", async () => {
  const f = await fixture();
  const handle = await f.archived(2);
  f.storage.deleteFiles = vi.fn<Storage["deleteFiles"]>(async keys => ({
    outcome: keys[0] === handle.files[0].key ? "deleted" : "failed_permanent",
  }));
  await f.t.mutation(internal.retention.claimPurges, {});
  await f.drain();
  const [job] = await f.t.run(ctx => ctx.db.query("mediaJobs").collect());
  expect(job).toMatchObject({ state: "failed", completedKeys: [handle.files[0].key] });
  expect(await f.t.mutation(internal.retention.requeue, { jobId: job._id })).toBe(true);
  expect(await f.t.mutation(internal.retention.requeue, { jobId: job._id })).toBe(false);
  expect(await f.job(job._id)).toMatchObject({ state: "pending", attempt: 0, completedKeys: [handle.files[0].key] });
  expect((await f.assets()).map(asset => asset.lifecycle)).toEqual(["deleted", "deleting"]);
  f.storage.deleteFiles = vi.fn<Storage["deleteFiles"]>(async () => ({ outcome: "deleted" }));
  await f.drain();
  expect(f.storage.deleteFiles).toHaveBeenCalledExactlyOnceWith([handle.files[1].key]);
  expect(await f.job(job._id)).toMatchObject({ state: "completed" });
  expect(await f.t.mutation(internal.retention.requeue, { jobId: job._id })).toBe(false);
});

test("ops can repair and requeue a blocked archived purge only while cleanup is enabled", async () => {
  const f = await fixture();
  const handle = await f.archived(1);
  const asset = (await f.assets())[0];
  await f.t.run(ctx => ctx.db.patch(asset._id, { lifecycle: "pending" }));
  await f.t.mutation(internal.retention.claimPurges, {});
  const [job] = await f.t.run(ctx => ctx.db.query("mediaJobs").collect());
  expect(await f.t.mutation(internal.retention.requeue, { jobId: job._id })).toBe(false);
  await f.t.run(ctx => ctx.db.patch(asset._id, { lifecycle: "attached" }));
  vi.stubEnv("MEDIA_CLEANUP_ENABLED", "false");
  expect(await f.t.mutation(internal.retention.requeue, { jobId: job._id })).toBe(false);
  expect(await f.t.run(ctx => ctx.db.get(handle.ticketId))).toMatchObject({ lifecycle: "archived", purgeBlocked: true });
  vi.stubEnv("MEDIA_CLEANUP_ENABLED", "true");
  expect(await f.t.mutation(internal.retention.requeue, { jobId: job._id })).toBe(true);
  await f.drain();
  expect(await f.job(job._id)).toMatchObject({ state: "completed" });
  expect(await f.t.run(ctx => ctx.db.get(handle.ticketId))).toBeNull();
});

test("provider retries use eight attempts with 30-second exponential backoff capped at 15 minutes", async () => {
  const f = await fixture();
  const [id] = (await f.cancel(await f.upload())).jobIds;
  f.storage.deleteFiles = vi.fn<Storage["deleteFiles"]>(async () => ({ outcome: "failed_retryable" }));
  for (const [index, delay] of [30, 60, 120, 240, 480, 900, 900].entries()) {
    await f.t.action(internal.media_job_actions.run, { jobId: id });
    const row = (await f.job(id))!;
    expect(row).toMatchObject({ state: "pending", attempt: index + 1 });
    expect(row.availableAt - row.updatedAt).toBe(delay * 1000);
    vi.setSystemTime(row.availableAt - 1);
    expect(await f.t.mutation(internal.retention.claim, { jobId: id })).toBeNull();
    vi.setSystemTime(row.availableAt);
  }
  await f.t.action(internal.media_job_actions.run, { jobId: id });
  expect(await f.job(id)).toMatchObject({ state: "failed", attempt: 8 });
  expect(f.storage.deleteFiles).toHaveBeenCalledTimes(8);
  await f.drain();
});

test("duplicate execution claims a pending job once", async () => {
  const f = await fixture();
  const [id] = (await f.cancel(await f.upload())).jobIds;
  expect(await f.job(id)).toMatchObject({ state: "pending" });
  await Promise.all([f.t.action(internal.media_job_actions.run, { jobId: id }), f.t.action(internal.media_job_actions.run, { jobId: id })]);
  expect(await f.job(id)).toMatchObject({ state: "completed", attempt: 1 });
  expect(f.storage.deleteFiles).toHaveBeenCalledTimes(1);
  await f.drain();
});

test("a timeout while awaiting a checkpoint cannot start the next provider request", async () => {
  // convex-test invokes this SDK handler property; the SDK hides it from public types.
  const checkpointHandler: (ctx: MutationCtx, args: FunctionArgs<typeof internal.retention.checkpoint>) => Promise<boolean>
    = Reflect.get(retention.checkpoint, "_handler");
  const f = await fixture({ ...modules, "../../convex/retention.ts": async () => ({ ...retention,
    checkpoint: { ...retention.checkpoint, _handler: async (...args: Parameters<typeof checkpointHandler>) => {
      const result = await checkpointHandler(...args);
      vi.advanceTimersByTime(JOB_POLICY.actionBudgetMs);
      return result;
    } },
  }) });
  const handle = await f.archived(2);
  await f.t.mutation(internal.retention.claimPurges, {});
  const [job] = await f.t.run(ctx => ctx.db.query("mediaJobs").collect());
  await f.t.run(async ctx => {
    for (const scheduled of await ctx.db.system.query("_scheduled_functions").collect()) {
      if (scheduled.state.kind === "pending") await ctx.scheduler.cancel(scheduled._id);
    }
  });
  await f.t.action(internal.media_job_actions.run, { jobId: job._id });
  expect(f.storage.deleteFiles).toHaveBeenCalledExactlyOnceWith([handle.files[0].key]);
  expect(await f.job(job._id)).toMatchObject({ state: "running", completedKeys: [handle.files[0].key] });
});

test("expiry and attachment compete atomically, and cleaned and cancelled terminal states remain stable", async () => {
  const f = await fixture();
  const attached = await f.upload();
  const attach = (handle: typeof attached) => f.t.mutation(api.tickets.createTicket, {
    token: f.alice, projectId: f.seed.projects[0].id, title: "Expiry fixture", description: "Fixture", requestId: `expiry-${handle.intentId}`,
    media: handle.files, uploadIntentId: handle.intentId, uploadIntentSecret: handle.secret,
  });
  const id = await attach(attached);
  await f.t.run(ctx => ctx.db.patch(attached.intentId, { expiresAt: Date.now() - 1 }));
  const expired = await f.upload();
  await f.t.run(ctx => ctx.db.patch(expired.intentId, { expiresAt: Date.now() }));
  const [creation, sweep] = await Promise.allSettled([attach(expired), f.t.mutation(internal.retention.expireIntents, {})]);
  expect(creation.status).toBe("rejected");
  expect(sweep.status).toBe("fulfilled");
  const reserved = (await f.assets()).find(asset => asset.intentId === expired.intentId)!;
  expect(reserved).toMatchObject({ lifecycle: "deleting", jobId: expect.any(String) });
  expect(await f.job(reserved.jobId!)).toMatchObject({ kind: "intent_expiry", keys: [expired.files[0].key], state: "pending" });
  const beforeExpiry = await f.upload();
  await f.t.run(ctx => ctx.db.patch(beforeExpiry.intentId, { expiresAt: Date.now() + 1 }));
  const attachedBeforeExpiry = await attach(beforeExpiry);
  const beforeSweep = (await f.assets()).find(asset => asset.intentId === beforeExpiry.intentId);
  vi.setSystemTime(Date.now() + 1);
  await f.t.mutation(internal.retention.expireIntents, {});
  expect((await f.assets()).find(asset => asset.intentId === beforeExpiry.intentId)).toMatchObject({ lifecycle: "attached", ticketId: attachedBeforeExpiry });
  expect((await f.assets()).find(asset => asset.intentId === beforeExpiry.intentId)).toEqual(beforeSweep);
  await expect(attach(expired)).rejects.toThrow("UPLOAD_INTENT_INVALID");
  const cancelled = await f.upload();
  await f.cancel(cancelled);
  await f.drain();
  expect(await f.t.run(ctx => ctx.db.get(expired.intentId))).toMatchObject({ status: "cleaned" });
  expect(await f.t.run(ctx => ctx.db.get(cancelled.intentId))).toMatchObject({ status: "cancelled" });
  expect(await f.t.run(ctx => ctx.db.get(id))).toMatchObject({ media: attached.files });
  const before = await f.t.run(ctx => ctx.db.query("uploadIntents").collect());
  await f.cancel(expired);
  await f.cancel(cancelled);
  await f.t.mutation(internal.retention.expireIntents, {});
  expect(await f.t.run(ctx => ctx.db.query("uploadIntents").collect())).toEqual(before);
  expect((await f.assets()).find(asset => asset.key === attached.files[0].key)).toMatchObject({ lifecycle: "attached" });
});

test("restore wins before the 30-day purge claim, is blocked after it, and every read hides purging Tickets", async () => {
  const f = await fixture();
  const restored = await f.archived();
  await f.t.mutation(api.tickets.restoreTicket, { token: f.staff, id: restored.ticketId, expectedVersion: 1 });
  expect(await f.t.mutation(internal.retention.claimPurges, {})).toBe(0);
  const recent = await f.archived();
  await f.t.run(ctx => ctx.db.patch(recent.ticketId, { archivedAt: Date.now() - ARCHIVE_RETENTION_MS + 1 }));
  expect(await f.t.mutation(internal.retention.claimPurges, {})).toBe(0);
  const claimed = await f.archived();
  const totals = await f.t.run(ctx => ctx.db.query("ticketTotals").collect());
  expect(await f.t.mutation(internal.retention.claimPurges, {})).toBe(1);
  await expect(f.t.mutation(api.tickets.restoreTicket, { token: f.staff, id: claimed.ticketId, expectedVersion: 1 })).rejects.toThrow("TICKET_PURGING");
  const row = (await f.t.run(ctx => ctx.db.get(claimed.ticketId)))!;
  for (const token of [f.staff, f.alice]) {
    expect(await f.t.query(api.tickets.getTicket, { token, id: row._id })).toBeNull();
    expect(await f.t.query(api.tickets.listTicketActivity, { token, id: row._id })).toEqual([]);
    expect(await f.t.query(api.annotations.listAnnotationActivity, { token, id: row._id })).toEqual([]);
  }
  expect(await f.t.query(api.tickets.getTicketByTicketNumber, { token: f.staff, projectKey: row.projectKey, ticketNumber: row.ticketNumber, includeDeleted: true })).toBeNull();
  expect((await f.t.query(api.tickets.pageTickets, { token: f.staff, projectId: row.projectId, lifecycle: "archived", paginationOpts: { numItems: 50, cursor: null } })).page.some(ticket => ticket._id === row._id)).toBe(false);
  expect((await f.t.query(api.tickets.pageTickets, { token: f.alice, projectId: row.projectId, lifecycle: "archived", paginationOpts: { numItems: 50, cursor: null } })).page.some(ticket => ticket._id === row._id)).toBe(false);
  await f.drain();
  expect(await f.t.run(ctx => ctx.db.query("ticketTotals").collect())).toEqual(totals);
  expect(await f.t.run(ctx => ctx.db.get(row._id))).toBeNull();
});

test("partial purge failure retains the Ticket and reservations, then retries only unfinished media", async () => {
  const f = await fixture();
  const handle = await f.archived();
  let fail = true;
  f.storage.deleteFiles = vi.fn<Storage["deleteFiles"]>(async keys => {
    if (keys[0] === handle.files[1].key && fail) { fail = false; return { outcome: "failed_retryable" }; }
    return { outcome: "deleted" };
  });
  await f.t.mutation(internal.retention.claimPurges, {});
  vi.runAllTimers();
  await f.t.finishInProgressScheduledFunctions();
  const [job] = await f.t.run(ctx => ctx.db.query("mediaJobs").collect());
  expect(job).toMatchObject({ state: "pending", completedKeys: [handle.files[0].key], phase: "delete_media" });
  expect(await f.t.run(ctx => ctx.db.get(handle.ticketId))).toMatchObject({ lifecycle: "purging" });
  expect((await f.assets()).filter(asset => asset.ticketId === handle.ticketId).map(asset => asset.lifecycle)).toEqual(["deleted", "deleting"]);
  await f.drain();
  expect(await f.job(job._id)).toMatchObject({ state: "completed", attempt: 2 });
  expect(f.storage.deleteFiles).toHaveBeenCalledTimes(3);
  expect(await f.t.run(ctx => ctx.db.get(handle.ticketId))).toBeNull();
});

test("crash after a durable deletion checkpoint resumes without provider replay", async () => {
  const f = await fixture();
  const handle = await f.archived(1);
  await f.t.mutation(internal.retention.claimPurges, {});
  const [pending] = await f.t.run(ctx => ctx.db.query("mediaJobs").collect());
  const claimed = (await f.t.mutation(internal.retention.claim, { jobId: pending._id }))!;
  const args = f.fence(claimed);
  expect(await f.storage.deleteFiles([handle.files[0].key])).toEqual({ outcome: "deleted" });
  await f.t.mutation(internal.retention.checkpoint, { ...args, key: handle.files[0].key, outcome: "deleted" });
  // Lost process between the provider checkpoint and database finalization.
  vi.setSystemTime(Date.now() + JOB_POLICY.leaseMs + 1);
  await f.t.mutation(internal.retention.recover, {});
  await f.drain();
  const done = await f.job(pending._id);
  expect(done).toMatchObject({ state: "completed", attempt: 1 });
  expect(f.storage.deleteFiles).toHaveBeenCalledTimes(1);
  expect(await f.t.mutation(internal.retention.advance, args)).toBe(false);
  expect(await f.job(pending._id)).toEqual(done);
});

test("crash before deletion checkpoint cannot credit an already-absent response and preserves ownership", async () => {
  const f = await fixture();
  const handle = await f.archived(1);
  await f.t.mutation(internal.retention.claimPurges, {});
  const [pending] = await f.t.run(ctx => ctx.db.query("mediaJobs").collect());
  await f.t.mutation(internal.retention.claim, { jobId: pending._id });
  // Provider deletion happened but its acknowledgement was lost with the process.
  f.storage.deleteFiles = vi.fn<Storage["deleteFiles"]>(async () => ({ outcome: "unknown" }));
  vi.setSystemTime(Date.now() + JOB_POLICY.leaseMs + 1);
  await f.t.mutation(internal.retention.recover, {});
  await f.drain();
  expect(await f.job(pending._id)).toMatchObject({ state: "failed", completedKeys: [], lastOutcome: "unknown" });
  expect(await f.t.run(ctx => ctx.db.get(handle.ticketId))).toMatchObject({ lifecycle: "purging" });
  expect(await f.assets()).toMatchObject([{ lifecycle: "deleting", jobId: pending._id }]);
});

test("large audit histories renew leases and finish after lease expiry with an exhausted provider budget", async () => {
  const f = await fixture();
  const handle = await f.archived(0);
  await f.t.run(async ctx => {
    for (let index = 0; index < AUDIT_BATCH * 2 + 7; index++) {
      await ctx.db.insert("ticketEvents", { ticketId: handle.ticketId, action: "edited", sessionId: (await ctx.db.query("sessions").first())!._id,
        actorRole: "staff", createdAt: Date.now() });
      await ctx.db.insert("annotationEvents", { ticketId: handle.ticketId, annotationId: `${index}`, action: "created",
        sessionId: (await ctx.db.query("sessions").first())!._id, actorRole: "staff", createdAt: Date.now() });
    }
  });
  const counts = () => f.t.run(async ctx => ({
    events: (await ctx.db.query("ticketEvents").withIndex("by_ticket", q => q.eq("ticketId", handle.ticketId)).collect()).length,
    annotations: (await ctx.db.query("annotationEvents").withIndex("by_ticket", q => q.eq("ticketId", handle.ticketId)).collect()).length,
  }));
  const before = await counts();
  await f.t.mutation(internal.retention.claimPurges, {});
  const [pending] = await f.t.run(ctx => ctx.db.query("mediaJobs").collect());
  await f.t.run(ctx => ctx.db.patch(pending._id, { attempt: JOB_POLICY.maxAttempts }));
  const claimed = (await f.t.mutation(internal.retention.claim, { jobId: pending._id }))!;
  const args = f.fence(claimed);
  await f.t.mutation(internal.retention.advance, args);
  expect(await f.job(pending._id)).toMatchObject({ phase: "delete_ticket", state: "running" });
  expect(await f.t.run(ctx => ctx.db.get(handle.ticketId))).not.toBeNull();
  await f.t.mutation(internal.retention.advance, args);
  expect(await f.t.run(ctx => ctx.db.get(handle.ticketId))).toBeNull();
  expect(await f.job(pending._id)).toMatchObject({ phase: "delete_events", state: "running" });
  expect(await counts()).toEqual(before);
  const receipts = await f.t.run(ctx => ctx.db.query("ticketRequests").withIndex("by_ticket", q => q.eq("ticketId", handle.ticketId)).collect());
  expect(receipts).toMatchObject([{ outcome: "unavailable" }]);
  const beforeAdvance = (await f.job(pending._id))!;
  vi.setSystemTime(beforeAdvance.leaseExpiresAt! - 1);
  await f.t.mutation(internal.retention.advance, args);
  expect(await counts()).toEqual({ events: before.events - AUDIT_BATCH, annotations: before.annotations - AUDIT_BATCH });
  expect(await f.job(pending._id)).toMatchObject({ phase: "delete_events", state: "running" });
  expect((await f.job(pending._id))!.leaseExpiresAt).toBe(Date.now() + JOB_POLICY.leaseMs);
  vi.setSystemTime(Date.now() + JOB_POLICY.leaseMs + 1);
  expect(await f.t.mutation(internal.retention.advance, args)).toBe(false);
  await f.t.mutation(internal.retention.recover, {});
  await f.drain();
  expect(await counts()).toEqual({ events: 0, annotations: 0 });
  expect(await f.job(pending._id)).toMatchObject({ state: "completed", phase: "complete", attempt: JOB_POLICY.maxAttempts });
  expect(f.storage.deleteFiles).not.toHaveBeenCalled();
  await expect(f.t.mutation(api.tickets.createTicket, {
    token: f.alice, projectId: f.seed.projects[0].id, title: "Purge fixture", description: "Fixture", media: handle.files,
    requestId: handle.requestId, uploadIntentId: handle.intentId, uploadIntentSecret: handle.secret,
  })).rejects.toThrow("TICKET_UNAVAILABLE");
});

test("both HTTP adapters share real authorization and malformed-input behavior and provide authorized queued progress", async () => {
  const f = await fixture();
  vi.stubEnv("MEDIA_CLEANUP_ENABLED", "");
  const handle = await f.upload();
  const handler = cancelUploadHandler({ cancel: args => f.t.mutation(api.uploads.cancelUploadIntent, args) });
  httpRuntime.cancelUpload.mockImplementation(handler);
  const hono = createUploadApp({ cancelUpload: handler }, async () => new Response());
  const request = (body: string, token = f.alice) => new Request("http://fake.invalid/api/uploads/cancel", {
    method: "POST", body, headers: { authorization: `Bearer ${token}` },
  });
  const body = JSON.stringify({ intentId: handle.intentId, secret: handle.secret });
  const cases = [["not-json", f.alice], ["null", f.alice], ["[]", f.alice], ['{"intentId":1}', f.alice], [body, "expired"], [body, f.bob],
    [JSON.stringify({ intentId: handle.intentId, secret: "wrong" }), f.alice],
    [JSON.stringify({ intentId: "malformed-id", secret: "fake" }), f.alice]];
  for (const [input, token] of cases) {
    const responses = await Promise.all([POST(request(input, token)), hono.request(request(input, token))]);
    expect(responses[0].status).toBe(responses[1].status);
    expect([400, 401]).toContain(responses[0].status);
    expect(await responses[0].json()).toEqual(await responses[1].json());
  }
  const queued = await (await POST(request(body))).json();
  expect(queued).toMatchObject({ ok: true, state: "queued", jobIds: [expect.any(String)] });
  expect(queued).not.toHaveProperty("deletedCount");
  const progressArgs = { token: f.alice, intentId: handle.intentId, secret: handle.secret, jobId: queued.jobIds[0] };
  expect(await f.t.query(api.retention.progress, progressArgs)).toMatchObject({ state: "pending", completedCount: 0 });
  expect(await (await hono.request(request(body))).json()).toEqual(queued);
  expect(provider.factory).not.toHaveBeenCalled();
  vi.stubEnv("MEDIA_CLEANUP_ENABLED", "true");
  expect(await f.t.mutation(internal.retention.recover, {})).toBe(1);
  await f.drain();
  expect(await f.t.query(api.retention.progress, progressArgs)).toMatchObject({ state: "completed", completedCount: 1 });
  expect(await (await hono.request(request(body))).json()).toMatchObject({ ok: true, state: "completed", jobIds: queued.jobIds });
});

test("bounded expiry and recovery scans recover lost pending wakeups", async () => {
  const f = await fixture();
  await f.t.run(async ctx => {
    const session = (await ctx.db.query("sessions").first())!;
    for (let index = 0; index < SWEEP_LIMIT + 3; index++) await ctx.db.insert("uploadIntents", {
      sessionId: session._id, actorRole: "staff", secret: "fake", idempotencyKey: `expired-${index}`,
      expectedFiles: [], uploadedFiles: [], status: "pending", createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() - 1,
    });
  });
  expect(await f.t.mutation(internal.retention.expireIntents, {})).toBe(SWEEP_LIMIT);
  expect(await f.t.mutation(internal.retention.expireIntents, {})).toBe(3);
  const handle = await f.upload();
  const [id] = (await f.cancel(handle)).jobIds;
  await f.t.run(async ctx => {
    const scheduled = await ctx.db.system.query("_scheduled_functions").collect();
    for (const wakeup of scheduled) if (wakeup.state.kind === "pending") await ctx.scheduler.cancel(wakeup._id);
  });
  expect(await f.job(id)).toMatchObject({ state: "pending", attempt: 0 });
  expect(await f.t.mutation(internal.retention.recover, {})).toBe(1);
  await f.drain();
  expect(await f.job(id)).toMatchObject({ state: "completed", attempt: 1 });
  await f.t.run(async ctx => {
    for (let index = 0; index < SWEEP_LIMIT + 3; index++) await ctx.db.insert("mediaJobs", {
      kind: "cancellation", resourceScope: `asset:lost-empty-${index}`, keys: [], completedKeys: [], phase: "delete_media",
      state: "pending", attempt: 0, maxAttempts: 5, availableAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now(),
    });
  });
  expect(await f.t.mutation(internal.retention.recover, {})).toBe(SWEEP_LIMIT);
  await f.drain();
  expect((await f.t.run(ctx => ctx.db.query("mediaJobs").collect())).filter(job => job.state === "pending")).toHaveLength(3);
  expect(await f.t.mutation(internal.retention.recover, {})).toBe(3);
  await f.drain();
});

test("action budget queues an unknown result while a late provider response cannot change durable progress", async () => {
  const f = await fixture();
  const handle = await f.upload();
  const [id] = (await f.cancel(handle)).jobIds;
  const started = deferred<void>();
  const response = deferred<StorageDeletionOutcome>();
  f.storage.deleteFiles = vi.fn<Storage["deleteFiles"]>(async () => { started.resolve(); return response.promise; });
  const execution = f.t.action(internal.media_job_actions.run, { jobId: id });
  await started.promise;
  vi.advanceTimersByTime(JOB_POLICY.actionBudgetMs);
  await execution;
  const timedOut = await f.job(id);
  expect(timedOut).toMatchObject({ state: "pending", lastOutcome: "unknown", completedKeys: [], attempt: 1 });
  expect(await f.assets()).toMatchObject([{ lifecycle: "deleting", jobId: id }]);
  response.resolve({ outcome: "deleted" });
  await f.t.finishInProgressScheduledFunctions();
  expect(await f.job(id)).toEqual(timedOut);
  f.storage.deleteFiles = vi.fn<Storage["deleteFiles"]>(async () => ({ outcome: "unknown" }));
  await f.drain();
  expect(await f.job(id)).toMatchObject({ state: "failed", lastOutcome: "unknown", completedKeys: [] });
});

test("a rejected late callback after cleanup gets its own job without reopening a cleaned intent", async () => {
  const f = await fixture();
  const handle = await f.upload();
  await f.t.run(ctx => ctx.db.patch(handle.intentId, { expiresAt: Date.now() - 1 }));
  await f.t.mutation(internal.retention.expireIntents, {});
  await f.drain();
  const terminal = await f.t.run(ctx => ctx.db.get(handle.intentId));
  expect(terminal).toMatchObject({ status: "cleaned" });
  const late = { ...handle.files[0], key: "fake-late-key", url: "https://fake.invalid/late" };
  const queued = await f.t.mutation(api.uploads.recordUploadedFile, {
    callbackToken: "fake-callback", intentId: handle.intentId, secret: handle.secret, file: late,
  });
  expect(queued).toMatchObject({ state: "queued", jobIds: [expect.any(String)] });
  expect(await f.cancel(handle)).toMatchObject({ state: "queued" });
  expect(await f.t.run(ctx => ctx.db.get(handle.intentId))).toEqual(terminal);
  await f.drain();
  expect((await f.assets()).find(asset => asset.key === late.key)).toMatchObject({ lifecycle: "deleted" });
  expect(await f.t.run(ctx => ctx.db.get(handle.intentId))).toEqual(terminal);
});

test("a failed rejected-upload job cannot roll back cancellation reservations for other owned assets", async () => {
  const f = await fixture();
  const handle = await f.upload();
  const rejected = { ...handle.files[0], key: "rejected-extra-key", name: "undeclared.png" };
  await f.t.mutation(api.uploads.recordUploadedFile, {
    callbackToken: "fake-callback", intentId: handle.intentId, secret: handle.secret, file: rejected,
  });
  f.storage.deleteFiles = vi.fn<Storage["deleteFiles"]>(async keys => ({ outcome: keys[0] === rejected.key ? "failed_permanent" : "deleted" }));
  await f.drain();
  const cancelled = await f.cancel(handle);
  expect(cancelled).toMatchObject({ state: "failed", jobIds: [expect.any(String), expect.any(String)] });
  expect(await f.t.run(ctx => ctx.db.get(handle.intentId))).toMatchObject({ status: "cancelled" });
  expect((await f.assets()).find(asset => asset.key === handle.files[0].key)).toMatchObject({ lifecycle: "deleting", jobId: expect.any(String) });
  await f.drain();
  expect((await f.assets()).find(asset => asset.key === handle.files[0].key)).toMatchObject({ lifecycle: "deleted" });
  expect((await f.assets()).find(asset => asset.key === rejected.key)).toMatchObject({ lifecycle: "deleting" });
});

test("bounded cancellation reads do not let historical deleted assets hide pending accepted uploads", async () => {
  const f = await fixture();
  const handle = await f.upload();
  for (let index = 0; index < MAX_MEDIA_FILES + 2; index++) {
    await f.t.mutation(api.uploads.recordUploadedFile, { callbackToken: "fake-callback", intentId: handle.intentId,
      secret: handle.secret, file: { ...handle.files[0], key: `rejected-history-${index}`, name: "undeclared.png" } });
  }
  await f.drain();
  const result = await f.cancel(handle);
  expect(result.state).toBe("queued");
  expect((await f.assets()).find(asset => asset.key === handle.files[0].key)).toMatchObject({ lifecycle: "deleting", jobId: expect.any(String) });
  await f.drain();
  expect((await f.assets()).every(asset => asset.lifecycle === "deleted")).toBe(true);
});
