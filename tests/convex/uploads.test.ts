import { fixtures, identityTest, whoami } from "./identity-harness";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import schema from "../../convex/schema";
import { modules } from "./modules";
import { recordUploadHandler } from "../../server/handlers/record-upload";
import { reconcileUploadWrite } from "../../shared/upload-receipt";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("LOCAL_FIXTURES_ENABLED", "true");
  vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3212");
  vi.stubEnv("UPLOAD_CALLBACK_SECRET", "fake-callback-secret");
  vi.stubEnv("MEDIA_CLEANUP_ENABLED", "true");
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

async function fixture() {
  const t = identityTest(modules);
  const seed = await t.mutation(internal.seed.install, {});
  const [staff, alice, bob] = seed.sessions;
  const file = { key: "fake-key", name: "fixture.png", size: 1, type: "image/png", url: "https://fixture.invalid/image.png" };
  async function intent(requestId = "original-media-request", token = alice, files = [file]) {
    return await t.mutation(api.uploads.createUploadIntent, { token, idempotencyKey: requestId, files: files.map(({ name, size, type }) => ({ name, size, type })) });
  }
  async function snapshot() {
    return await t.run(async ctx => ({
      assets: await ctx.db.query("mediaAssets").collect(), jobs: await ctx.db.query("mediaJobs").collect(),
      intents: await ctx.db.query("uploadIntents").collect(), tickets: await ctx.db.query("tickets").collect(),
      receipts: await ctx.db.query("ticketRequests").collect(), events: await ctx.db.query("ticketEvents").collect(),
      totals: await ctx.db.query("ticketTotals").collect(),
    }));
  }
  const record = (handle: Awaited<ReturnType<typeof intent>>, uploaded = file) => t.mutation(api.uploads.recordUploadedFile, {
    intentId: handle.intentId, secret: handle.secret, file: uploaded, callbackToken: "fake-callback-secret",
  });
  const create = (handle: Awaited<ReturnType<typeof intent>>, token = alice, media = [file], requestId = "original-media-request") => t.mutation(api.tickets.createTicket, {
    token, projectId: seed.projects[0].id, requestId, title: "Media Ticket", description: "", media,
    uploadIntentId: handle.intentId, uploadIntentSecret: handle.secret,
  });
  return { t, seed, staff, alice, bob, file, intent, snapshot, record, create };
}

test("first recording rejects forged calls, customer credentials and staff credentials for the wrong intent", async () => {
  const { t, staff, alice, file, intent, snapshot } = await fixture();
  const handle = await intent();
  const input = { intentId: handle.intentId, secret: handle.secret, file };
  const before = await snapshot();
  for (const credentials of [{}, { callbackToken: "forged" }, { token: "missing" }, { token: alice }, { token: staff }]) {
    await expect(t.mutation(api.uploads.recordUploadedFile, { ...input, ...credentials })).rejects.toThrow();
  }
  const staffIntent = await intent("staff-media-request", staff);
  const otherStaff = (await t.mutation(fixtures.staff, { email: "other@fixture.test", role: "staff" })).session;
  await expect(t.mutation(api.uploads.recordUploadedFile, { ...input, intentId: staffIntent.intentId, secret: staffIntent.secret, token: otherStaff })).rejects.toThrow("UPLOAD_INTENT_NOT_FOUND");
  expect((await snapshot()).assets).toEqual(before.assets);
  expect((await snapshot()).jobs).toEqual([]);
  expect(await t.mutation(api.uploads.recordUploadedFile, { ...input, intentId: staffIntent.intentId, secret: staffIntent.secret, token: staff })).toEqual({ state: "recorded" });
});

test("exclusive indexed claims reject another intent before and after Ticket attachment", async () => {
  const { intent, file, record, create, snapshot } = await fixture();
  const own = await intent();
  const other = await intent("other-media-request");
  const claims = await Promise.allSettled([record(own), record(other)]);
  expect(claims.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(claims.find(result => result.status === "rejected")).toMatchObject({ reason: { data: { code: "MEDIA_OWNERSHIP_CONFLICT" } } });
  // convex-test serializes calls; use the winning intent, without assuming order.
  const winner = claims[0].status === "fulfilled" ? own : other;
  const loser = winner === own ? other : own;
  const id = await create(winner);
  const before = await snapshot();
  await expect(record(loser)).rejects.toThrow("MEDIA_OWNERSHIP_CONFLICT");
  await expect(create(loser, undefined, [file], "different-ticket-request")).rejects.toThrow("UPLOAD_INCOMPLETE");
  expect(await snapshot()).toEqual(before);
  expect(before.assets).toMatchObject([{ key: file.key, intentId: winner.intentId, ticketId: id, lifecycle: "attached" }]);
});

test("trusted receipt replays before and after attachment neither duplicate nor reserve deletion", async () => {
  const { intent, file, record, create, snapshot } = await fixture();
  const handle = await intent();
  await Promise.all([record(handle), record(handle), record(handle)]);
  expect((await snapshot()).assets).toHaveLength(1);
  expect((await snapshot()).assets[0].source).toBe("callback");
  const id = await create(handle);
  const before = await snapshot();
  expect(await record(handle)).toEqual({ state: "recorded" });
  expect(await create(handle)).toBe(id);
  await expect(record(handle, { ...file, url: "https://forged.invalid/file" })).rejects.toThrow("UPLOAD_VERIFICATION_FAILED");
  await expect(create(handle, undefined, [{ ...file, url: "https://forged.invalid/file" }])).rejects.toThrow("UPLOAD_VERIFICATION_FAILED");
  expect(await snapshot()).toEqual(before);
  expect(before.jobs).toEqual([]);
});

test("attachment verifies trusted URL and metadata and atomically rejects deleting assets", async () => {
  const { t, intent, file, record, create, snapshot } = await fixture();
  const handle = await intent();
  await record(handle);
  const before = await snapshot();
  for (const changed of [{ url: "https://forged.invalid/file" }, { name: "changed.png" }, { size: 2 }, { type: "image/jpeg" }]) {
    await expect(create(handle, undefined, [{ ...file, ...changed }])).rejects.toThrow("UPLOAD_VERIFICATION_FAILED");
    expect(await snapshot()).toEqual(before);
  }
  await t.run(ctx => ctx.db.patch(before.assets[0]._id, { lifecycle: "deleting" }));
  const deleting = await snapshot();
  await expect(create(handle)).rejects.toThrow("MEDIA_NOT_ATTACHABLE");
  expect(await snapshot()).toEqual(deleting);
});

test("cancel reserves only unattached owned assets; duplicate and late callbacks retain immutable reservations", async () => {
  const { t, alice, intent, file, record, snapshot } = await fixture();
  const handle = await intent();
  const credentials = { token: alice, intentId: handle.intentId, secret: handle.secret };
  await t.mutation(api.uploads.cancelUploadIntent, credentials);
  const queued = await record(handle);
  expect(queued.state).toBe("queued");
  const reserved = await snapshot();
  expect(reserved.assets).toMatchObject([{ key: file.key, lifecycle: "deleting", intentId: handle.intentId, jobId: reserved.jobs[0]._id }]);
  expect(reserved.jobs).toMatchObject([{ kind: "rejected_upload", keys: [file.key], state: "pending" }]);
  expect(await record(handle)).toEqual(queued);
  await t.mutation(api.uploads.cancelUploadIntent, credentials);
  expect(await snapshot()).toEqual(reserved);
  await expect(t.mutation(api.uploads.recordUploadedFile, { ...credentials, token: undefined, callbackToken: "fake-callback-secret", file: { ...file, url: "https://forged.invalid/file" } })).rejects.toThrow("UPLOAD_VERIFICATION_FAILED");
});

test("expired intents reserve late new files but replay an already attached receipt safely", async () => {
  const { t, intent, record, create, snapshot } = await fixture();
  const expired = await intent();
  await t.run(ctx => ctx.db.patch(expired.intentId, { expiresAt: Date.now() - 1 }));
  expect((await record(expired)).state).toBe("queued");
  await expect(create(expired)).rejects.toThrow("UPLOAD_INTENT_INVALID");
  expect((await snapshot()).jobs).toHaveLength(1);
  const attached = await intent("attached-media-request");
  const file = { key: "second-key", name: "fixture.png", size: 1, type: "image/png", url: "https://fixture.invalid/second.png" };
  await record(attached, file);
  await create(attached, undefined, [file]);
  await t.run(ctx => ctx.db.patch(attached.intentId, { expiresAt: Date.now() - 1 }));
  const before = await snapshot();
  expect(await record(attached, file)).toEqual({ state: "recorded" });
  expect(await snapshot()).toEqual(before);
});

test("callback response loss reconciles the committed registered mutation; unresolved writes never reserve deletion", async () => {
  const { t, intent, file, snapshot } = await fixture();
  const handle = await intent();
  let attempts = 0;
  const callback = recordUploadHandler(async input => {
    const result = await t.mutation(api.uploads.recordUploadedFile, input);
    if (++attempts === 1) throw new Error("lost response with secret/token/url");
    return result;
  }, "fake-callback-secret");
  await callback({ intentId: handle.intentId, secret: handle.secret, file });
  expect(attempts).toBe(2);
  expect((await snapshot()).assets).toHaveLength(1);
  const before = await snapshot();
  const unknown = recordUploadHandler(async input => {
    await t.mutation(api.uploads.recordUploadedFile, input);
    throw new Error("lost again");
  }, "fake-callback-secret");
  await expect(unknown({ intentId: handle.intentId, secret: handle.secret, file })).rejects.toThrow("UPLOAD_RECORDING_UNKNOWN");
  expect(await snapshot()).toEqual(before);
  expect(before.jobs).toEqual([]);
});

test("durable actor intents resume after re-login and a cancelled rejected request accepts changed files", async () => {
  const { t, alice, intent, file, record, create, snapshot } = await fixture();
  const handle = await intent();
  await record(handle);
  const session = (await whoami(t, alice));
  const freshSession = await t.mutation(fixtures.session, { customerId: session.customerId! });
  const resumed = await intent("original-media-request", freshSession);
  expect(resumed.intentId).toBe(handle.intentId);
  expect(resumed.uploadedFiles).toEqual([file]);
  expect(await t.query(api.uploads.validateUploadIntent, { callbackToken: "fake-callback-secret", token: freshSession, intentId: handle.intentId, secret: handle.secret, files: [file].map(({ name, size, type }) => ({ name, size, type })) })).toBe(false);
  const id = await create(handle, freshSession);
  expect((await intent("original-media-request", freshSession)).ticketId).toBe(id);
  const rejected = await intent("rejected-media-request");
  await t.mutation(api.uploads.cancelUploadIntent, { token: alice, intentId: rejected.intentId, secret: rejected.secret });
  const corrected = await intent("rejected-media-request", alice, [{ ...file, name: "corrected.png" }]);
  expect(corrected.intentId).not.toBe(rejected.intentId);
  expect((await snapshot()).assets).toHaveLength(1);
});

test("another Ticket cannot attach an already owned key and a late extra receipt reserves only its new key", async () => {
  const { t, staff, intent, file, record, create, snapshot, seed } = await fixture();
  const handle = await intent("staff-media-request", staff);
  await record(handle);
  const id = await create(handle, staff);
  const before = await snapshot();
  await expect(t.mutation(api.tickets.attachTicketMedia, {
    token: staff, id: seed.tickets[0], requestId: "different-ticket-attachment", expectedVersion: 0,
    media: [file], uploadIntentId: handle.intentId, uploadIntentSecret: handle.secret,
  })).rejects.toThrow("UPLOAD_INTENT_INVALID");
  expect(await snapshot()).toEqual(before);
  const extra = { ...file, key: "late-extra-key" };
  const queued = await record(handle, extra);
  expect(queued.state).toBe("queued");
  const after = await snapshot();
  expect(after.assets).toMatchObject([
    { key: file.key, lifecycle: "attached", ticketId: id },
    { key: extra.key, lifecycle: "deleting" },
  ]);
  expect(after.jobs).toMatchObject([{ keys: [extra.key], state: "pending" }]);
  expect(after.tickets).toEqual(before.tickets);
  expect(await record(handle, extra)).toEqual(queued);
  expect(await snapshot()).toEqual(after);
});

test("staff re-login resumes the durable intent and binds recording to the acquiring session", async () => {
  const { t, staff, intent, file } = await fixture();
  const original = await intent("staff-media-request", staff);
  const freshStaff = await t.mutation(fixtures.session, { staffId: (await whoami(t, staff)).staffId });
  const resumed = await intent("staff-media-request", freshStaff);
  expect(resumed.intentId).toBe(original.intentId);
  const receipt = { intentId: resumed.intentId, secret: resumed.secret, file };
  await expect(t.mutation(api.uploads.recordUploadedFile, { ...receipt, token: staff })).rejects.toThrow("UPLOAD_INTENT_NOT_FOUND");
  expect(await t.mutation(api.uploads.recordUploadedFile, { ...receipt, token: freshStaff })).toEqual({ state: "recorded" });
});

test("staff-recorded assets retain staff source on callback replay", async () => {
  const { t, staff, intent, file, record, snapshot } = await fixture();
  const handle = await intent("staff-source-request", staff);
  await t.mutation(api.uploads.recordUploadedFile, { token: staff, intentId: handle.intentId, secret: handle.secret, file });
  expect((await snapshot()).assets).toMatchObject([{ source: "staff" }]);
  await record(handle);
  expect((await snapshot()).assets).toMatchObject([{ source: "staff" }]);
});

test("upload preflight returns false when recorded and incoming files exceed the limit", async () => {
  const { t, alice, intent, file, record } = await fixture();
  const files = Array.from({ length: 10 }, (_, index) => ({ ...file, key: `limit-key-${index}`, name: `limit-${index}.png` }));
  const handle = await intent("preflight-limit-request", alice, files);
  for (const uploaded of files) await record(handle, uploaded);
  expect(await t.query(api.uploads.validateUploadIntent, {
    token: alice, callbackToken: "fake-callback-secret", intentId: handle.intentId, secret: handle.secret,
    files: [{ name: file.name, size: file.size, type: file.type }],
  })).toBe(false);
});

test("definitively rejected new trusted uploads reserve their keys without changing accepted receipts", async () => {
  const { intent, record, file, snapshot } = await fixture();
  const handle = await intent();
  for (const rejected of [{ ...file, name: "undeclared.png", key: "undeclared-key" }, { ...file, url: "invalid-provider-url", key: "invalid-metadata-key" }]) {
    const result = await record(handle, rejected);
    expect(result.state).toBe("queued");
    const reserved = await snapshot();
    expect(await record(handle, rejected)).toEqual(result);
    expect(await snapshot()).toEqual(reserved);
  }
  const state = await snapshot();
  expect(state.assets.every(asset => asset.lifecycle === "deleting" && asset.jobId)).toBe(true);
  expect(state.jobs).toHaveLength(2);
  expect(state.intents.find(row => row._id === handle.intentId)?.uploadedFiles).toEqual([]);
  expect(await record(handle)).toEqual({ state: "recorded" });
});

test("staff CLI response loss reconciles registered recording and attachment without duplicate media or deletion", async () => {
  const { t, staff, intent, file, snapshot, seed } = await fixture();
  const handle = await intent("cli-media-request", staff);
  const receipt = { token: staff, intentId: handle.intentId, secret: handle.secret, file };
  let recordings = 0;
  await reconcileUploadWrite(async () => {
    const result = await t.mutation(api.uploads.recordUploadedFile, receipt);
    if (++recordings === 1) throw new Error("Lost CLI recording response");
    return result;
  });
  const input = { token: staff, id: seed.tickets[0], requestId: "cli-attachment-request", expectedVersion: 0,
    media: [file], uploadIntentId: handle.intentId, uploadIntentSecret: handle.secret };
  let attachments = 0;
  const result = await reconcileUploadWrite(async () => {
    const committed = await t.mutation(api.tickets.attachTicketMedia, input);
    if (++attachments === 1) throw new Error("Lost CLI attachment response");
    return committed;
  });
  expect(recordings).toBe(2);
  expect(attachments).toBe(2);
  expect(result.version).toBe(1);
  const before = await snapshot();
  expect(before.assets).toHaveLength(1);
  expect(before.tickets.find(row => row._id === input.id)?.media).toEqual([file]);
  expect(before.events.filter(event => event.ticketId === input.id && event.action === "media_attached")).toHaveLength(1);
  expect(before.jobs).toEqual([]);
  await expect(reconcileUploadWrite(async () => {
    await t.mutation(api.tickets.attachTicketMedia, input);
    throw new Error("Unresolved CLI attachment response");
  })).rejects.toThrow("UPLOAD_WRITE_UNKNOWN");
  expect(await snapshot()).toEqual(before);
});


test("staff cannot reserve arbitrary new keys on cancelled or expired intents", async () => {
  const { t, staff, intent, file, snapshot } = await fixture();
  for (const status of ["cancelled", "expired"] as const) {
    const handle = await intent(`staff-${status}-request`, staff);
    if (status === "cancelled") await t.mutation(api.uploads.cancelUploadIntent, { token: staff, intentId: handle.intentId, secret: handle.secret });
    else await t.run(ctx => ctx.db.patch(handle.intentId, { expiresAt: Date.now() - 1 }));
    const before = await snapshot();
    await expect(t.mutation(api.uploads.recordUploadedFile, {
      token: staff, intentId: handle.intentId, secret: handle.secret, file: { ...file, key: `unregistered-legacy-${status}` },
    })).rejects.toThrow("UPLOAD_INTENT_INVALID");
    expect(await snapshot()).toEqual(before);
  }
});

test("upload preflight verifies callback configuration and counts recorded files across the intent", async () => {
  const { t, alice, intent, file, record } = await fixture();
  const handle = await intent();
  const args = { token: alice, intentId: handle.intentId, secret: handle.secret,
    callbackToken: "fake-callback-secret", files: [{ name: file.name, type: file.type, size: file.size }] };
  expect(await t.query(api.uploads.validateUploadIntent, args)).toBe(true);
  await expect(t.query(api.uploads.validateUploadIntent, { ...args, callbackToken: "wrong" })).rejects.toThrow("TRUSTED_CALLBACK_REQUIRED");
  vi.stubEnv("UPLOAD_CALLBACK_SECRET", "");
  await expect(t.query(api.uploads.validateUploadIntent, args)).rejects.toThrow("UPLOAD_CALLBACK_NOT_CONFIGURED");
  vi.stubEnv("UPLOAD_CALLBACK_SECRET", "fake-callback-secret");
  await record(handle);
  expect(await t.query(api.uploads.validateUploadIntent, args)).toBe(false);
});

test("cancellation with no reserved jobs acknowledges completed", async () => {
  const { t, alice, intent } = await fixture();
  const handle = await intent();
  const args = { token: alice, intentId: handle.intentId, secret: handle.secret };
  expect(await t.mutation(api.uploads.cancelUploadIntent, args)).toEqual({ state: "completed", jobIds: [] });
  expect(await t.mutation(api.uploads.cancelUploadIntent, args)).toEqual({ state: "completed", jobIds: [] });
});
