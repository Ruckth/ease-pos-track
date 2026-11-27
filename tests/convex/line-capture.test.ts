import { createHmac } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { fixtures, identityTest } from "./identity-harness";
import { modules } from "./modules";

const fake = vi.hoisted(() => ({
  info: vi.fn(), setWebhook: vi.fn(), testWebhook: vi.fn(), webhookSettings: vi.fn(), groupSummary: vi.fn(),
  count: vi.fn(), profile: vi.fn(), leave: vi.fn(), reply: vi.fn(), media: vi.fn(),
}));
vi.mock("../../convex/adapters/line", () => ({ createLine: () => fake, localLineFixtureToken: "fixture" }));
vi.mock("../../convex/line_capture_media_domain", async importOriginal => ({
  ...await importOriginal<typeof import("../../convex/line_capture_media_domain")>(), ingestCaptureMediaEvents: fake.media,
}));

const capture = api.line_capture;
const captureInternal = internal.line_capture;

const now = 1_795_656_000_000;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3210");
  vi.stubEnv("LOCAL_FIXTURES_ENABLED", "true");
  vi.stubEnv("LINE_SECRETS_KEY", Buffer.alloc(32, 3).toString("base64"));
  vi.stubEnv("CONVEX_SITE_URL", "https://fixture.convex.site");
  vi.stubEnv("LINE_CAPTURE_ENABLED", "true");
  fake.info.mockResolvedValue({ userId: "Ufixture-POS", basicId: "@bot", displayName: "Bot" });
  fake.setWebhook.mockResolvedValue({});
  fake.webhookSettings.mockResolvedValue(undefined);
  fake.testWebhook.mockResolvedValue({ success: true, statusCode: 200 });
  fake.groupSummary.mockResolvedValue({ groupName: "Fixture group" });
  fake.count.mockResolvedValue({ count: 3 });
  fake.profile.mockResolvedValue({ displayName: "Store" });
  fake.reply.mockResolvedValue({});
  fake.leave.mockResolvedValue({});
  fake.media.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

const group = "Cfixture";
const mention = (id: string, text: string, options: { at?: number; user?: string; event?: string } = {}) => ({
  type: "message", mode: "active", webhookEventId: options.event ?? `evt-${id}`, timestamp: options.at ?? now + 100,
  source: { type: "group", groupId: group, userId: options.user ?? "Ualice" },
  message: { id, type: "text", text: `@Bot ${text}`, mention: { mentionees: [{ index: 0, length: 4, type: "user", isSelf: true }] } },
});
const edit = (id: string, text: string, at: number, options: { mentioned?: boolean; user?: string; event?: string } = {}) => ({
  type: "messageEdited", mode: "active", webhookEventId: options.event ?? `edit-${id}-${at}-${text}`, timestamp: at,
  source: { type: "group", groupId: group, userId: options.user ?? "Ualice" },
  message: {
    id, type: "text", text: options.mentioned === false ? text : `@Bot ${text}`,
    ...(options.mentioned === false ? {} : { mention: { mentionees: [{ index: 0, length: 4, type: "user", isSelf: true }] } }),
  },
});
const unsend = (id: string, at: number) => ({
  type: "unsend", mode: "active", webhookEventId: `unsend-${id}`, timestamp: at,
  source: { type: "group", groupId: group, userId: "Ualice" }, unsend: { messageId: id },
});
const image = (id: string, at: number, set?: { id: string; index: number; total: number }) => ({
  type: "message", mode: "active", webhookEventId: `img-${id}`, timestamp: at,
  source: { type: "group", groupId: group, userId: "Ualice" },
  message: { id, type: "image", contentProvider: { type: "line" }, ...(set ? { imageSet: set } : {}) },
});

async function setup() {
  const t = identityTest(modules);
  const owner = await t.mutation(fixtures.staff, { email: "owner@fixture.test", role: "owner" });
  const token = owner.session;
  const projectId = await t.run(({ db }) => db.insert("projects", { key: "POS", name: "POS", createdAt: now, updatedAt: now }));
  const otherProjectId = await t.run(({ db }) => db.insert("projects", { key: "OTH", name: "Other", createdAt: now, updatedAt: now }));
  const channelSecret = "channel-secret";
  const { botId } = await t.action(api.line.addBot, {
    projectId, name: "Bot", channelSecret, accessToken: "access-token", locale: "en", token,
  });

  async function send(events: unknown[]) {
    const bot = (await t.run(({ db }) => db.get(botId)))!;
    const body = JSON.stringify({ destination: bot.lineUserId, events });
    return t.fetch(`/line/webhook/${bot.webhookSlug}`, {
      method: "POST", body, headers: { "x-line-signature": createHmac("sha256", channelSecret).update(body).digest("base64") },
    });
  }
  async function settle() {
    await vi.advanceTimersByTimeAsync(1);
    await t.finishInProgressScheduledFunctions();
  }

  expect((await send([{ type: "join", timestamp: now, webhookEventId: "join", replyToken: "r", source: { type: "group", groupId: group } }])).status).toBe(200);
  await settle();
  const chat = (await t.run(({ db }) => db.query("lineChats").withIndex("by_bot_chat", q => q.eq("botId", botId).eq("lineChatId", group)).unique()))!;
  await t.mutation(api.line.updateChat, { token, chatId: chat._id, approve: true, joinedAt: chat.joinedAt, notify: "own", allowCreate: true });

  async function enable() {
    await t.mutation(capture.setProjectCapture, { token, projectId, enabled: true });
    await t.mutation(capture.setChatCapture, { token, chatId: chat._id, joinedAt: chat.joinedAt, enabled: true });
  }
  const intakes = () => t.run(({ db }) => db.query("lineCaptureIntakes").collect());
  const list = (view: "open" | "done" = "open") =>
    t.query(capture.list, { token, projectId, view, paginationOpts: { numItems: 20, cursor: null } });
  async function ticket(project: Id<"projects">, key: string, number: number) {
    return t.run(({ db }) => db.insert("tickets", {
      projectId: project, projectKey: key, title: `Existing ${number}`, description: "d", searchText: "Existing",
      status: "new", ticketNumber: number, media: [], annotations: [], version: 3, lifecycle: "active",
      origin: "staff", createdAt: now, updatedAt: now,
    }));
  }
  return { t, token, projectId, otherProjectId, botId, chat, send, settle, enable, intakes, list, ticket };
}

test("capture stays closed without the env flag, a fixture bot or both opt-ins", async () => {
  const f = await setup();
  await f.send([mention("m0", "before opt-in")]);
  expect(await f.intakes()).toEqual([]);

  vi.stubEnv("LINE_CAPTURE_ENABLED", "false");
  await expect(f.t.mutation(capture.setProjectCapture, { token: f.token, projectId: f.projectId, enabled: true }))
    .rejects.toThrow(/LINE_CAPTURE_DISABLED/);
  vi.stubEnv("LINE_CAPTURE_ENABLED", "true");
  vi.stubEnv("LOCAL_FIXTURES_ENABLED", "false");
  await expect(f.t.mutation(capture.setProjectCapture, { token: f.token, projectId: f.projectId, enabled: true }))
    .rejects.toThrow(/LINE_CAPTURE_DISABLED/);
  vi.stubEnv("LOCAL_FIXTURES_ENABLED", "true");

  await f.enable();
  // One approved Project only.
  await expect(f.t.mutation(capture.setProjectCapture, { token: f.token, projectId: f.otherProjectId, enabled: true }))
    .rejects.toThrow(/LINE_CAPTURE_PROJECT_LIMIT/);

  await f.t.run(({ db }) => db.patch(f.botId, { lineUserId: "Ureal" }));
  vi.stubEnv("LINE_CAPTURE_ENABLED", "true");
  // The webhook matches destination to lineUserId, so a non-fixture bot is still verified but never captured.
  await f.send([mention("m1", "real bot")]);
  expect(await f.intakes()).toEqual([]);
  await f.t.run(({ db }) => db.patch(f.botId, { lineUserId: "Ufixture-POS" }));

  vi.stubEnv("LINE_CAPTURE_ENABLED", "");
  await f.send([mention("m2", "flag off")]);
  expect(await f.intakes()).toEqual([]);
});

test("a signed mention is captured once without a model key and images go to the media module", async () => {
  const f = await setup();
  await f.enable();
  const images = [image("i1", now + 50, { id: "set", index: 1, total: 2 }), image("i2", now + 150, { id: "set", index: 2, total: 2 })];
  expect((await f.send([images[0], mention("m1", "printer is down"), images[1]])).status).toBe(200);
  expect((await f.send([mention("m1", "printer is down")])).status).toBe(200);
  expect((await f.send([mention("m1", "printer is down", { event: "evt-redelivered-other-id" })])).status).toBe(200);
  const rows = await f.intakes();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ text: "printer is down", state: "captured", revision: 1, projectId: f.projectId });
  expect(await f.t.run(({ db }) => db.query("lineAiIntakes").collect())).toEqual([]);

  expect(fake.media).toHaveBeenCalledTimes(1);
  const [, { botId, events }] = fake.media.mock.calls[0];
  expect(botId).toBe(f.botId);
  expect(events.map((e: { messageId: string }) => e.messageId)).toEqual(["i1", "i2"]);
  expect(events[0]).toMatchObject({ fileType: "image", contentProvider: "line", imageSet: { id: "set", index: 1, total: 2 }, kind: "group" });
  expect(events[0].senderDigest).toBe(rows[0].senderDigest);
  expect(JSON.stringify(events)).not.toContain("Ualice");

  const page = await f.list();
  expect(page.page).toMatchObject([{ _id: rows[0]._id, state: "captured", text: "printer is down", canCreate: true, receipts: [] }]);
});

test("edits advance by timestamp, conflict at equal time, withdraw on mention removal and ignore other senders", async () => {
  const f = await setup();
  await f.enable();
  await f.send([mention("m1", "first", { at: now + 100 })]);
  await f.send([edit("m1", "second", now + 300)]);
  await f.send([edit("m1", "stale", now + 200)]);
  await f.send([edit("m1", "intruder", now + 400, { user: "Umallory" })]);
  let [row] = await f.intakes();
  expect(row).toMatchObject({ text: "second", revision: 2, state: "captured" });

  await f.send([edit("m1", "same time other", now + 300)]);
  [row] = await f.intakes();
  expect(row).toMatchObject({ state: "review", conflict: true, revision: 3 });

  await f.send([edit("m1", "no bot", now + 500, { mentioned: false })]);
  [row] = await f.intakes();
  expect(row).toMatchObject({ state: "withdrawn", bucket: "done", text: "" });
  await f.send([edit("m1", "back", now + 600)]);
  expect((await f.intakes())[0].state).toBe("withdrawn");
});

test("an early edit is held and reconciled only when its original is admitted", async () => {
  const f = await setup();
  await f.enable();
  await f.send([edit("m1", "edited first", now + 200)]);
  expect(await f.intakes()).toEqual([]);
  await f.send([mention("m1", "original", { at: now + 100 })]);
  const [row] = await f.intakes();
  expect(row).toMatchObject({ text: "edited first", revision: 2 });
  expect(await f.t.run(({ db }) => db.query("lineCaptureEdits").collect())).toEqual([]);
});

test("unsend always wins against late originals and late edits", async () => {
  const f = await setup();
  await f.enable();
  await f.send([unsend("m1", now + 200)]);
  await f.send([mention("m1", "late original")]);
  expect(await f.intakes()).toEqual([]);

  await f.send([mention("m2", "kept", { at: now + 100 })]);
  await f.send([unsend("m2", now + 300)]);
  await f.send([edit("m2", "late edit", now + 250)]);
  const [row] = await f.intakes();
  expect(row).toMatchObject({ state: "withdrawn", text: "", unsentAt: now + 300 });
  expect(await f.t.run(({ db }) => db.query("lineCaptureUnsends").collect())).toHaveLength(2);

  // Fences survive capture being switched off.
  vi.stubEnv("LINE_CAPTURE_ENABLED", "false");
  await f.send([unsend("m9", now + 400)]);
  expect(await f.t.run(({ db }) => db.query("lineCaptureUnsends").collect())).toHaveLength(3);
});

test("staff create once, replay returns the same receipt and a different payload conflicts", async () => {
  const f = await setup();
  await f.enable();
  await f.send([mention("m1", "printer down")]);
  const [row] = await f.intakes();
  const op = { type: "create", title: "Printer down", description: "From LINE" } as const;
  const args = { token: f.token, intakeId: row._id, expectedRevision: 1, operation: op };
  const first = await f.t.mutation(capture.finish, args);
  expect(first).toMatchObject({ operation: "create", number: "POS-0001" });
  expect(await f.t.mutation(capture.finish, args)).toEqual(first);
  await expect(f.t.mutation(capture.finish, { ...args, operation: { ...op, title: "Other" } })).rejects.toThrow(/LINE_CAPTURE_CONFLICT/);
  const tickets = await f.t.run(({ db }) => db.query("tickets").collect());
  expect(tickets).toHaveLength(1);
  expect(tickets[0]).toMatchObject({ createdVia: "line", origin: "staff", projectId: f.projectId });

  // A separate candidate has its own identity; dismissing a linked intake is refused.
  await f.t.mutation(capture.finish, { ...args, candidateKey: "second", operation: { ...op, title: "Second issue" } });
  expect(await f.t.run(({ db }) => db.query("tickets").collect())).toHaveLength(2);
  await expect(f.t.mutation(capture.finish, { ...args, candidateKey: "third", operation: { type: "dismiss" } }))
    .rejects.toThrow(/LINE_CAPTURE_ALREADY_LINKED/);

  // An edit after linkage stages a correction for staff.
  await f.send([edit("m1", "printer and scanner down", now + 200)]);
  const done = await f.list("done");
  expect(done.page[0]).toMatchObject({ state: "linked", correction: { text: "printer and scanner down" }, revision: 2 });
  expect(done.page[0].receipts).toHaveLength(2);
  await f.t.mutation(capture.acknowledgeCorrection, { token: f.token, intakeId: row._id, expectedRevision: 2 });
  expect((await f.list("done")).page[0].correction).toBeNull();

  // Post-link unsend hides LINE content and keeps the Ticket reference.
  await f.send([unsend("m1", now + 300)]);
  expect((await f.list("done")).page[0]).toMatchObject({ state: "linked", text: "", unsent: true });
  expect(await f.t.run(({ db }) => db.query("tickets").collect())).toHaveLength(2);
});

test("link guards Project, Ticket version and intake revision; dismiss finishes without a key", async () => {
  const f = await setup();
  await f.enable();
  await f.send([mention("m1", "one"), mention("m2", "two", { at: now + 200 })]);
  const rows = await f.intakes();
  const m1 = rows.find(r => r.messageId === "m1")!;
  const m2 = rows.find(r => r.messageId === "m2")!;
  const foreign = await f.ticket(f.otherProjectId, "OTH", 1);
  const local = await f.ticket(f.projectId, "POS", 7);
  const base = { token: f.token, intakeId: m1._id, expectedRevision: 1 };
  await expect(f.t.mutation(capture.finish, { ...base, operation: { type: "link", ticketId: foreign, expectedTicketVersion: 3 } }))
    .rejects.toThrow(/LINE_CAPTURE_TICKET_UNAVAILABLE/);
  await expect(f.t.mutation(capture.finish, { ...base, operation: { type: "link", ticketId: local, expectedTicketVersion: 2 } }))
    .rejects.toThrow(/LINE_CAPTURE_TICKET_CHANGED/);
  await expect(f.t.mutation(capture.finish, { ...base, expectedRevision: 9, operation: { type: "link", ticketId: local, expectedTicketVersion: 3 } }))
    .rejects.toThrow(/LINE_CAPTURE_REVISION_CHANGED/);
  expect(await f.t.mutation(capture.finish, { ...base, operation: { type: "link", ticketId: local, expectedTicketVersion: 3 } }))
    .toMatchObject({ operation: "link", ticketId: local, number: "POS-0007" });

  await f.t.mutation(capture.finish, { token: f.token, intakeId: m2._id, expectedRevision: 1, operation: { type: "dismiss" } });
  const dismissed = await f.t.run(({ db }) => db.get(m2._id));
  expect(dismissed).toMatchObject({ state: "dismissed", text: "" });
  expect((await f.list("open")).page).toEqual([]);
});

test("bot leave fails open intake, and an archived Project refuses staff reads", async () => {
  const f = await setup();
  await f.enable();
  await f.send([mention("m1", "help")]);
  const [row] = await f.intakes();
  await f.send([{ type: "leave", timestamp: now + 500, webhookEventId: "leave", source: { type: "group", groupId: group } }]);
  await f.settle();
  expect((await f.list()).page[0]).toMatchObject({ state: "failed", warning: "LINE_CAPTURE_CHAT_UNAVAILABLE", canCreate: false });
  await expect(f.t.mutation(capture.finish, {
    token: f.token, intakeId: row._id, expectedRevision: 1, operation: { type: "create", title: "t", description: "d" },
  })).rejects.toThrow(/LINE_CAPTURE_UNAVAILABLE/);

  await f.t.mutation(internal.projects.setArchived, { projectId: f.projectId, archived: true });
  await expect(f.list()).rejects.toThrow(/PROJECT_NOT_FOUND/);
});

test("expired media window and intake expiry", async () => {
  const f = await setup();
  await f.enable();
  await f.send([mention("m1", "help")]);
  vi.setSystemTime(now + 25 * 60 * 60_000);
  expect((await f.list()).page[0]).toMatchObject({ state: "failed", warning: "LINE_CAPTURE_EXPIRED" });
  expect(await f.t.mutation(captureInternal.cleanup, {})).toMatchObject({ intakes: 1 });
  expect(await f.intakes()).toEqual([]);
});

test("capture is the single writer: open AI review work blocks the switch and leased AI work is fenced", async () => {
  const f = await setup();
  const intakeFields = {
    projectId: f.projectId, botId: f.botId, chatId: f.chat._id, joinedAt: f.chat.joinedAt, chatRevision: 0, botRevision: 0,
    connectionRevision: 0, projectVisibilityVersion: 0, kind: "group" as const, webhookEventId: "ai", messageId: "ai",
    senderDigest: "x", text: "t", files: [], messageTimestamp: now, windowEndsAt: now, expiresAt: now + 60_000,
    availableAt: now, attempt: 1, createdAt: now, updatedAt: now,
  };
  const aiIntake = await f.t.run(({ db }) => db.insert("lineAiIntakes", { ...intakeFields, state: "draft" }));
  const draft = await f.t.run(({ db }) => db.insert("lineAiDrafts", {
    intakeId: aiIntake, projectId: f.projectId, state: "review", connectionRevision: 0, createdAt: now, expiresAt: now + 60_000,
    suggestion: { intent: "clarify", title: null, description: null, ticketNumber: null, reply: null, evidence: [] },
  }));
  await expect(f.t.mutation(capture.setProjectCapture, { token: f.token, projectId: f.projectId, enabled: true }))
    .rejects.toThrow(/LINE_CAPTURE_AI_WORK_OPEN/);
  await f.t.run(({ db }) => db.patch(draft, { state: "dismissed" }));
  // A leased write must settle even when its review is already dismissed.
  await f.t.run(({ db }) => db.patch(aiIntake, { state: "processing", leaseExpiresAt: now + 60_000 }));
  await expect(f.enable()).rejects.toThrow(/LINE_CAPTURE_AI_WORK_OPEN/);
  await f.t.run(({ db }) => db.patch(aiIntake, { state: "ignored" }));
  await f.enable();
  const enrollment = await f.t.run(async ctx => {
    const { assistantEnrollment } = await import("../../convex/domain/line_ai_review");
    return assistantEnrollment(ctx, intakeFields);
  });
  expect(enrollment).toBeNull();
  await expect(f.t.mutation(api.line.setAssistantEnabled, { token: f.token, chatId: f.chat._id, joinedAt: f.chat.joinedAt, enabled: true }))
    .rejects.toThrow(/LINE_AI_CONNECTION_REQUIRED|LINE_CAPTURE_ACTIVE/);
});

test("expiry cannot starve behind linked rows: content is redacted, then rows and receipts are purged", async () => {
  const f = await setup();
  await f.enable();
  const events = Array.from({ length: 5 }, (_, i) => mention(`m${i}`, `issue ${i}`, { at: now + 100 + i }));
  await f.send(events);
  const rows = (await f.intakes()).sort((a, b) => a.messageTimestamp - b.messageTimestamp);
  for (const row of rows.slice(0, 3)) {
    await f.t.mutation(capture.finish, {
      token: f.token, intakeId: row._id, expectedRevision: 1, operation: { type: "create", title: row.text, description: "d" },
    });
  }
  vi.setSystemTime(now + 25 * 60 * 60_000);
  // A limit smaller than the linked prefix still makes progress on every pass.
  await f.t.mutation(captureInternal.cleanup, { limit: 2 });
  await f.t.mutation(captureInternal.cleanup, { limit: 2 });
  await f.t.mutation(captureInternal.cleanup, { limit: 2 });
  const left = await f.intakes();
  expect(left).toHaveLength(3);
  for (const row of left) expect(row).toMatchObject({ text: "", senderDigest: "", redactedAt: now + 25 * 60 * 60_000 });
  expect((await f.list("done")).page.every((row: { text: string; chatName: string }) => row.text === "" && row.chatName === "")).toBe(true);

  vi.setSystemTime(now + 60 * 24 * 60 * 60_000);
  await f.t.mutation(captureInternal.cleanup, { limit: 2 });
  await f.t.mutation(captureInternal.cleanup, { limit: 2 });
  expect(await f.intakes()).toEqual([]);
  expect(await f.t.run(({ db }) => db.query("lineCaptureReceipts").collect())).toEqual([]);
  expect(await f.t.run(({ db }) => db.query("tickets").collect())).toHaveLength(3);
});

test("lost enrollment redacts text and corrections in staff reads, linked included", async () => {
  const f = await setup();
  await f.enable();
  await f.send([mention("m1", "secret detail")]);
  const [row] = await f.intakes();
  await f.t.mutation(capture.finish, {
    token: f.token, intakeId: row._id, expectedRevision: 1, operation: { type: "create", title: "t", description: "d" },
  });
  await f.send([edit("m1", "secret correction", now + 200)]);
  expect((await f.list("done")).page[0]).toMatchObject({ text: "secret detail", correction: { text: "secret correction" } });
  await f.t.mutation(capture.setChatCapture, { token: f.token, chatId: f.chat._id, joinedAt: f.chat.joinedAt, enabled: false });
  const [view] = (await f.list("done")).page;
  expect(view).toMatchObject({ state: "linked", text: "", chatName: "", correction: null });
  expect(JSON.stringify(view)).not.toContain("secret");
});

test("chats that never opted in keep legacy behavior, unsends included", async () => {
  const f = await setup();
  await f.send([unsend("m1", now + 100), mention("m2", "hello")]);
  vi.stubEnv("LINE_CAPTURE_ENABLED", "false");
  await f.send([unsend("m3", now + 200)]);
  const rows = await f.t.run(async ({ db }) => ({
    intakes: await db.query("lineCaptureIntakes").collect(),
    events: await db.query("lineCaptureEvents").collect(),
    unsends: await db.query("lineCaptureUnsends").collect(),
    edits: await db.query("lineCaptureEdits").collect(),
  }));
  expect(rows).toEqual({ intakes: [], events: [], unsends: [], edits: [] });
  expect(fake.media).not.toHaveBeenCalled();
});

test("a malformed imageSet is flagged for the media module instead of dropped", async () => {
  const f = await setup();
  await f.enable();
  await f.send([
    { ...image("i1", now + 50), message: { id: "i1", type: "image", contentProvider: { type: "line" }, imageSet: { id: "s", index: 3, total: 2 } } },
    { ...image("i2", now + 60), message: { id: "i2", type: "image", contentProvider: { type: "line" }, imageSet: "bad" } },
    image("i3", now + 70),
  ]);
  const [, { events }] = fake.media.mock.calls[0];
  expect(events.map((e: { imageSetInvalid?: boolean; imageSet?: unknown }) => [e.imageSetInvalid ?? false, e.imageSet ?? null]))
    .toEqual([[true, null], [true, null], [false, null]]);
});

test("opting the same group back in cannot revive earlier text or staff write authority", async () => {
  const f = await setup();
  await f.enable();
  await f.send([mention("original", "earlier enrollment", { at: now + 20 })]);
  const [original] = await f.intakes();
  const args = { token: f.token, chatId: f.chat._id, joinedAt: f.chat.joinedAt };
  await f.t.mutation(capture.setChatCapture, { ...args, enabled: false });
  await f.t.mutation(capture.setChatCapture, { ...args, enabled: true });
  const rows = await f.t.query(capture.list, {
    token: f.token, projectId: f.projectId, view: "open", paginationOpts: { numItems: 10, cursor: null },
  });
  expect(rows.page[0]).toMatchObject({ text: "", canCreate: false, state: "failed" });
  await expect(f.t.mutation(capture.finish, { token: f.token, intakeId: original._id, expectedRevision: 1,
    operation: { type: "create", title: "stale", description: "" } })).rejects.toThrow("LINE_CAPTURE_UNAVAILABLE");
});
