import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import { localLineFixtureToken } from "../../convex/adapters/line";
import { sealLineSecret } from "../../convex/line_crypto";
import {
  claimMediaForStaging,
  expireStagedMedia,
  ingestCaptureMediaEvents,
  listIntakeMediaForStaff,
  MEDIA_LEASE_MS,
  reclaimFixtureMediaStorage,
  reconcileMediaWrites,
  recordStagedMedia,
  reserveMediaWrite,
  withdrawMediaByMessage,
} from "../../convex/line_capture_media_domain";
import {
  fixtureJpegBytes,
  fixturePngBytes,
  LINE_CAPTURE_MAX_TOTAL_BYTES,
  LINE_CAPTURE_STAGING_TTL_MS,
  sha256Hex,
} from "../../convex/line_capture_media_fetch";
import { identityTest } from "./identity-harness";
import { modules } from "./modules";

const SITE = "http://127.0.0.1:3213";
const APP = "http://127.0.0.1:5173";
const LINE_KEY_B64 = btoa("0123456789abcdef0123456789abcdef");
const CHAT_LINE_ID = "Cfixture-group-01";
const SENDER_USER_ID = "Ucustomer-01";
const BASE_TIME = 1_795_656_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE_TIME);
  vi.stubEnv("LOCAL_FIXTURES_ENABLED", "true");
  vi.stubEnv("LINE_CAPTURE_ENABLED", "true");
  vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3212");
  vi.stubEnv("CONVEX_SITE_URL", SITE);
  vi.stubEnv("TICKET_APP_ORIGINS", APP);
  vi.stubEnv("LINE_SECRETS_KEY", LINE_KEY_B64);
  vi.stubEnv("MEDIA_CLEANUP_ENABLED", "false");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function signWebhook(secret: string, body: string) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return btoa(String.fromCharCode(...mac));
}

async function setupCaptureFixture() {
  const t = identityTest(modules);
  const seed = await t.mutation(internal.seed.install, {});
  const [staff, alice] = seed.sessions;
  const projectId = seed.projects[0].id;
  const secret = "fixture-line-secret-value";
  const joinedAt = BASE_TIME - 60_000;

  const { botId, chatId, webhookSlug, botLineUserId } = await t.run(async ctx => {
    const botLineUserId = "Ufixture-POS";
    const webhookSlug = "fixture-capture-slug";
    const botId = await ctx.db.insert("lineBots", {
      projectId,
      name: "Fixture capture bot",
      locale: "th",
      lineUserId: botLineUserId,
      basicId: "@fixture-pos",
      displayName: "Fixture capture bot",
      webhookSlug,
      secretCipher: await sealLineSecret(secret),
      secretHint: secret.slice(-4),
      tokenCipher: await sealLineSecret(localLineFixtureToken),
      tokenHint: localLineFixtureToken.slice(-4),
      state: "active",
      allowDirectChats: false,
      signatureFailures: 0,
      createdAt: BASE_TIME - 120_000,
      updatedAt: BASE_TIME - 120_000,
    });
    const chatId = await ctx.db.insert("lineChats", {
      botId,
      projectId,
      kind: "group",
      lineChatId: CHAT_LINE_ID,
      name: "Fixture Group",
      state: "active",
      notify: "off",
      allowCreate: true,
      joinedAt,
      lastEventAt: joinedAt,
    });
    return { botId, chatId, webhookSlug, botLineUserId };
  });

  // Enable capture on the project and group as admitted owner/staff.
  await t.raw.withIdentity({ subject: staff }).mutation(api.line_capture.setProjectCapture, { projectId, enabled: true });
  await t.raw.withIdentity({ subject: staff }).mutation(api.line_capture.setChatCapture, { chatId, joinedAt, enabled: true });

  // Advance clock cleanly past opt-in timestamps.
  const now = BASE_TIME + 1_000;
  vi.setSystemTime(now);

  const postWebhook = async (events: unknown[]) => {
    const body = JSON.stringify({ destination: botLineUserId, events });
    const sig = await signWebhook(secret, body);
    return t.raw.fetch(`/line/webhook/${webhookSlug}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-line-signature": sig },
      body,
    });
  };

  const mentionEvent = (messageId: string, text = "@bot POS printer jammed", timestamp = Date.now(), webhookEventId = crypto.randomUUID()) => ({
    type: "message",
    mode: "active",
    webhookEventId,
    timestamp,
    source: { type: "group", groupId: CHAT_LINE_ID, userId: SENDER_USER_ID },
    message: {
      id: messageId,
      type: "text",
      text,
      mention: { mentionees: [{ index: 0, length: 4, type: "user", isSelf: true }] },
    },
  });

  const imageEvent = (
    messageId: string,
    timestamp = Date.now(),
    extra?: { imageSet?: unknown; contentProvider?: { type: string }; fileType?: "image" | "video" | "file" },
    webhookEventId = crypto.randomUUID(),
  ) => ({
    type: "message",
    mode: "active",
    webhookEventId,
    timestamp,
    source: { type: "group", groupId: CHAT_LINE_ID, userId: SENDER_USER_ID },
    message: {
      id: messageId,
      type: extra?.fileType ?? "image",
      contentProvider: extra?.contentProvider ?? { type: "line" },
      ...(extra?.imageSet !== undefined ? { imageSet: extra.imageSet } : {}),
    },
  });

  const unsendEvent = (messageId: string, timestamp = Date.now(), webhookEventId = crypto.randomUUID()) => ({
    type: "unsend",
    mode: "active",
    webhookEventId,
    timestamp,
    source: { type: "group", groupId: CHAT_LINE_ID, userId: SENDER_USER_ID },
    unsend: { messageId },
  });

  const fetchMedia = (token: string | null, urlOrPath: string, headers: Record<string, string> = {}) => {
    const path = urlOrPath.startsWith("http")
      ? new URL(urlOrPath).pathname + new URL(urlOrPath).search
      : urlOrPath;
    return (token ? t.raw.withIdentity({ subject: token }) : t.raw).fetch(path, {
      method: "GET",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    });
  };

  const settle = async (advanceMs = 100) => {
    await vi.advanceTimersByTimeAsync(advanceMs);
    await t.raw.finishInProgressScheduledFunctions();
  };

  const allMedia = () => t.run(ctx => ctx.db.query("intakeMedia").collect());
  const allIntakes = () => t.run(ctx => ctx.db.query("lineCaptureIntakes").collect());
  const allBlobs = () => t.run(ctx => ctx.db.system.query("_storage").collect());

  return {
    t, seed, staff, alice, projectId, botId, chatId, joinedAt, now,
    postWebhook, mentionEvent, imageEvent, unsendEvent, fetchMedia, settle,
    allMedia, allIntakes, allBlobs,
  };
}

test("signed mention + two screenshots in order (out-of-order imageSet) stage privately and serve bytes only to staff", async () => {
  const f = await setupCaptureFixture();

  // Send mention + 2 screenshots where imageSet index 2 arrives before index 1.
  const res = await f.postWebhook([
    f.mentionEvent("msg-mention-1", "@bot Receipt printer stopped", f.now),
    f.imageEvent("fixture-jpeg-2", f.now + 500, { imageSet: { id: "set-a", index: 2, total: 2 } }),
    f.imageEvent("fixture-png-1", f.now + 1000, { imageSet: { id: "set-a", index: 1, total: 2 } }),
  ]);
  expect(res.status).toBe(200);
  await f.settle();

  const [intake] = await f.allIntakes();
  expect(intake).toBeTruthy();

  const summary = await f.t.raw.withIdentity({ subject: f.staff }).query(api.line_capture_media.list, { intakeId: intake._id });
  expect(summary).toBeTruthy();
  expect(summary!.warnings).toEqual([]);
  expect(summary!.hasWarning).toBe(false);
  expect(summary!.items).toHaveLength(2);
  // Ordered by imageSetIndex [1, 2] regardless of arrival order.
  expect(summary!.items.map(item => [item.index, item.messageId, item.contentType])).toEqual([
    [1, "fixture-png-1", "image/png"],
    [2, "fixture-jpeg-2", "image/jpeg"],
  ]);
  // Preview URLs point to private authenticated bytes route, never a public Convex storage URL.
  for (const item of summary!.items) {
    expect(item.url).toBe(`${SITE}/v1/line-capture/media/${item.mediaId}?revision=${intake.revision}`);
    expect(item.url).not.toContain("/api/storage/");
  }

  // CORS preflight allows configured origin and rejects foreign origins.
  const preflightOk = await f.t.raw.fetch(`/v1/line-capture/media/${summary!.items[0].mediaId}`, {
    method: "OPTIONS",
    headers: { Origin: APP },
  });
  expect(preflightOk.status).toBe(204);
  expect(preflightOk.headers.get("access-control-allow-origin")).toBe(APP);

  const preflightBad = await f.t.raw.fetch(`/v1/line-capture/media/${summary!.items[0].mediaId}`, {
    method: "OPTIONS",
    headers: { Origin: "https://attacker.example" },
  });
  expect(preflightBad.status).toBe(403);

  // Staff fetches raw PNG and JPEG bytes with Cache-Control: no-store.
  const pngResp = await f.fetchMedia(f.staff, summary!.items[0].url!, { Origin: APP });
  expect(pngResp.status).toBe(200);
  expect(pngResp.headers.get("content-type")).toBe("image/png");
  expect(pngResp.headers.get("cache-control")).toBe("no-store");
  expect(pngResp.headers.get("x-content-type-options")).toBe("nosniff");
  expect(pngResp.headers.get("access-control-allow-origin")).toBe(APP);
  expect(new Uint8Array(await pngResp.arrayBuffer())).toEqual(fixturePngBytes());

  const jpegResp = await f.fetchMedia(f.staff, summary!.items[1].url!);
  expect(jpegResp.status).toBe(200);
  expect(jpegResp.headers.get("content-type")).toBe("image/jpeg");
  expect(new Uint8Array(await jpegResp.arrayBuffer())).toEqual(fixtureJpegBytes());

  // Denial checks: unauthenticated, invalid session, customer, disallowed origin, stale revision.
  expect((await f.fetchMedia(null, summary!.items[0].url!)).status).toBe(401);
  expect((await f.fetchMedia("missing-session", summary!.items[0].url!)).status).toBe(401);
  expect((await f.fetchMedia(f.alice, summary!.items[0].url!)).status).toBe(403);
  expect((await f.fetchMedia(f.staff, summary!.items[0].url!, { Origin: "https://evil.example" })).status).toBe(403);
  const staleResp = await f.fetchMedia(f.staff, `/v1/line-capture/media/${summary!.items[0].mediaId}?revision=999`);
  expect([staleResp.status, (await staleResp.json()).code]).toEqual([409, "MEDIA_REVISION_MISMATCH"]);
});

test("a screenshot survives another sender's withdrawal and becomes inaccessible after a second matching mention", async () => {
  const f = await setupCaptureFixture();
  const messageId = "fixture-png-shared-window";
  const otherWithdrawal = () => {
    const event = f.unsendEvent(messageId);
    return { ...event, source: { ...event.source, userId: "Uother" } };
  };
  await f.postWebhook([otherWithdrawal(), f.mentionEvent("first", "@bot Printer stalled", f.now),
    f.imageEvent(messageId, f.now + 100)]);
  await f.settle();
  const [intake] = await f.allIntakes();
  const list = () => f.t.raw.withIdentity({ subject: f.staff }).query(api.line_capture_media.list, { intakeId: intake._id });
  const url = (await list())!.items[0].url!;
  await f.postWebhook([otherWithdrawal()]);
  expect((await f.fetchMedia(f.staff, url)).status).toBe(200);
  await f.postWebhook([f.mentionEvent("second", "@bot Receipt missing", f.now + 600)]);
  expect((await f.fetchMedia(f.staff, url)).status).toBe(404);
  expect(await list()).toMatchObject({ items: [], warnings: ["MEDIA_MATCH_AMBIGUOUS"] });
});

async function secondMentionDuringStaging() {
  const f = await setupCaptureFixture();
  await f.postWebhook([f.mentionEvent("first", "@bot Printer stalled", f.now)]);
  const [first] = await f.allIntakes();
  const ingest = (messageId: string) => f.t.run(async ctx => (await ingestCaptureMediaEvents(ctx, {
    botId: f.botId,
    now: f.now,
    schedule: false,
    events: [{ webhookEventId: `ev-${messageId}`, timestamp: f.now + 100, kind: "group", lineChatId: CHAT_LINE_ID,
      messageId, senderDigest: first.senderDigest, fileType: "image", contentProvider: "line" }],
  }))[0].mediaId);
  const claim = (mediaId: Awaited<ReturnType<typeof ingest>>) =>
    f.t.run(ctx => claimMediaForStaging(ctx, { mediaId, now: f.now, scheduleRecovery: false }));
  const bytes = fixturePngBytes();
  const sha256 = await sha256Hex(bytes);
  const write = { sha256, size: bytes.byteLength, contentType: "image/png" as const, now: f.now };
  const reserve = (mediaId: Awaited<ReturnType<typeof ingest>>, leaseId: string) =>
    f.t.run(ctx => reserveMediaWrite(ctx, { mediaId, leaseId, ...write }));

  return { f, ingest, claim, reserve, write, bytes };
}

async function expectAmbiguousWarnings(f: Awaited<ReturnType<typeof setupCaptureFixture>>, mediaIds: string[]) {
  const rows = await f.allMedia();
  for (const id of mediaIds) {
    expect(rows.find(row => row._id === id)).toMatchObject({ state: "warning", warningCode: "MEDIA_MATCH_AMBIGUOUS" });
  }
  const intakes = await f.allIntakes();
  expect(intakes).toHaveLength(2);
  expect(intakes.map(intake => intake.warning)).toEqual(["MEDIA_MATCH_AMBIGUOUS", "MEDIA_MATCH_AMBIGUOUS"]);
  const list = await f.t.raw.withIdentity({ subject: f.staff }).query(api.line_capture_media.list, { intakeId: intakes[0]._id });
  expect(list).toMatchObject({ warnings: ["MEDIA_MATCH_AMBIGUOUS"] });
  expect(list!.items.every(item => !item.url)).toBe(true);
  return rows;
}

test("a second mention before claim leaves a staff warning instead of withdrawing the screenshot", async () => {
  const { f, ingest, claim } = await secondMentionDuringStaging();
  const mediaId = await ingest("fixture-png-claim");
  await f.postWebhook([f.mentionEvent("second", "@bot Receipt missing", f.now + 600)]);
  expect(await claim(mediaId)).toBeNull();
  await expectAmbiguousWarnings(f, [mediaId]);
});

test("a second mention during reservation or settlement keeps bytes private and warns both intakes", async () => {
  const { f, ingest, claim, reserve, write, bytes } = await secondMentionDuringStaging();
  const atReserve = await ingest("fixture-png-reserve");
  const atRecord = await ingest("fixture-png-record");
  const reserveLease = (await claim(atReserve))!.leaseId;
  const recordLease = (await claim(atRecord))!.leaseId;
  const reservation = await reserve(atRecord, recordLease);
  if (!reservation.ok) throw new Error("expected reservation");
  const storageId = await f.t.run(ctx => ctx.storage.store(new Blob([bytes], { type: reservation.writeContentType })));
  const record = (leaseId: string) => f.t.run(ctx => recordStagedMedia(ctx, {
    mediaId: atRecord, leaseId, marker: reservation.marker, width: 16, height: 16, storageId, ...write,
  }));

  await f.postWebhook([f.mentionEvent("second", "@bot Receipt missing", f.now + 600)]);

  expect(await reserve(atReserve, "stale-lease")).toEqual({ ok: false, code: "LEASE_EXPIRED" });
  expect(await reserve(atReserve, reserveLease)).toEqual({ ok: false, code: "MEDIA_MATCH_AMBIGUOUS" });
  expect(await record(recordLease)).toEqual({ settled: false, state: "warning" });

  const rows = await expectAmbiguousWarnings(f, [atReserve, atRecord]);
  const recorded = rows.find(row => row._id === atRecord)!;
  expect(recorded.storageId).toBeUndefined();
  expect(recorded.discarded).toEqual([storageId]);
  expect(recorded.writes).toEqual([]);
});

test("image-before-text coordinates via bounded durable retry once mention arrives", async () => {
  const f = await setupCaptureFixture();

  // Image arrives FIRST before any mention intake exists.
  const imgRes = await f.postWebhook([f.imageEvent("fixture-png-early", f.now)]);
  expect(imgRes.status).toBe(200);

  const rows = await f.allMedia();
  expect(rows).toHaveLength(1);
  expect(rows[0].state).toBe("unmatched");
  expect(await f.allBlobs()).toHaveLength(0); // No bytes downloaded while unmatched.

  // Text mention arrives 1 second later in a separate webhook.
  await vi.advanceTimersByTimeAsync(1_000);
  const textRes = await f.postWebhook([f.mentionEvent("msg-mention-late", "@bot Screenshot first", f.now + 1_000)]);
  expect(textRes.status).toBe(200);

  // Advance past the 2s bounded retry delay so retryMatch binds and stages the image.
  await f.settle(3_000);

  const [intake] = await f.allIntakes();
  const summary = await f.t.raw.withIdentity({ subject: f.staff }).query(api.line_capture_media.list, { intakeId: intake._id });
  expect(summary!.items).toHaveLength(1);
  expect(summary!.items[0].state).toBe("ready");
  expect(summary!.items[0].messageId).toBe("fixture-png-early");
  expect(summary!.items[0].url).toBeTruthy();

  const bytesResp = await f.fetchMedia(f.staff, summary!.items[0].url!);
  expect(bytesResp.status).toBe(200);
  expect(new Uint8Array(await bytesResp.arrayBuffer())).toEqual(fixturePngBytes());
});

test("imageSet overflow, malformed imageSetInvalid, PDFs and >2 images mark warnings without silently selecting a subset", async () => {
  const f = await setupCaptureFixture();

  // Case 1: imageSet with total=3 -> IMAGE_SET_OVERFLOW, nothing staged.
  await f.postWebhook([
    f.mentionEvent("msg-overflow", "@bot Too many photos", f.now),
    f.imageEvent("fixture-png-o1", f.now + 100, { imageSet: { id: "set-big", index: 1, total: 3 } }),
    f.imageEvent("fixture-png-o2", f.now + 200, { imageSet: { id: "set-big", index: 2, total: 3 } }),
    f.imageEvent("fixture-png-o3", f.now + 300, { imageSet: { id: "set-big", index: 3, total: 3 } }),
  ]);
  await f.settle();

  const [overflowIntake] = await f.allIntakes();
  expect(overflowIntake.warning).toBe("IMAGE_SET_OVERFLOW");
  const overflowSummary = await f.t.raw.withIdentity({ subject: f.staff }).query(api.line_capture_media.list, { intakeId: overflowIntake._id });
  expect(overflowSummary!.warnings).toContain("IMAGE_SET_OVERFLOW");
  expect(overflowSummary!.items.filter(item => item.url)).toEqual([]);
  expect(await f.allBlobs()).toHaveLength(0);

  // Case 2: Malformed upstream imageSet (Claude parser sets imageSetInvalid: true) -> IMAGE_SET_METADATA_INCOMPLETE.
  const tBadSet = f.now + 5 * 60_000;
  vi.setSystemTime(tBadSet);
  await f.postWebhook([
    f.mentionEvent("msg-badset", "@bot Broken set metadata", tBadSet),
    f.imageEvent("fixture-png-badset", tBadSet + 100, { imageSet: { id: "set-broken", index: 0, total: 2 } }),
  ]);
  await f.settle();

  const badSetIntake = (await f.allIntakes()).find(row => row.messageId === "msg-badset")!;
  expect(badSetIntake.warning).toBe("IMAGE_SET_METADATA_INCOMPLETE");
  const badSetSummary = await f.t.raw.withIdentity({ subject: f.staff }).query(api.line_capture_media.list, { intakeId: badSetIntake._id });
  expect(badSetSummary!.warnings).toContain("IMAGE_SET_METADATA_INCOMPLETE");
  expect(badSetSummary!.items.filter(item => item.url)).toEqual([]);

  // Case 3: PDF file message + video + external image -> visible warnings, zero blobs stored.
  const t2 = tBadSet + 10 * 60_000;
  vi.setSystemTime(t2);
  await f.postWebhook([
    f.mentionEvent("msg-files", "@bot Attached PDF and video", t2),
    f.imageEvent("fixture-file-1", t2 + 100, { fileType: "file" }),
    f.imageEvent("fixture-video-1", t2 + 200, { fileType: "video" }),
    f.imageEvent("fixture-ext-1", t2 + 300, { contentProvider: { type: "external" } }),
  ]);
  await f.settle();

  const filesIntake = (await f.allIntakes()).find(row => row.messageId === "msg-files")!;
  const filesSummary = await f.t.raw.withIdentity({ subject: f.staff }).query(api.line_capture_media.list, { intakeId: filesIntake._id });
  expect(filesSummary!.warnings.sort()).toEqual([
    "MEDIA_EXTERNAL_UNSUPPORTED",
    "UNSUPPORTED_FILE_PDF",
    "UNSUPPORTED_MEDIA_TYPE",
  ]);
  expect(await f.allBlobs()).toHaveLength(0);

  // Case 4: 3rd standalone image after 2 staged images blocks all 3 (no silent subsetting) and moves prior blobs to discarded.
  const t3 = t2 + 10 * 60_000;
  vi.setSystemTime(t3);
  await f.postWebhook([
    f.mentionEvent("msg-three", "@bot Three standalone images", t3),
    f.imageEvent("fixture-png-s1", t3 + 100),
    f.imageEvent("fixture-png-s2", t3 + 200),
  ]);
  await f.settle();

  const threeIntake = (await f.allIntakes()).find(row => row.messageId === "msg-three")!;
  expect((await f.t.raw.withIdentity({ subject: f.staff }).query(api.line_capture_media.list, { intakeId: threeIntake._id }))!.items.filter(i => i.url)).toHaveLength(2);

  await f.postWebhook([f.imageEvent("fixture-png-s3", t3 + 300)]);
  await f.settle();

  const afterThird = await f.t.raw.withIdentity({ subject: f.staff }).query(api.line_capture_media.list, { intakeId: threeIntake._id });
  expect(afterThird!.warnings).toContain("MEDIA_COUNT_LIMIT_EXCEEDED");
  expect(afterThird!.items.filter(i => i.url)).toEqual([]);
});

test("linked screenshots obey 24h expiry, unsend hides bytes immediately, and fixture-only cleanup handles failures safely", async () => {
  const f = await setupCaptureFixture();

  await f.postWebhook([
    f.mentionEvent("msg-life", "@bot Screen flicker", f.now),
    f.imageEvent("fixture-png-keep", f.now + 100),
    f.imageEvent("fixture-jpeg-unsend", f.now + 200),
  ]);
  await f.settle();

  const [intake] = await f.allIntakes();
  // Link the intake to a new Ticket.
  await f.t.raw.withIdentity({ subject: f.staff }).mutation(api.line_capture.finish, {
    intakeId: intake._id,
    expectedRevision: intake.revision,
    operation: { type: "create", title: "Screen flicker", description: "Captured from LINE" },
  });

  // Linked intake still shows private staged screenshots within 24h.
  const linkedSummary = await f.t.raw.withIdentity({ subject: f.staff }).query(api.line_capture_media.list, { intakeId: intake._id });
  expect(linkedSummary!.items).toHaveLength(2);
  const keepItem = linkedSummary!.items.find(i => i.messageId === "fixture-png-keep")!;
  const unsendItem = linkedSummary!.items.find(i => i.messageId === "fixture-jpeg-unsend")!;
  expect((await f.fetchMedia(f.staff, keepItem.url!)).status).toBe(200);
  expect((await f.fetchMedia(f.staff, unsendItem.url!)).status).toBe(200);

  // Unsend arrives AFTER fetch (recorded in Claude's lineCaptureUnsends): bytes hidden IMMEDIATELY before cleanup.
  await f.postWebhook([f.unsendEvent("fixture-jpeg-unsend", f.now + 500)]);
  const unsentResp = await f.fetchMedia(f.staff, unsendItem.url!);
  expect([unsentResp.status, (await unsentResp.json()).code]).toEqual([410, "MEDIA_WITHDRAWN"]);

  const afterUnsend = await f.t.raw.withIdentity({ subject: f.staff }).query(api.line_capture_media.list, { intakeId: intake._id });
  expect(afterUnsend!.items.map(i => i.messageId)).toEqual(["fixture-png-keep"]);

  // Store an UNOWNED blob directly in _storage to verify fixture cleanup NEVER touches it.
  const unownedBlobId = await f.t.run(async ctx => ctx.storage.store(new Blob(["unowned-blob"], { type: "text/plain" })));

  // Advance past 24h staging expiry: linked screenshot is IMMEDIATELY hidden even with cleanup off.
  vi.setSystemTime(f.now + LINE_CAPTURE_STAGING_TTL_MS + 1_000);
  const expiredResp = await f.fetchMedia(f.staff, keepItem.url!);
  expect([expiredResp.status, (await expiredResp.json()).code]).toEqual([410, "MEDIA_EXPIRED"]);
  const afterExpiry = await f.t.raw.withIdentity({ subject: f.staff }).query(api.line_capture_media.list, { intakeId: intake._id });
  expect(afterExpiry).toBeNull();

  // Expire sweep transitions rows without deleting blobs.
  const blobsBeforeExpire = (await f.allBlobs()).length;
  const expiredStats = await f.t.run(ctx => expireStagedMedia(ctx, { now: f.now + LINE_CAPTURE_STAGING_TTL_MS + 2_000 }));
  expect(expiredStats.expired).toBeGreaterThanOrEqual(1);
  expect((await f.allBlobs()).length).toBe(blobsBeforeExpire);

  // Retention hold blocks fixture cleanup.
  vi.stubEnv("TICKET_RETENTION_HOLD", "true");
  const heldResult = await f.t.run(ctx => reclaimFixtureMediaStorage(ctx, { now: f.now + LINE_CAPTURE_STAGING_TTL_MS + 3_000 }));
  expect(heldResult.deletedBlobs).toBe(0);

  // Release retention hold, but simulate failed storage.delete -> pending records stay intact with retry reclaimAfter!
  vi.stubEnv("TICKET_RETENTION_HOLD", "false");
  const failedReclaim = await f.t.run(async ctx => {
    const failingCtx = Object.assign(Object.create(ctx), {
      storage: {
        ...ctx.storage,
        delete: async () => { throw new Error("TRANSIENT_STORAGE_ERROR"); },
      },
    });
    return reclaimFixtureMediaStorage(failingCtx, { now: f.now + LINE_CAPTURE_STAGING_TTL_MS + 3_000 });
  });
  expect(failedReclaim).toEqual({ rows: 0, deletedBlobs: 0 });
  const stillPending = await f.allMedia();
  expect(stillPending.every(r => r.storageId !== undefined && (r.reclaimAfter ?? 0) > f.now + LINE_CAPTURE_STAGING_TTL_MS + 3_000)).toBe(true);
  expect((await f.allBlobs()).length).toBe(blobsBeforeExpire);

  // Once storage.delete recovers past backoff, fixture cleanup deletes ONLY owned fixture blobs and keeps unownedBlobId.
  const reclaimed = await f.t.run(ctx => reclaimFixtureMediaStorage(ctx, { now: f.now + LINE_CAPTURE_STAGING_TTL_MS + 120_000 }));
  expect(reclaimed.deletedBlobs).toBe(2);

  const remainingBlobs = await f.allBlobs();
  expect(remainingBlobs.map(b => b._id)).toEqual([unownedBlobId]);
});

test("pre-store reservation reconciles interrupted writes, rejects unverified storageIds, and fences late settlement", async () => {
  const f = await setupCaptureFixture();

  await f.postWebhook([f.mentionEvent("msg-res", "@bot Crash recovery test", f.now)]);
  const [intake] = await f.allIntakes();

  // Ingest without scheduling so we can drive claim -> reserve -> crash -> reconcile deterministically.
  const [ingested] = await f.t.run(ctx => ingestCaptureMediaEvents(ctx, {
    botId: f.botId,
    now: f.now,
    schedule: false,
    events: [{
      webhookEventId: "ev-reconcile-1",
      timestamp: f.now + 100,
      kind: "group",
      lineChatId: CHAT_LINE_ID,
      messageId: "fixture-png-crash",
      senderDigest: intake.senderDigest,
      fileType: "image",
      contentProvider: "line",
    }],
  }));

  const claim = await f.t.run(ctx => claimMediaForStaging(ctx, { mediaId: ingested.mediaId, now: f.now, scheduleRecovery: false }));
  expect(claim).toBeTruthy();

  const pngBytes = fixturePngBytes();
  const pngSha = await sha256Hex(pngBytes);
  const reservation = await f.t.run(ctx => reserveMediaWrite(ctx, {
    mediaId: ingested.mediaId,
    leaseId: claim!.leaseId,
    sha256: pngSha,
    size: pngBytes.byteLength,
    contentType: "image/png",
    now: f.now,
  }));
  expect(reservation.ok).toBe(true);
  if (!reservation.ok) throw new Error("expected reservation");

  // Simulate action storing blob with private marker, PLUS an unrelated real owned blob (e.g., from another feature), then crashing.
  const { storedId, otherOwnedId } = await f.t.run(async ctx => {
    const storedId = await ctx.storage.store(new Blob([pngBytes], { type: reservation.writeContentType }));
    const otherOwnedId = await ctx.storage.store(new Blob([pngBytes], { type: "image/png" }));
    return { storedId, otherOwnedId };
  });

  // Attempting to pass another real blob to recordStagedMedia with wrong OR matching marker fails ownership proof and leaves it untouched.
  const spoofedWrongMarker = await f.t.run(ctx => recordStagedMedia(ctx, {
    mediaId: ingested.mediaId,
    leaseId: claim!.leaseId,
    marker: "wrong-marker",
    sha256: pngSha,
    size: pngBytes.byteLength,
    contentType: "image/png",
    width: 16,
    height: 16,
    storageId: otherOwnedId,
    now: f.now,
  }));
  expect(spoofedWrongMarker.settled).toBe(false);

  const spoofedRightMarker = await f.t.run(ctx => recordStagedMedia(ctx, {
    mediaId: ingested.mediaId,
    leaseId: claim!.leaseId,
    marker: reservation.marker,
    sha256: pngSha,
    size: pngBytes.byteLength,
    contentType: "image/png",
    width: 16,
    height: 16,
    storageId: otherOwnedId,
    now: f.now,
  }));
  expect(spoofedRightMarker.settled).toBe(false);

  const afterSpoof = await f.t.run(ctx => ctx.db.get(ingested.mediaId));
  expect(afterSpoof!.storageId).toBeUndefined();
  expect(afterSpoof!.discarded).toEqual([]); // Unverified storageId was NOT added to discarded!
  expect(afterSpoof!.writes).toHaveLength(1); // Original write reservation still intact for reconciliation!

  // Reconciliation adopts the exact marked blob and leaves otherOwnedId untouched.
  const reconciled = await f.t.run(ctx => reconcileMediaWrites(ctx, ingested.mediaId, f.now + 10_000));
  expect(reconciled!.state).toBe("ready");
  expect(reconciled!.storageId).toBe(storedId);
  expect(reconciled!.writes).toEqual([]);

  // Now test late settlement after lease expiry: verified owned blob goes to discarded, never exposed.
  const [lateIngested] = await f.t.run(ctx => ingestCaptureMediaEvents(ctx, {
    botId: f.botId,
    now: f.now,
    schedule: false,
    events: [{
      webhookEventId: "ev-late-1",
      timestamp: f.now + 200,
      kind: "group",
      lineChatId: CHAT_LINE_ID,
      messageId: "fixture-jpeg-late",
      senderDigest: intake.senderDigest,
      fileType: "image",
      contentProvider: "line",
    }],
  }));
  const lateClaim = await f.t.run(ctx => claimMediaForStaging(ctx, { mediaId: lateIngested.mediaId, now: f.now, scheduleRecovery: false }));
  const jpegBytes = fixtureJpegBytes();
  const jpegSha = await sha256Hex(jpegBytes);
  const lateRes = await f.t.run(ctx => reserveMediaWrite(ctx, {
    mediaId: lateIngested.mediaId,
    leaseId: lateClaim!.leaseId,
    sha256: jpegSha,
    size: jpegBytes.byteLength,
    contentType: "image/jpeg",
    now: f.now,
  }));
  if (!lateRes.ok) throw new Error("expected reservation");
  const lateBlobId = await f.t.run(ctx => ctx.storage.store(new Blob([jpegBytes], { type: lateRes.writeContentType })));

  // Settle AFTER lease expired -> must NOT settle; verified blob recorded in discarded!
  const lateSettle = await f.t.run(ctx => recordStagedMedia(ctx, {
    mediaId: lateIngested.mediaId,
    leaseId: lateClaim!.leaseId,
    marker: lateRes.marker,
    sha256: jpegSha,
    size: jpegBytes.byteLength,
    contentType: "image/jpeg",
    width: 16,
    height: 16,
    storageId: lateBlobId,
    now: f.now + MEDIA_LEASE_MS + 5_000,
  }));
  expect(lateSettle.settled).toBe(false);
  const lateRow = await f.t.run(ctx => ctx.db.get(lateIngested.mediaId));
  expect(lateRow!.storageId).toBeUndefined();
  expect(lateRow!.discarded).toContain(lateBlobId);

  // Fixture cleanup removes the discarded late blob and NEVER deletes otherOwnedId or active storedId.
  const reclaimed = await f.t.run(ctx => reclaimFixtureMediaStorage(ctx, { now: f.now + MEDIA_LEASE_MS + 10_000 }));
  expect(reclaimed.deletedBlobs).toBe(1);
  const blobs = await f.allBlobs();
  expect(blobs.map(b => b._id).sort()).toEqual([storedId, otherOwnedId].sort());

  // Also test 8 MiB combined intake size budget blocking both items cleanly (no silent subset).
  const [sizeIngested] = await f.t.run(ctx => ingestCaptureMediaEvents(ctx, {
    botId: f.botId,
    now: f.now,
    schedule: false,
    events: [{
      webhookEventId: "ev-size-2",
      timestamp: f.now + 300,
      kind: "group",
      lineChatId: CHAT_LINE_ID,
      messageId: "fixture-png-size-2",
      senderDigest: intake.senderDigest,
      fileType: "image",
      contentProvider: "line",
    }],
  }));
  await f.t.run(ctx => withdrawMediaByMessage(ctx, { botId: f.botId, messageId: "fixture-jpeg-late", now: f.now }));
  const sizeClaim = await f.t.run(ctx => claimMediaForStaging(ctx, { mediaId: sizeIngested.mediaId, now: f.now, scheduleRecovery: false }));
  if (sizeClaim) {
    const overBudget = await f.t.run(ctx => reserveMediaWrite(ctx, {
      mediaId: sizeIngested.mediaId,
      leaseId: sizeClaim.leaseId,
      sha256: pngSha,
      size: LINE_CAPTURE_MAX_TOTAL_BYTES, // combined with pngBytes.byteLength > 8 MiB!
      contentType: "image/png",
      now: f.now,
    }));
    expect(overBudget).toEqual({ ok: false, code: "MEDIA_SIZE_LIMIT_EXCEEDED" });
    const afterBudget = await f.t.run(ctx => listIntakeMediaForStaff(ctx, { intakeId: intake._id, now: f.now }));
    expect(afterBudget!.warnings).toContain("MEDIA_SIZE_LIMIT_EXCEEDED");
    expect(afterBudget!.items.filter(item => item.url)).toEqual([]);
  }
});

test("bot leave and Project archive immediately hide staged media bytes", async () => {
  const f = await setupCaptureFixture();

  await f.postWebhook([
    f.mentionEvent("msg-arch", "@bot Printer offline", f.now),
    f.imageEvent("fixture-png-arch", f.now + 100),
  ]);
  await f.settle();

  const [intake] = await f.allIntakes();
  const summary = await f.t.raw.withIdentity({ subject: f.staff }).query(api.line_capture_media.list, { intakeId: intake._id });
  const url = summary!.items[0].url!;
  expect((await f.fetchMedia(f.staff, url)).status).toBe(200);

  // Bot leave hides bytes immediately.
  await f.t.run(ctx => ctx.db.patch(f.chatId, { state: "left", leftAt: f.now + 500 }));
  expect((await f.fetchMedia(f.staff, url)).status).toBe(404);
  expect(await f.t.raw.withIdentity({ subject: f.staff }).query(api.line_capture_media.list, { intakeId: intake._id })).toBeNull();

  // Restore chat, then archive Project -> bytes hidden immediately.
  await f.t.run(ctx => ctx.db.patch(f.chatId, { state: "active", leftAt: undefined }));
  expect((await f.fetchMedia(f.staff, url)).status).toBe(200);

  await f.t.run(ctx => ctx.db.patch(f.projectId, { archivedAt: f.now + 1_000 }));
  expect((await f.fetchMedia(f.staff, url)).status).toBe(404);
});
