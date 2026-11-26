import { createHmac } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import { syntheticLineAiInput } from "../../convex/adapters/line_ai_provider";
import { LINE_AI_FILE_WINDOW_MS } from "../../convex/domain/line_ai_intake";
import { sealLineSecret } from "../../convex/line_crypto";
import { fixtures, identityTest } from "./identity-harness";
import { modules } from "./modules";

const fake = vi.hoisted(() => ({ scan: vi.fn(), push: vi.fn(), getContent: vi.fn() }));
vi.mock("../../convex/adapters/line_ai_provider", async original => ({
  ...await original<typeof import("../../convex/adapters/line_ai_provider")>(), scanLineRequest: fake.scan,
}));
vi.mock("../../convex/adapters/line", async original => ({
  ...await original<typeof import("../../convex/adapters/line")>(), createLine: () => fake,
}));

const now = 1_795_656_000_000;
const secret = "synthetic-line-channel-secret";
const suggestion = {
  intent: "create", title: "Printer offline", description: "The printer showed an error.",
  ticketNumber: null, reply: null, evidence: ["The video terminal indicates printer offline."],
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3210");
  vi.stubEnv("LINE_SECRETS_KEY", Buffer.alloc(32, 1).toString("base64"));
  vi.stubEnv("LINE_AI_ENABLED", "true");
  fake.scan.mockResolvedValue(suggestion);
  fake.push.mockResolvedValue("accepted");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

async function fixture() {
  const t = identityTest(modules);
  const owner = await t.mutation(fixtures.staff, { email: "owner@fixture.test", role: "owner" });
  const worker = await t.mutation(fixtures.staff, { email: "worker@fixture.test", role: "staff" });
  const token = worker.session;
  const [secretCipher, tokenCipher] = await Promise.all([sealLineSecret(secret), sealLineSecret("synthetic-line-access-token")]);
  const { projectId, botId, chatId } = await t.run(async ({ db }) => {
    const projectId = await db.insert("projects", { key: "POS", name: "POS Support", createdAt: now, updatedAt: now });
    const botId = await db.insert("lineBots", {
      projectId, name: "POS Help", lineUserId: "Ubot", basicId: "@pos", displayName: "POS Help",
      locale: "en", state: "active", webhookSlug: "fixture", signatureFailures: 0, secretCipher, tokenCipher,
      secretHint: "cret", tokenHint: "oken", allowDirectChats: false, createdAt: now, updatedAt: now,
    });
    const chatId = await db.insert("lineChats", {
      projectId, botId, kind: "group", lineChatId: "Cgroup", name: "POS Support", state: "active",
      notify: "off", allowCreate: true, joinedAt: now - 1_000, lastEventAt: now - 1_000,
    });
    return { projectId, botId, chatId };
  });
  await t.action(api.line_ai_settings.testAndSave, { projectId, token: owner.session, provider: "gemini", apiKey: "synthetic-model-key" });
  fake.scan.mockClear();
  await t.mutation(api.line.setAssistantEnabled, { chatId, token, joinedAt: now - 1_000, enabled: true });
  await vi.advanceTimersByTimeAsync(2);
  const send = (events: unknown[]) => {
    const body = JSON.stringify({ destination: "Ubot", events });
    return t.fetch("/line/webhook/fixture", {
      method: "POST", body, headers: { "x-line-signature": createHmac("sha256", secret).update(body).digest("base64") },
    });
  };
  const message = (id: string, text: string, groupId = "Cgroup") => ({
    type: "message", timestamp: Date.now(), webhookEventId: "event-" + id,
    source: { type: "group", groupId, userId: "Usender" },
    message: { id, type: "text", text, mention: { mentionees: [{ type: "user", index: 0, length: 9, userId: "Ubot", isSelf: true }] } },
  });
  const runJobs = async (delay = 5) => {
    await vi.advanceTimersByTimeAsync(delay);
    await t.finishInProgressScheduledFunctions();
  };
  const page = (numItems = 25, cursor: string | null = null) => t.query(api.line_ai_reviews.list, {
    projectId, token, paginationOpts: { numItems, cursor },
  });
  const review = async () => ({
    drafts: (await page()).page.filter(item => item.state === "review"),
    replies: await t.query(api.line_ai_reviews.listReplies, { projectId, token }),
  });
  const tickets = () => t.run(({ db }) => db.query("tickets").collect());
  return { t, owner, token, projectId, botId, chatId, send, message, runJobs, page, review, tickets };
}

test("a signed request is scanned once and staff create and close one linked Ticket", async () => {
  const f = await fixture();
  const item = f.message("msg-1", "@POS Help Printer offline");
  expect((await f.send([item, item])).status).toBe(200);
  expect(await f.t.run(({ db }) => db.query("lineAiIntakes").collect())).toHaveLength(1);
  await f.runJobs(LINE_AI_FILE_WINDOW_MS + 1);
  expect(fake.scan).toHaveBeenCalledOnce();
  expect(await f.tickets()).toHaveLength(0);
  expect(fake.push).not.toHaveBeenCalled();
  const [draft] = (await f.review()).drafts;
  expect(draft.suggestion).toMatchObject({ intent: "create", title: "Printer offline" });
  fake.push.mockResolvedValueOnce("unknown");
  const args = {
    token: f.token, draftId: draft._id,
    decision: { type: "create" as const, title: "Printer offline", description: "Register 2", reply: draft.replies.create },
  };
  const created = await f.t.mutation(api.line_ai_reviews.approve, args);
  expect(await f.t.mutation(api.line_ai_reviews.approve, args)).toMatchObject({ _id: created._id });
  await expect(f.t.mutation(api.line_ai_reviews.approve, {
    ...args, decision: { type: "clarify", reply: "Can you send more details?" },
  })).rejects.toThrow("LINE_AI_APPROVAL_CONFLICT");
  await expect(f.t.mutation(api.line_ai_reviews.approve, {
    ...args, decision: { ...args.decision, title: "Conflicting edit" },
  })).rejects.toThrow("LINE_AI_APPROVAL_CONFLICT");
  await f.runJobs();
  expect(await f.tickets()).toMatchObject([{ ticketNumber: 1, createdVia: "line", status: "new" }]);
  expect((await f.review()).replies[0]).toMatchObject({ state: "unknown", canRetry: true });
  await f.t.mutation(api.line_ai_reviews.retryReply, { token: f.token, replyId: created._id });
  await f.runJobs();
  expect(fake.push).toHaveBeenCalledTimes(2);
  expect(fake.push.mock.calls[1]).toEqual(fake.push.mock.calls[0]);
  expect(fake.push.mock.calls[0]).toEqual(["Cgroup", "We opened Ticket POS-0001. Our team will follow up here.", expect.any(String)]);
  expect((await f.review()).replies[0]).toMatchObject({ state: "accepted", canRetry: false });

  fake.scan.mockResolvedValueOnce({ ...suggestion, intent: "close", title: null, description: null, ticketNumber: "POS-0001" });
  expect((await f.send([f.message("msg-2", "@POS Help POS-0001 is fixed")])).status).toBe(200);
  await f.runJobs(LINE_AI_FILE_WINDOW_MS + 1);
  const [closure] = (await f.review()).drafts;
  expect(closure.target).toMatchObject({ number: "POS-0001", version: 0 });
  await expect(f.t.mutation(api.line_ai_reviews.approve, {
    token: f.token, draftId: closure._id, decision: { type: "close", ticketVersion: 1, reply: closure.replies.close },
  })).rejects.toThrow("VERSION_CONFLICT");
  await f.t.mutation(api.line_ai_reviews.approve, {
    token: f.token, draftId: closure._id, decision: { type: "close", ticketVersion: 0, reply: closure.replies.close },
  });
  await f.runJobs();
  expect(await f.tickets()).toMatchObject([{ status: "done", version: 1 }]);
  expect(fake.push.mock.calls[2]?.[0]).toBe("Cgroup");
});

test("a stale enrollment suppresses its queued reply and the Ticket stays committed", async () => {
  const f = await fixture();
  await f.send([f.message("msg-1", "@POS Help Printer offline")]);
  await f.runJobs(LINE_AI_FILE_WINDOW_MS + 1);
  const [draft] = (await f.review()).drafts;
  const created = await f.t.mutation(api.line_ai_reviews.approve, {
    token: f.token, draftId: draft._id,
    decision: { type: "create", title: "Printer offline", description: "Register 2", reply: draft.replies.create },
  });
  for (const enabled of [false, true]) {
    await f.t.mutation(api.line.setAssistantEnabled, { chatId: f.chatId, token: f.token, joinedAt: now - 1_000, enabled });
  }
  await f.t.action(internal.line_ai_delivery.send, { replyId: created._id });
  expect(fake.push).not.toHaveBeenCalled();
  expect(await f.tickets()).toHaveLength(1);
  expect((await f.review()).replies[0]).toMatchObject({ state: "suppressed", canRetry: false });
});

test("review paging reaches an actionable suggestion behind an unavailable one", async () => {
  const f = await fixture();
  await f.send([f.message("valid", "@POS Help Printer offline")]);
  await f.runJobs(LINE_AI_FILE_WINDOW_MS + 1);
  const [valid] = (await f.review()).drafts;
  await f.t.run(async ({ db }) => {
    const { _id, _creationTime, ...row } = (await db.get(valid._id))!;
    await db.insert("lineAiDrafts", { ...row, authorizationRevision: 99, expiresAt: row.expiresAt + 1 });
  });
  const first = await f.page(1);
  expect(first.page).toEqual([{ _id: expect.any(String), state: "unavailable" }]);
  expect(first.isDone).toBe(false);
  const next = await f.page(1, first.continueCursor);
  expect(next.page).toMatchObject([{ _id: valid._id, state: "review" }]);
});

test("rotating the model key preserves an approved reply and its retry after a LINE rate limit", async () => {
  const f = await fixture();
  await f.send([f.message("rotate", "@POS Help Printer offline")]);
  await f.runJobs(LINE_AI_FILE_WINDOW_MS + 1);
  const [draft] = (await f.review()).drafts;
  const rotate = (apiKey: string) => f.t.action(api.line_ai_settings.testAndSave, {
    token: f.owner.session, projectId: f.projectId, provider: "gemini", apiKey,
  });
  await rotate("rotated-fixture-key-one");
  const receipt = await f.t.mutation(api.line_ai_reviews.approve, {
    token: f.token, draftId: draft._id, decision: { type: "clarify", reply: "Which register?" },
  });
  await rotate("rotated-fixture-key-two");
  fake.push.mockResolvedValueOnce("limited");
  await f.runJobs();
  expect((await f.review()).replies).toMatchObject([{ state: "limited", canRetry: true }]);
  await f.t.mutation(api.line_ai_reviews.retryReply, { token: f.token, replyId: receipt._id });
  await f.runJobs();
  expect(fake.push.mock.calls[1]).toEqual(fake.push.mock.calls[0]);
  expect((await f.review()).replies).toMatchObject([{ state: "accepted", canRetry: false }]);
});

test("analysis reports a known provider error and strips unexpected errors", async () => {
  const f = await fixture();
  for (const [id, error, warning] of [
    ["rate", "LINE_AI_RATE_LIMITED", "LINE_AI_RATE_LIMITED"],
    ["other", "unexpected fixture details", "LINE_AI_UNAVAILABLE"],
  ]) {
    fake.scan.mockRejectedValueOnce(new Error(error));
    await f.send([f.message(id, "@POS Help Printer offline")]);
    await f.runJobs(LINE_AI_FILE_WINDOW_MS + 1);
    expect((await f.review()).drafts[0]).toMatchObject({ warning, suggestion: { intent: "clarify" } });
  }
});

test("an accepted leave blocks a message in the same webhook batch", async () => {
  const f = await fixture();
  const item = f.message("after-leave", "@POS Help Printer offline");
  const leave = { type: "leave", timestamp: item.timestamp, webhookEventId: "same-batch-leave", source: item.source };
  expect((await f.send([item, leave])).status).toBe(200);
  expect(await f.t.run(({ db }) => db.query("lineAiIntakes").collect())).toHaveLength(0);
});

test("a reactivated bot and a restored Project each require a fresh chat opt-in", async () => {
  const f = await fixture();
  for (const enabled of [false, true]) {
    await f.t.mutation(api.line.updateBot, { token: f.token, botId: f.botId, enabled });
  }
  const chat = async () => (await f.t.query(api.line.listChats, { token: f.token, botId: f.botId }))[0];
  const enableChat = async () => {
    await f.t.mutation(api.line.setAssistantEnabled, { token: f.token, chatId: f.chatId, joinedAt: now - 1_000, enabled: true });
    await f.runJobs();
  };
  await f.runJobs();
  expect((await chat()).assistantEnabled).toBe(false);
  await f.send([f.message("uncertain-bot", "@POS Help Printer offline")]);
  expect(await f.t.run(({ db }) => db.query("lineAiIntakes").collect())).toHaveLength(0);
  await enableChat();
  expect((await chat()).assistantEnabled).toBe(true);
  for (const archived of [true, false]) {
    await f.t.mutation(internal.projects.setArchived, { projectId: f.projectId, archived });
  }
  await f.runJobs();
  expect((await chat()).assistantEnabled).toBe(false);
  await f.send([f.message("uncertain-project", "@POS Help Printer offline")]);
  expect(await f.t.run(({ db }) => db.query("lineAiIntakes").collect())).toHaveLength(0);
  await enableChat();
  expect((await chat()).assistantEnabled).toBe(true);
  await f.send([f.message("reenabled", "@POS Help Printer offline")]);
  await f.runJobs(LINE_AI_FILE_WINDOW_MS + 1);
  expect(fake.scan).toHaveBeenCalledOnce();
});

test("an allowed photo is analyzed and an expired attachment requires manual review", async () => {
  const f = await fixture();
  const upload = (id: string) => ({
    ...f.message(id, ""), message: { id, type: "image", contentProvider: { type: "line" } },
  });
  const photo = syntheticLineAiInput().files![0];
  fake.getContent.mockResolvedValueOnce(photo);
  await f.send([f.message("text-1", "@POS Help Printer offline"), upload("img-1")]);
  await f.runJobs(LINE_AI_FILE_WINDOW_MS + 1);
  expect(fake.scan).toHaveBeenCalledOnce();
  expect(fake.scan.mock.calls[0][1].files).toEqual([photo]);
  const [draft] = (await f.review()).drafts;
  await f.t.mutation(api.line_ai_reviews.dismiss, { token: f.token, draftId: draft._id });

  fake.getContent.mockRejectedValueOnce(new Error("LINE_CONTENT_EXPIRED"));
  await f.send([f.message("text-2", "@POS Help Can you see this?"), upload("img-2")]);
  await f.runJobs(LINE_AI_FILE_WINDOW_MS + 1);
  expect(fake.scan).toHaveBeenCalledOnce();
  const [expired] = (await f.review()).drafts;
  expect(expired).toMatchObject({ warning: "LINE_AI_ATTACHMENT_UNAVAILABLE", suggestion: { intent: "clarify" } });
  expect(fake.push).not.toHaveBeenCalled();
});

test("withdrawing an attachment invalidates its draft and reanalyzes the remaining text", async () => {
  const f = await fixture();
  const pdf = syntheticLineAiInput().files![1];
  fake.getContent.mockResolvedValueOnce(pdf);
  await f.send([f.message("text-1", "@POS Help Please check this PDF"), {
    ...f.message("pdf-1", ""), message: { id: "pdf-1", type: "file", contentProvider: { type: "line" } },
  }]);
  await f.runJobs(LINE_AI_FILE_WINDOW_MS + 1);
  expect(fake.scan.mock.calls[0][1].files).toEqual([pdf]);
  const [original] = (await f.review()).drafts;
  expect((await f.send([{
    type: "unsend", timestamp: Date.now(), webhookEventId: "unsend-pdf-1",
    source: { type: "group", groupId: "Cgroup", userId: "Usender" }, unsend: { messageId: "pdf-1" },
  }])).status).toBe(200);
  await expect(f.t.mutation(api.line_ai_reviews.approve, {
    token: f.token, draftId: original._id,
    decision: { type: "create", title: "Former draft", description: "", reply: original.replies.create },
  })).rejects.toThrow("LINE_AI_DRAFT_UNAVAILABLE");
  await f.runJobs();
  const [replacement] = (await f.review()).drafts;
  expect(replacement._id).not.toBe(original._id);
  expect(fake.scan.mock.calls[1][1].files).toEqual([]);
  expect(await f.tickets()).toHaveLength(0);
});

test("resuming a paused connection does not send its earlier queued intake to an AI provider", async () => {
  const f = await fixture();
  await f.send([f.message("old", "@POS Help Old printer request")]);
  for (const [paused, expectedRevision] of [[true, 1], [false, 2]] as const) {
    await f.t.mutation(api.line_ai_settings.setPaused, {
      token: f.owner.session, projectId: f.projectId, paused, expectedRevision,
    });
  }
  await f.runJobs(LINE_AI_FILE_WINDOW_MS + 1);
  expect(fake.scan).not.toHaveBeenCalled();
  expect((await f.review()).drafts).toHaveLength(0);
  await f.send([f.message("new", "@POS Help New printer request")]);
  await f.runJobs(LINE_AI_FILE_WINDOW_MS + 1);
  expect(fake.scan).toHaveBeenCalledOnce();
});

test("resuming a paused connection keeps its earlier draft and rate-limited reply blocked", async () => {
  const f = await fixture();
  await f.send([f.message("one", "@POS Help First printer"), f.message("two", "@POS Help Second printer")]);
  await f.runJobs(LINE_AI_FILE_WINDOW_MS + 1);
  const [first, second] = (await f.review()).drafts;
  const decision = { type: "create" as const, title: "Printer offline", description: "Register", reply: first.replies.create };
  fake.push.mockResolvedValueOnce("limited");
  const reply = await f.t.mutation(api.line_ai_reviews.approve, { token: f.token, draftId: first._id, decision });
  await f.runJobs();
  expect((await f.review()).replies).toMatchObject([{ state: "limited", canRetry: true }]);

  for (const [paused, expectedRevision] of [[true, 1], [false, 2]] as const) {
    await f.t.mutation(api.line_ai_settings.setPaused, {
      token: f.owner.session, projectId: f.projectId, paused, expectedRevision,
    });
  }
  expect((await f.page()).page).toEqual([{ _id: second._id, state: "unavailable" }]);
  expect((await f.review()).replies).toMatchObject([{ state: "limited", canRetry: false }]);
  await expect(f.t.mutation(api.line_ai_reviews.approve, { token: f.token, draftId: second._id, decision }))
    .rejects.toThrow("LINE_AI_DRAFT_UNAVAILABLE");
  await expect(f.t.mutation(api.line_ai_reviews.retryReply, { token: f.token, replyId: reply._id }))
    .rejects.toThrow("LINE_AI_REPLY_UNAVAILABLE");
  expect(fake.push).toHaveBeenCalledOnce();
});

test.each(["leave", "join"])("signed %s revokes draft and leased reply authority before metadata settles", async type => {
  const f = await fixture();
  await f.send([f.message("one", "@POS Help First printer"), f.message("two", "@POS Help Second printer")]);
  await f.runJobs(LINE_AI_FILE_WINDOW_MS + 1);
  const [first, second] = (await f.review()).drafts;
  const decision = { type: "create" as const, title: "Printer offline", description: "Register", reply: first.replies.create };
  const reply = await f.t.mutation(api.line_ai_reviews.approve, { token: f.token, draftId: first._id, decision });
  const lease = await f.t.mutation(internal.line_ai_delivery.claim, { replyId: reply._id });
  expect(lease).toBeTruthy();
  const auth = { replyId: reply._id, leaseId: lease!.leaseId, tokenCipher: lease!.tokenCipher };
  const event = (id: string, kind: string, timestamp: number) => ({
    webhookEventId: id, type: kind, timestamp, source: { type: "group", groupId: "Cgroup" },
  });
  const duplicate = event("same-join", "join", now - 1_000);
  await f.send([event("older-leave", "leave", now - 1_001), duplicate, duplicate]);
  expect(await f.t.query(internal.line_ai_delivery.authorize, auth)).toBe(true);
  const timestamp = type === "leave" ? now - 1_000 : now;
  expect((await f.send([event("transition", type, timestamp)])).status).toBe(200);
  expect(await f.t.run(({ db }) => db.get(f.chatId))).toMatchObject({ state: "active", assistantEnabled: true });
  expect(await f.t.query(internal.line_ai_delivery.authorize, auth)).toBe(false);
  await expect(f.t.mutation(api.line_ai_reviews.approve, { token: f.token, draftId: second._id, decision }))
    .rejects.toThrow("LINE_AI_DRAFT_UNAVAILABLE");
  expect(await f.tickets()).toHaveLength(1);
});
