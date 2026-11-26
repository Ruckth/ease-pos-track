import { createHmac } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { localLineAiFixtureKey } from "../../convex/adapters/line_ai_provider";
import {
  LINE_AI_DEDUP_TTL_MS,
  LINE_AI_FILE_WINDOW_MS,
  LINE_AI_INTAKE_TTL_MS,
  opaqueLineSenderDigest,
} from "../../convex/domain/line_ai_intake";
import { fixtures, identityTest } from "./identity-harness";
import { modules } from "./modules";

const fake = vi.hoisted(() => ({
  info: vi.fn(), setWebhook: vi.fn(), testWebhook: vi.fn(), webhookSettings: vi.fn(), groupSummary: vi.fn(),
  count: vi.fn(), profile: vi.fn(), leave: vi.fn(), reply: vi.fn(),
}));
vi.mock("../../convex/adapters/line", () => ({ createLine: () => fake, localLineFixtureToken: "fixture" }));

const now = 1_795_656_000_000;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3210");
  vi.stubEnv("LOCAL_FIXTURES_ENABLED", "true");
  vi.stubEnv("LINE_SECRETS_KEY", Buffer.alloc(32, 3).toString("base64"));
  vi.stubEnv("CONVEX_SITE_URL", "https://fixture.convex.site");
  vi.stubEnv("LINE_AI_ENABLED", "true");
  fake.info.mockResolvedValue({ userId: "Ubot", basicId: "@bot", displayName: "Bot" });
  fake.setWebhook.mockResolvedValue({});
  fake.webhookSettings.mockResolvedValue(undefined);
  fake.testWebhook.mockResolvedValue({ success: true, statusCode: 200 });
  fake.groupSummary.mockResolvedValue({ groupName: "POS Support" });
  fake.count.mockResolvedValue({ count: 5 });
  fake.profile.mockResolvedValue({ displayName: "Store Manager" });
  fake.reply.mockResolvedValue({});
  fake.leave.mockResolvedValue({});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

function groupJoin(groupId = "Cgroup", timestamp = now, webhookEventId = `join-${groupId}-${timestamp}`) {
  return {
    type: "join",
    timestamp,
    webhookEventId,
    replyToken: "reply-join",
    source: { type: "group", groupId },
  };
}

function directFollow(userId = "Udm", timestamp = now, webhookEventId = `follow-${userId}-${timestamp}`) {
  return {
    type: "follow",
    timestamp,
    webhookEventId,
    source: { type: "user", userId },
  };
}

function groupMention(options: {
  groupId?: string;
  userId?: string;
  webhookEventId: string;
  messageId: string;
  text: string;
  timestamp?: number;
  isSelf?: boolean;
  withMention?: boolean;
  isRedelivery?: boolean;
}) {
  const {
    groupId = "Cgroup",
    userId = "Ualice",
    webhookEventId,
    messageId,
    text,
    timestamp = now + 100,
    isSelf = true,
    withMention = true,
    isRedelivery,
  } = options;
  return {
    type: "message",
    mode: "active",
    webhookEventId,
    timestamp,
    ...(isRedelivery ? { deliveryContext: { isRedelivery: true } } : {}),
    source: { type: "group", groupId, userId },
    replyToken: "reply-must-not-persist",
    message: {
      id: messageId,
      type: "text",
      text,
      ...(withMention
        ? {
          mention: {
            mentionees: [
              { index: 0, length: 4, type: "user", userId: isSelf ? "Ubot" : "Usomeone", isSelf },
            ],
          },
        }
        : {}),
    },
  };
}

function directText(options: {
  userId?: string;
  webhookEventId: string;
  messageId: string;
  text: string;
  timestamp?: number;
}) {
  const { userId = "Udm", webhookEventId, messageId, text, timestamp = now + 100 } = options;
  return {
    type: "message",
    mode: "active",
    webhookEventId,
    timestamp,
    source: { type: "user", userId },
    message: { id: messageId, type: "text", text },
  };
}

function fileMessage(options: {
  kind?: "group" | "user";
  chatId?: string;
  userId?: string;
  webhookEventId: string;
  messageId: string;
  fileType: "image" | "video" | "file";
  timestamp: number;
  isRedelivery?: boolean;
}) {
  const {
    kind = "group",
    chatId = kind === "group" ? "Cgroup" : "Udm",
    userId = kind === "group" ? "Ualice" : chatId,
    webhookEventId,
    messageId,
    fileType,
    timestamp,
    isRedelivery,
  } = options;
  return {
    type: "message",
    mode: "active",
    webhookEventId,
    timestamp,
    ...(isRedelivery ? { deliveryContext: { isRedelivery: true } } : {}),
    source: kind === "group" ? { type: "group", groupId: chatId, userId } : { type: "user", userId: chatId },
    message: {
      id: messageId,
      type: fileType,
      contentProvider: { type: "line" },
      fileName: "secret-filename.pdf",
      fileSize: 99999,
    },
  };
}

function unsendEvent(options: {
  kind?: "group" | "user";
  chatId?: string;
  userId?: string;
  webhookEventId: string;
  messageId: string;
  timestamp: number;
}) {
  const {
    kind = "group",
    chatId = kind === "group" ? "Cgroup" : "Udm",
    userId,
    webhookEventId,
    messageId,
    timestamp,
  } = options;
  return {
    type: "unsend",
    mode: "active",
    webhookEventId,
    timestamp,
    source: kind === "group"
      ? { type: "group", groupId: chatId, ...(userId ? { userId } : {}) }
      : { type: "user", userId: chatId },
    unsend: { messageId },
  };
}

async function setup() {
  const t = identityTest(modules);
  const staff = await t.mutation(fixtures.staff, { email: "operator@fixture.test", role: "owner" });
  const projectId = await t.run(({ db }) => db.insert("projects", {
    key: "POS", name: "POS", createdAt: now, updatedAt: now,
  }));
  const token = staff.session;
  await t.action(api.line_ai_settings.testAndSave, { projectId, token, provider: "gemini", apiKey: localLineAiFixtureKey });
  const channelSecret = "channel-secret";
  const add = { projectId, name: "Bot", channelSecret, accessToken: "access-token", locale: "en" as const };
  const { botId } = await t.action(api.line.addBot, { ...add, token });

  async function botDoc(id = botId) {
    return (await t.run(({ db }) => db.get(id)))!;
  }

  async function send(events: unknown[], options?: { botId?: Id<"lineBots">; destination?: string; secret?: string }) {
    const target = await botDoc(options?.botId ?? botId);
    const body = JSON.stringify({ destination: options?.destination ?? target.lineUserId, events });
    const secret = options?.secret ?? channelSecret;
    return t.fetch(`/line/webhook/${target.webhookSlug}`, {
      method: "POST",
      body,
      headers: { "x-line-signature": createHmac("sha256", secret).update(body).digest("base64") },
    });
  }

  async function processScheduled() {
    await vi.advanceTimersByTimeAsync(1);
    await t.finishInProgressScheduledFunctions();
  }

  async function enrollGroup(groupId = "Cgroup", options?: { approve?: boolean; assistantEnabled?: boolean; timestamp?: number }) {
    const ts = options?.timestamp ?? now;
    expect((await send([groupJoin(groupId, ts)])).status).toBe(200);
    await processScheduled();
    const chat = await t.run(({ db }) =>
      db.query("lineChats").withIndex("by_bot_chat", q => q.eq("botId", botId).eq("lineChatId", groupId)).unique(),
    );
    expect(chat).not.toBeNull();
    if (options?.approve !== false) {
      await t.mutation(api.line.updateChat, {
        token, chatId: chat!._id, approve: true, joinedAt: chat!.joinedAt, notify: "own", allowCreate: true,
      });
    }
    if (options?.assistantEnabled !== undefined) {
      await t.run(({ db }) => db.patch(chat!._id, { assistantEnabled: options.assistantEnabled }));
    }
    return (await t.run(({ db }) => db.get(chat!._id)))!;
  }

  async function enrollDirect(userId = "Udm", options?: { approve?: boolean; assistantEnabled?: boolean; timestamp?: number }) {
    const ts = options?.timestamp ?? now;
    expect((await send([directFollow(userId, ts)])).status).toBe(200);
    await processScheduled();
    const chat = await t.run(({ db }) =>
      db.query("lineChats").withIndex("by_bot_chat", q => q.eq("botId", botId).eq("lineChatId", userId)).unique(),
    );
    expect(chat).not.toBeNull();
    if (options?.approve !== false && chat!.state === "pending") {
      await t.mutation(api.line.updateChat, {
        token, chatId: chat!._id, approve: true, joinedAt: chat!.joinedAt, notify: "own", allowCreate: true,
      });
    }
    if (options?.assistantEnabled !== undefined) {
      await t.run(({ db }) => db.patch(chat!._id, { assistantEnabled: options.assistantEnabled }));
    }
    return (await t.run(({ db }) => db.get(chat!._id)))!;
  }

  async function rows() {
    return t.run(async ({ db }) => ({
      intakes: await db.query("lineAiIntakes").collect(),
      fileLinks: await db.query("lineAiIntakeFiles").collect(),
      recentFiles: await db.query("lineAiRecentFiles").collect(),
      drafts: await db.query("lineAiDrafts").collect(),
      aiEvents: await db.query("lineAiEvents").collect(),
      unsends: await db.query("lineAiUnsends").collect(),
      inboundEvents: await db.query("lineInboundEvents").collect(),
      chats: await db.query("lineChats").collect(),
    }));
  }

  return { t, projectId, token, botId, add, botDoc, send, processScheduled, enrollGroup, enrollDirect, rows };
}

test("LINE_AI_ENABLED must be strictly 'true', and named pilot / archived project / disabled bot block intake", async () => {
  const f = await setup();
  const chat = await f.enrollGroup("Cgroup", { approve: true, assistantEnabled: true });

  // Non-'true' values must reject assistant intake completely.
  for (const flag of [undefined, "", "false", "TRUE", "1", "yes"]) {
    if (flag === undefined) vi.stubEnv("LINE_AI_ENABLED", "");
    else vi.stubEnv("LINE_AI_ENABLED", flag);
    if (flag === undefined) delete process.env.LINE_AI_ENABLED;
    expect((await f.send([groupMention({
      webhookEventId: `evt-flag-${String(flag)}`,
      messageId: `msg-flag-${String(flag)}`,
      text: "@Bot printer down",
    })])).status).toBe(200);
  }
  expect(await f.rows()).toMatchObject({ intakes: [], aiEvents: [], unsends: [] });

  // Enable strictly "true", then test disabled bot and archived project.
  vi.stubEnv("LINE_AI_ENABLED", "true");
  await f.t.mutation(api.line.updateBot, { token: f.token, botId: f.botId, enabled: false });
  expect((await f.send([groupMention({ webhookEventId: "evt-disabled-bot", messageId: "msg-db", text: "@Bot help" })])).status).toBe(200);
  await f.t.mutation(api.line.updateBot, { token: f.token, botId: f.botId, enabled: true });

  await f.t.mutation(internal.projects.setArchived, { projectId: f.projectId, archived: true });
  expect((await f.send([groupMention({ webhookEventId: "evt-archived", messageId: "msg-ar", text: "@Bot help" })])).status).toBe(200);
  await f.t.mutation(internal.projects.setArchived, { projectId: f.projectId, archived: false });
  expect((await f.rows()).intakes).toEqual([]);
  await f.t.mutation(api.line.setAssistantEnabled, { token: f.token, chatId: chat._id, joinedAt: chat.joinedAt, enabled: true });

  expect((await f.send([groupMention({
    webhookEventId: "evt-legacy", messageId: "msg-legacy", text: "@Bot legacy", timestamp: now + 100,
  })])).status).toBe(200);

  // Named pilot blocks both HTTP webhook and direct accept mutation even for an existing legacy intake.
  const epoch = "a".repeat(64);
  const manifestDigest = "b".repeat(64);
  await f.t.run(({ db }) => db.insert("pilotRelease", {
    epoch,
    manifestDigest,
    deploymentOrigin: process.env.CONVEX_CLOUD_URL!,
    projectIds: [f.projectId],
    ticketDisposalDeadline: now + 60_000,
  }));
  for (const [key, value] of Object.entries({
    TICKET_DEPLOYMENT_MODE: "named-pilot",
    TICKET_PILOT_EPOCH: epoch,
    TICKET_PILOT_MANIFEST_SHA256: manifestDigest,
    TICKET_PILOT_TRAFFIC: "open",
    TICKET_PILOT_INVITATIONS: "false",
    TICKET_PILOT_IDENTITY_SENDER: "false",
    LOCAL_FIXTURES_ENABLED: "false",
    LINE_AI_ENABLED: "true",
  })) vi.stubEnv(key, value);

  expect((await f.send([groupMention({ webhookEventId: "evt-pilot-http", messageId: "msg-pilot-http", text: "@Bot pilot" })])).status).toBe(404);
  vi.stubEnv("LINE_AI_ENABLED", "false");
  expect((await f.send([unsendEvent({
    webhookEventId: "evt-pilot-unsend", messageId: "msg-legacy", timestamp: now + 200,
  })])).status).toBe(404);
  const bot = await f.botDoc();
  const status = await f.t.mutation(internal.line_webhook.accept, {
    botId: f.botId,
    slug: bot.webhookSlug,
    destination: bot.lineUserId,
    verifiedSecretCipher: bot.secretCipher,
    events: [],
    assistantEvents: [{
      eventType: "unsend",
      webhookEventId: "evt-pilot-direct",
      timestamp: now + 200,
      kind: "group",
      lineChatId: "Cgroup",
      messageId: "msg-legacy",
      senderDigest: await opaqueLineSenderDigest(f.botId, "Cgroup", "Ualice"),
    }],
  });
  expect(status).toBe(200);
  expect((await f.rows()).intakes).toMatchObject([{ messageId: "msg-legacy", state: "pending", text: "legacy" }]);
});

test("signed unsends scrub drafts and invalidate leases with intake and scheduling paused", async () => {
  const f = await setup();
  await f.enrollGroup("Cgroup", { assistantEnabled: true });
  const trigger = (id: string, timestamp: number) =>
    groupMention({ webhookEventId: `e-${id}`, messageId: id, text: "@Bot private request", timestamp });
  const file = (id: string, timestamp: number, userId = "Ualice") =>
    fileMessage({ userId, webhookEventId: `e-${id}`, messageId: id, fileType: "image", timestamp });
  const unsend = (id: string, userId = "Ualice") =>
    unsendEvent({ userId, webhookEventId: `u-${id}`, messageId: id, timestamp: now + 600 });

  expect((await f.send([
    trigger("draft-trigger", now + 100),
    trigger("draft-file-trigger", now + 200), file("draft-file", now + 250),
    trigger("leased-trigger", now + 300), file("leased-file", now + 350),
    file("buffered-file", now + 400, "Ubob"),
  ])).status).toBe(200);
  const { intakes } = await f.rows();
  const leased = intakes.find(row => row.messageId === "leased-trigger")!;
  await f.t.run(async ({ db }) => {
    await db.patch(leased._id, { state: "processing", leaseId: "synthetic-lease", leaseExpiresAt: now + 60_000 });
    for (const intake of intakes.filter(row => row._id !== leased._id)) {
      await db.patch(intake._id, { state: "draft" });
      await db.insert("lineAiDrafts", {
        intakeId: intake._id, projectId: intake.projectId, state: "review",
        suggestion: { intent: "create", title: "Derived title", description: "Derived detail", ticketNumber: null, reply: null, evidence: [] },
        connectionRevision: intake.connectionRevision, createdAt: now, expiresAt: intake.expiresAt,
      });
    }
  });
  const scheduledCount = () => f.t.run(async ({ db }) =>
    (await db.system.query("_scheduled_functions").collect()).filter(job => job.name.includes("line_ai_processing")).length,
  );
  const before = await scheduledCount();
  vi.stubEnv("LINE_AI_ENABLED", "false");

  expect((await f.send([unsend("draft-trigger")], { secret: "other-secret" })).status).toBe(401);
  expect((await f.rows()).drafts).toHaveLength(2);
  const withdrawn = [unsend("draft-trigger"), unsend("draft-file"), unsend("leased-file"), unsend("buffered-file", "Ubob")];
  expect((await f.send([
    ...withdrawn, unsend("unknown"), trigger("off-trigger", now + 700), file("off-file", now + 750),
  ])).status).toBe(200);
  expect((await f.send(withdrawn)).status).toBe(200);
  expect(await scheduledCount()).toBe(before);

  const rows = await f.rows();
  expect(rows.intakes.find(row => row.messageId === "draft-trigger")).toMatchObject({ state: "ignored", text: "", files: [] });
  expect(rows.intakes.find(row => row.messageId === "draft-file-trigger")).toMatchObject({ state: "pending", files: [] });
  const previouslyLeased = rows.intakes.find(row => row._id === leased._id)!;
  expect(previouslyLeased).toMatchObject({ state: "pending", files: [] });
  expect(previouslyLeased.leaseId).toBeUndefined();
  expect(previouslyLeased.leaseExpiresAt).toBeUndefined();
  expect(rows).toMatchObject({ drafts: [], recentFiles: [], fileLinks: [] });
  expect(rows.intakes).toHaveLength(3);
  expect(rows.unsends).toHaveLength(5);
  expect(rows.unsends).toContainEqual(expect.objectContaining({ messageId: "unknown" }));

  vi.stubEnv("LINE_AI_ENABLED", "true");
  expect((await f.send([
    groupMention({ userId: "Ubob", webhookEventId: "e-new-trigger", messageId: "new-trigger", text: "@Bot New request", timestamp: now + 390 }),
    trigger("draft-trigger", now + 100), file("buffered-file", now + 400, "Ubob"), trigger("unknown", now + 500),
  ])).status).toBe(200);
  expect((await f.rows()).intakes.find(row => row.messageId === "new-trigger")?.files).toEqual([]);
  expect((await f.rows()).intakes.some(row => row.messageId === "unknown")).toBe(false);
  expect((await f.rows()).drafts).toEqual([]);
});

test("only active, explicitly opted-in chats accept group bot mentions and 1:1 direct requests", async () => {
  const f = await setup();

  // Default chat (assistantEnabled absent) and explicit false reject both group and 1:1.
  const groupDefault = await f.enrollGroup("Cdefault", { approve: true });
  const dmDefault = await f.enrollDirect("UdmDefault", { approve: true, assistantEnabled: false });
  const groupPending = await f.enrollGroup("Cpending", { approve: false, assistantEnabled: true });
  const groupMuted = await f.enrollGroup("Cmuted", { approve: true, assistantEnabled: true });
  await f.t.mutation(api.line.setChatState, {
    token: f.token, chatId: groupMuted._id, joinedAt: groupMuted.joinedAt, state: "muted",
  });

  expect((await f.send([
    groupMention({ groupId: groupDefault.lineChatId, webhookEventId: "e1", messageId: "m1", text: "@Bot hi" }),
    directText({ userId: dmDefault.lineChatId, webhookEventId: "e2", messageId: "m2", text: "Need help" }),
    groupMention({ groupId: groupPending.lineChatId, webhookEventId: "e3", messageId: "m3", text: "@Bot hi" }),
    groupMention({ groupId: groupMuted.lineChatId, webhookEventId: "e4", messageId: "m4", text: "@Bot hi" }),
  ])).status).toBe(200);
  expect(await f.rows()).toMatchObject({ intakes: [], aiEvents: [] });

  // Active + assistantEnabled: true accepts group isSelf mention and 1:1 direct text; rejects non-mention chatter.
  const optedGroup = await f.enrollGroup("Copted", { approve: true, assistantEnabled: true });
  const optedDm = await f.enrollDirect("UdmOpted", { approve: true, assistantEnabled: true });

  expect((await f.send([
    groupMention({ groupId: "Copted", webhookEventId: "e-chatter", messageId: "m-chatter", text: "normal chat", withMention: false }),
    groupMention({ groupId: "Copted", webhookEventId: "e-other-mention", messageId: "m-other", text: "@Bob check this", isSelf: false }),
    groupMention({ groupId: "Copted", webhookEventId: "e-trigger-group", messageId: "m-group-1", text: "@Bot Counter 3 barcode scanner dead", timestamp: now + 500 }),
    directText({ userId: "UdmOpted", webhookEventId: "e-trigger-dm", messageId: "m-dm-1", text: "Receipt paper jam at checkout 1", timestamp: now + 600 }),
  ])).status).toBe(200);

  // Verify scheduling seam was invoked for both newly created intakes.
  const scheduled = await f.t.run(({ db }) => db.system.query("_scheduled_functions").collect());
  const dispatchJobs = scheduled.filter(job => job.name.includes("line_ai_processing"));
  expect(dispatchJobs).toHaveLength(2);
  await f.processScheduled();

  const { intakes } = await f.rows();
  expect(intakes).toHaveLength(2);

  const groupIntake = intakes.find(row => row.messageId === "m-group-1")!;
  const dmIntake = intakes.find(row => row.messageId === "m-dm-1")!;
  expect(groupIntake).toMatchObject({
    projectId: f.projectId,
    botId: f.botId,
    chatId: optedGroup._id,
    joinedAt: optedGroup.joinedAt,
    kind: "group",
    webhookEventId: "e-trigger-group",
    messageId: "m-group-1",
    text: "Counter 3 barcode scanner dead",
    files: [],
    state: "pending",
    messageTimestamp: now + 500,
    windowEndsAt: now + 500 + LINE_AI_FILE_WINDOW_MS,
    attempt: 0,
  });
  expect(groupIntake.senderDigest).toBe(await opaqueLineSenderDigest(f.botId, "Copted", "Ualice"));
  expect(JSON.stringify(intakes)).not.toContain("Ualice");
  expect(JSON.stringify(intakes)).not.toContain("reply-must-not-persist");
  expect(JSON.stringify(intakes)).not.toContain("normal chat");

  expect(dmIntake).toMatchObject({
    projectId: f.projectId,
    botId: f.botId,
    chatId: optedDm._id,
    joinedAt: optedDm.joinedAt,
    kind: "user",
    text: "Receipt paper jam at checkout 1",
    files: [],
    state: "pending",
  });
  expect(dmIntake.senderDigest).toBe(await opaqueLineSenderDigest(f.botId, "UdmOpted", "UdmOpted"));
});

test("reordered files attach to the latest matching trigger before processing, with a two-file cap", async () => {
  const f = await setup();
  await f.enrollGroup("Cgroup", { assistantEnabled: true });
  await f.enrollGroup("Cother", { assistantEnabled: true });
  const trigger = (id: string, timestamp: number) =>
    groupMention({ webhookEventId: `e-${id}`, messageId: id, text: "@Bot Need help", timestamp });
  const file = (id: string, timestamp: number, scope?: { chatId?: string; userId?: string }) =>
    fileMessage({ ...scope, webhookEventId: `e-${id}`, messageId: id, fileType: "file", timestamp });

  expect((await f.send([trigger("older-trigger", now + 100)])).status).toBe(200);
  const first = file("reordered-1", now + 300);
  const second = file("reordered-2", now + 310);
  expect((await f.send([
    file("other-chat", now + 250, { chatId: "Cother" }),
    file("other-sender", now + 260, { userId: "Ubob" }),
    file("reordered-3", now + 320), first, second, first,
  ])).status).toBe(200);
  const before = await f.rows();
  expect(before.recentFiles).toHaveLength(5);
  expect(before.intakes[0].files.map(ref => ref.messageId)).toEqual(["reordered-3", "reordered-1"]);
  expect(JSON.stringify(before.recentFiles)).not.toMatch(/Ualice|secret-filename|fileSize/);

  expect((await f.send([trigger("delayed-trigger", now + 200)])).status).toBe(200);
  expect((await f.send([
    first, second, trigger("superseded-trigger", now + 180), file("older-only", now + 150),
  ])).status).toBe(200);
  const { intakes, fileLinks } = await f.rows();
  const delayed = intakes.find(row => row.messageId === "delayed-trigger")!;
  expect(delayed.files).toEqual([
    { messageId: "reordered-1", type: "file" },
    { messageId: "reordered-2", type: "file" },
  ]);
  expect(intakes.find(row => row.messageId === "older-trigger")?.files).toEqual([{ messageId: "older-only", type: "file" }]);
  expect(intakes.find(row => row.messageId === "superseded-trigger")?.files).toEqual([]);
  expect(fileLinks.some(row => row.messageId === "reordered-3")).toBe(false);
  expect(fileLinks.filter(row => row.intakeId === delayed._id).map(row => row.messageId).sort()).toEqual(["reordered-1", "reordered-2"]);
});

test("reordered files bypass closed context and cannot cross enrollment or assistant revisions", async () => {
  const f = await setup();
  const chat = await f.enrollGroup("Cgroup", { assistantEnabled: true });
  const trigger = (id: string, timestamp: number) =>
    groupMention({ webhookEventId: `e-${id}`, messageId: id, text: "@Bot Need help", timestamp });
  const file = (id: string, timestamp: number, userId = "Ualice") =>
    fileMessage({ userId, webhookEventId: `e-${id}`, messageId: id, fileType: "image", timestamp });
  const withdraw = (id: string, timestamp: number) =>
    unsendEvent({ userId: "Ualice", webhookEventId: `u-${id}`, messageId: id, timestamp });

  expect((await f.send([trigger("unsent-trigger", now + 100), withdraw("unsent-trigger", now + 200)])).status).toBe(200);
  expect((await f.send([
    file("survives", now + 400), file("withdrawn", now + 450), withdraw("withdrawn", now + 500),
  ])).status).toBe(200);
  expect((await f.send([trigger("too-old", now + 50), trigger("current-trigger", now + 350)])).status).toBe(200);
  const after = await f.rows();
  expect(after.intakes.find(row => row.messageId === "too-old")?.files).toEqual([]);
  expect(after.intakes.find(row => row.messageId === "unsent-trigger")).toMatchObject({ state: "ignored", files: [] });
  expect(after.intakes.find(row => row.messageId === "current-trigger")?.files).toEqual([{ messageId: "survives", type: "image" }]);

  // Delayed reference is newer than the event-time opt-in cutoff but was received under the old revision.
  expect((await f.send([file("before-revision", now + 900, "Ubob")])).status).toBe(200);
  await f.t.run(({ db }) => db.patch(chat._id, { assistantRevision: (chat.assistantRevision ?? 0) + 1 }));
  expect((await f.send([groupMention({
    userId: "Ubob", webhookEventId: "e-after-revision", messageId: "after-revision", text: "@Bot New", timestamp: now + 800,
  })])).status).toBe(200);

  expect((await f.send([file("old-enrollment", now + 1_200, "Ucara")])).status).toBe(200);
  await f.t.run(({ db }) => db.patch(chat._id, { joinedAt: now + 1_000 }));
  expect((await f.send([groupMention({
    userId: "Ucara", webhookEventId: "e-new-enrollment", messageId: "new-enrollment", text: "@Bot New", timestamp: now + 1_100,
  })])).status).toBe(200);
  const { intakes, recentFiles } = await f.rows();
  expect(recentFiles.map(row => row.messageId)).toEqual(["survives", "before-revision", "old-enrollment"]);
  expect(intakes.find(row => row.messageId === "after-revision")?.files).toEqual([]);
  expect(intakes.find(row => row.messageId === "new-enrollment")?.files).toEqual([]);
});

test("reordered references occupy a bounded buffer and expire without attaching", async () => {
  const f = await setup();
  await f.enrollGroup("Cgroup", { assistantEnabled: true });
  const files = Array.from({ length: 20 }, (_, index) => fileMessage({
    webhookEventId: `e-orphan-${index}`, messageId: `orphan-${index}`, timestamp: now + 200, fileType: "image",
  }));
  expect((await f.send(files)).status).toBe(200);
  expect(await f.rows()).toMatchObject({ recentFiles: Array.from({ length: 8 }, () => ({ messageTimestamp: now + 200 })), intakes: [], aiEvents: [] });

  const expiresAt = Math.max(...(await f.rows()).recentFiles.map(row => row.expiresAt));
  vi.setSystemTime(expiresAt);
  expect((await f.send([
    groupMention({ webhookEventId: "e-delayed", messageId: "delayed", text: "@Bot delayed request", timestamp: now + 100 }),
  ])).status).toBe(200);
  expect((await f.rows()).intakes[0].files).toEqual([]);
  expect(await f.t.mutation(internal.line_webhook.cleanupExpiredAiIntake, { limit: 1 })).toMatchObject({ deletedRecentFiles: 1 });
  expect((await f.rows()).recentFiles).toHaveLength(7);
  expect(await f.t.mutation(internal.line_webhook.cleanupExpiredAiIntake, { limit: 20 })).toMatchObject({ deletedRecentFiles: 7 });
  expect((await f.rows()).recentFiles).toEqual([]);
});

test("follow-up files attach within window up to max 2 and reject pre-trigger, cross-sender, cross-chat, outside-window and stale enrollment", async () => {
  const f = await setup();
  const chatA = await f.enrollGroup("CgroupA", { approve: true, assistantEnabled: true, timestamp: now });
  await f.enrollGroup("CgroupB", { approve: true, assistantEnabled: true, timestamp: now });

  // A file whose LINE timestamp precedes the trigger must not attach.
  expect((await f.send([
    fileMessage({ chatId: "CgroupA", userId: "Ualice", webhookEventId: "f-pre-1", messageId: "mf-pre-1", fileType: "image", timestamp: now + 50 }),
  ])).status).toBe(200);

  // Trigger at t = now + 1000.
  const triggerAt = now + 1_000;
  expect((await f.send([
    groupMention({ groupId: "CgroupA", userId: "Ualice", webhookEventId: "evt-t1", messageId: "m-t1", text: "@Bot POS freeze", timestamp: triggerAt }),
  ])).status).toBe(200);

  // Out-of-order pre-trigger file (timestamp < triggerAt), cross-sender, cross-chat, and outside-window are all rejected.
  expect((await f.send([
    fileMessage({ chatId: "CgroupA", userId: "Ualice", webhookEventId: "f-ooo-pre", messageId: "mf-ooo-pre", fileType: "image", timestamp: triggerAt - 1 }),
    fileMessage({ chatId: "CgroupA", userId: "Ubob", webhookEventId: "f-other-sender", messageId: "mf-bob", fileType: "image", timestamp: triggerAt + 1_000 }),
    fileMessage({ chatId: "CgroupB", userId: "Ualice", webhookEventId: "f-other-chat", messageId: "mf-chatB", fileType: "image", timestamp: triggerAt + 1_000 }),
    fileMessage({ chatId: "CgroupA", userId: "Ualice", webhookEventId: "f-outside", messageId: "mf-outside", fileType: "image", timestamp: triggerAt + LINE_AI_FILE_WINDOW_MS + 1 }),
  ])).status).toBe(200);

  expect((await f.rows()).intakes[0].files).toEqual([]);

  // Two valid files (including one at exact window boundary) attach; third file is rejected.
  expect((await f.send([
    fileMessage({ chatId: "CgroupA", userId: "Ualice", webhookEventId: "f-ok-1", messageId: "mf-1", fileType: "image", timestamp: triggerAt + 5_000 }),
    fileMessage({ chatId: "CgroupA", userId: "Ualice", webhookEventId: "f-ok-2", messageId: "mf-2", fileType: "video", timestamp: triggerAt + LINE_AI_FILE_WINDOW_MS }),
    fileMessage({ chatId: "CgroupA", userId: "Ualice", webhookEventId: "f-extra-3", messageId: "mf-3", fileType: "file", timestamp: triggerAt + 10_000 }),
  ])).status).toBe(200);

  const afterAttach = (await f.rows()).intakes[0];
  expect(afterAttach.files).toEqual([
    { messageId: "mf-1", type: "image" },
    { messageId: "mf-2", type: "video" },
  ]);
  expect(JSON.stringify(afterAttach)).not.toContain("secret-filename.pdf");

  // Rejoin advances chat.joinedAt: files in the new enrollment cannot attach to the old enrollment's intake,
  // and messages with timestamps older than the new joinedAt are rejected.
  const trigger2At = triggerAt + 20_000;
  expect((await f.send([
    groupMention({ groupId: "CgroupA", userId: "Ubob", webhookEventId: "evt-t2", messageId: "m-t2", text: "@Bot Drawer stuck", timestamp: trigger2At }),
  ])).status).toBe(200);

  const rejoinAt = trigger2At + 5_000;
  expect((await f.send([
    { type: "leave", timestamp: trigger2At + 1_000, webhookEventId: "evt-leave", source: { type: "group", groupId: "CgroupA" } },
    groupJoin("CgroupA", rejoinAt, "evt-rejoin"),
  ])).status).toBe(200);
  await f.processScheduled();
  await f.t.mutation(api.line.updateChat, {
    token: f.token, chatId: chatA._id, approve: true, joinedAt: rejoinAt, notify: "own", allowCreate: true,
  });
  await f.t.run(({ db }) => db.patch(chatA._id, { assistantEnabled: true }));

  expect((await f.send([
    // Timestamp from before rejoin -> stale enrollment rejected.
    groupMention({ groupId: "CgroupA", userId: "Ubob", webhookEventId: "evt-stale-text", messageId: "m-stale", text: "@Bot old", timestamp: rejoinAt - 1 }),
    // Timestamp after rejoin trying to attach to pre-rejoin intake m-t2 -> enrollment joinedAt mismatch rejected.
    fileMessage({ chatId: "CgroupA", userId: "Ubob", webhookEventId: "f-cross-enroll", messageId: "mf-cross-enroll", fileType: "image", timestamp: rejoinAt + 1_000 }),
  ])).status).toBe(200);

  const bobIntake = (await f.rows()).intakes.find(row => row.messageId === "m-t2")!;
  expect(bobIntake.files).toEqual([]);
  expect((await f.rows()).intakes.find(row => row.messageId === "m-stale")).toBeUndefined();
});

test("replay/redelivery is idempotent across webhookEventId and messageId", async () => {
  const f = await setup();
  await f.enrollGroup("Cgroup", { approve: true, assistantEnabled: true });

  const trigger = groupMention({ webhookEventId: "evt-replay-1", messageId: "m-replay-1", text: "@Bot Sync error", timestamp: now + 100 });
  const file = fileMessage({ webhookEventId: "evt-file-replay-1", messageId: "mf-replay-1", fileType: "file", timestamp: now + 200 });

  expect((await f.send([trigger, file])).status).toBe(200);
  // Redelivery with same webhookEventId and also duplicate messageId with fresh webhookEventId.
  expect((await f.send([
    { ...trigger, deliveryContext: { isRedelivery: true } },
    { ...file, deliveryContext: { isRedelivery: true } },
    groupMention({ webhookEventId: "evt-replay-2", messageId: "m-replay-1", text: "@Bot Sync error", timestamp: now + 100 }),
    fileMessage({ webhookEventId: "evt-file-replay-2", messageId: "mf-replay-1", fileType: "file", timestamp: now + 200 }),
  ])).status).toBe(200);

  const { intakes, fileLinks } = await f.rows();
  expect(intakes).toHaveLength(1);
  expect(intakes[0].files).toEqual([{ messageId: "mf-replay-1", type: "file" }]);
  expect(fileLinks).toHaveLength(1);
});

test("unsend respects pre-approval states, protects acted intakes, blocks redelivery and out-of-order resurrection, and isolates chats/senders", async () => {
  const f = await setup();
  await f.enrollGroup("CgroupA", { approve: true, assistantEnabled: true });
  await f.enrollGroup("CgroupB", { approve: true, assistantEnabled: true });

  // 1. Out-of-order unsend BEFORE trigger message and BEFORE file message.
  expect((await f.send([
    unsendEvent({ chatId: "CgroupA", userId: "Ualice", webhookEventId: "u-ooo-trigger", messageId: "m-ooo", timestamp: now + 200 }),
    unsendEvent({ chatId: "CgroupA", userId: "Ualice", webhookEventId: "u-ooo-file", messageId: "mf-ooo", timestamp: now + 250 }),
  ])).status).toBe(200);
  expect((await f.send([
    groupMention({ groupId: "CgroupA", userId: "Ualice", webhookEventId: "e-ooo-trigger", messageId: "m-ooo", text: "@Bot never create", timestamp: now + 150 }),
  ])).status).toBe(200);
  expect((await f.rows()).intakes).toEqual([]);

  // Create intake m-1 with two files; late delivery of pre-unsent mf-ooo must not attach.
  expect((await f.send([
    groupMention({ groupId: "CgroupA", userId: "Ualice", webhookEventId: "e-m1", messageId: "m-1", text: "@Bot terminal crash", timestamp: now + 300 }),
    fileMessage({ chatId: "CgroupA", userId: "Ualice", webhookEventId: "e-mf-ooo", messageId: "mf-ooo", fileType: "image", timestamp: now + 310 }),
    fileMessage({ chatId: "CgroupA", userId: "Ualice", webhookEventId: "e-mf1", messageId: "mf-1", fileType: "image", timestamp: now + 320 }),
    fileMessage({ chatId: "CgroupA", userId: "Ualice", webhookEventId: "e-mf2", messageId: "mf-2", fileType: "video", timestamp: now + 330 }),
  ])).status).toBe(200);

  let m1 = (await f.rows()).intakes.find(row => row.messageId === "m-1")!;
  expect(m1.files).toEqual([
    { messageId: "mf-1", type: "image" },
    { messageId: "mf-2", type: "video" },
  ]);

  // 2. Cross-chat and cross-sender unsends must not touch m-1 or mf-1.
  expect((await f.send([
    unsendEvent({ chatId: "CgroupB", userId: "Ualice", webhookEventId: "u-cross-chat", messageId: "m-1", timestamp: now + 350 }),
    unsendEvent({ chatId: "CgroupA", userId: "Ubob", webhookEventId: "u-cross-sender", messageId: "m-1", timestamp: now + 351 }),
    unsendEvent({ chatId: "CgroupA", userId: "Ubob", webhookEventId: "u-cross-sender-file", messageId: "mf-1", timestamp: now + 352 }),
  ])).status).toBe(200);
  m1 = (await f.rows()).intakes.find(row => row.messageId === "m-1")!;
  expect(m1.state).toBe("pending");
  expect(m1.files).toHaveLength(2);

  // 3. Unsend attached file mf-1 before approval removes it and blocks redelivery even with a fresh webhookEventId.
  expect((await f.send([
    unsendEvent({ chatId: "CgroupA", userId: "Ualice", webhookEventId: "u-mf1", messageId: "mf-1", timestamp: now + 400 }),
  ])).status).toBe(200);
  m1 = (await f.rows()).intakes.find(row => row.messageId === "m-1")!;
  expect(m1.files).toEqual([{ messageId: "mf-2", type: "video" }]);

  expect((await f.send([
    fileMessage({ chatId: "CgroupA", userId: "Ualice", webhookEventId: "e-mf1-redeliver", messageId: "mf-1", fileType: "image", timestamp: now + 320, isRedelivery: true }),
  ])).status).toBe(200);
  m1 = (await f.rows()).intakes.find(row => row.messageId === "m-1")!;
  expect(m1.files).toEqual([{ messageId: "mf-2", type: "video" }]);

  // 4. Unsend trigger while in `processing` (with active lease) cancels it, clears lease, scrubs content, and blocks follow-up/redelivery.
  await f.t.run(({ db }) => db.patch(m1._id, {
    state: "processing", leaseId: "lease-1", leaseExpiresAt: now + 45_000, attempt: 1,
  }));
  expect((await f.send([
    unsendEvent({ chatId: "CgroupA", userId: "Ualice", webhookEventId: "u-m1", messageId: "m-1", timestamp: now + 500 }),
  ])).status).toBe(200);
  m1 = (await f.rows()).intakes.find(row => row.messageId === "m-1")!;
  expect(m1).toMatchObject({ state: "ignored", text: "", files: [], unsentAt: now + 500 });
  expect(m1.leaseId).toBeUndefined();
  expect(m1.leaseExpiresAt).toBeUndefined();
  expect((await f.rows()).fileLinks).toEqual([]);

  // Late file or redelivered trigger after unsend cannot resurrect m-1.
  expect((await f.send([
    groupMention({ groupId: "CgroupA", userId: "Ualice", webhookEventId: "e-m1-redeliver", messageId: "m-1", text: "@Bot terminal crash", timestamp: now + 300, isRedelivery: true }),
    fileMessage({ chatId: "CgroupA", userId: "Ualice", webhookEventId: "e-mf3-after-unsend", messageId: "mf-3", fileType: "image", timestamp: now + 510 }),
  ])).status).toBe(200);
  m1 = (await f.rows()).intakes.find(row => row.messageId === "m-1")!;
  expect(m1).toMatchObject({ state: "ignored", text: "", files: [] });

  // 5. Unsend trigger while in `draft` (pre-approval) ignores and scrubs it.
  expect((await f.send([
    groupMention({ groupId: "CgroupA", userId: "Ualice", webhookEventId: "e-draft", messageId: "m-draft", text: "@Bot draft ticket", timestamp: now + 600 }),
  ])).status).toBe(200);
  const draftRow = (await f.rows()).intakes.find(row => row.messageId === "m-draft")!;
  await f.t.run(({ db }) => db.patch(draftRow._id, { state: "draft" }));
  expect((await f.send([
    unsendEvent({ chatId: "CgroupA", userId: "Ualice", webhookEventId: "u-draft", messageId: "m-draft", timestamp: now + 650 }),
  ])).status).toBe(200);
  expect((await f.rows()).intakes.find(row => row.messageId === "m-draft")).toMatchObject({
    state: "ignored", text: "", files: [], unsentAt: now + 650,
  });

  // 6. Unsend after approval (`acted`) leaves the acted intake and its file refs intact.
  expect((await f.send([
    groupMention({ groupId: "CgroupA", userId: "Ualice", webhookEventId: "e-acted", messageId: "m-acted", text: "@Bot approved issue", timestamp: now + 700 }),
    fileMessage({ chatId: "CgroupA", userId: "Ualice", webhookEventId: "e-acted-f", messageId: "mf-acted", fileType: "image", timestamp: now + 710 }),
  ])).status).toBe(200);
  const actedRow = (await f.rows()).intakes.find(row => row.messageId === "m-acted")!;
  await f.t.run(({ db }) => db.patch(actedRow._id, { state: "acted" }));
  expect((await f.send([
    unsendEvent({ chatId: "CgroupA", userId: "Ualice", webhookEventId: "u-acted", messageId: "m-acted", timestamp: now + 750 }),
    unsendEvent({ chatId: "CgroupA", userId: "Ualice", webhookEventId: "u-acted-f", messageId: "mf-acted", timestamp: now + 760 }),
  ])).status).toBe(200);
  expect((await f.rows()).intakes.find(row => row.messageId === "m-acted")).toMatchObject({
    state: "acted",
    text: "approved issue",
    files: [{ messageId: "mf-acted", type: "image" }],
  });
});

test("setup state returns 503 for assistant events, non-pending intakes reject new files, and multiple bots stay isolated", async () => {
  const f = await setup();
  await f.enrollGroup("Cshared", { approve: true, assistantEnabled: true });

  // Second bot in the same Project.
  fake.info.mockResolvedValueOnce({ userId: "Ubot2", basicId: "@bot2", displayName: "Bot 2" });
  const { botId: bot2Id } = await f.t.action(api.line.addBot, {
    ...f.add, token: f.token, name: "Bot 2", channelSecret: "secret-2", accessToken: "token-2",
  });
  expect((await f.send([groupJoin("Cshared", now, "join-bot2")], { botId: bot2Id, secret: "secret-2" })).status).toBe(200);
  await f.processScheduled();
  const bot2Chat = await f.t.run(({ db }) =>
    db.query("lineChats").withIndex("by_bot_chat", q => q.eq("botId", bot2Id).eq("lineChatId", "Cshared")).unique(),
  );
  await f.t.mutation(api.line.updateChat, {
    token: f.token, chatId: bot2Chat!._id, approve: true, joinedAt: bot2Chat!.joinedAt, notify: "own", allowCreate: true,
  });
  await f.t.run(({ db }) => db.patch(bot2Chat!._id, { assistantEnabled: true }));

  // Trigger on Bot 1; follow-up file or unsend delivered to Bot 2 cannot cross bots.
  expect((await f.send([
    groupMention({ groupId: "Cshared", userId: "Ualice", webhookEventId: "e-b1", messageId: "m-b1", text: "@Bot bot 1 issue", timestamp: now + 100 }),
  ])).status).toBe(200);
  expect((await f.send([
    fileMessage({ chatId: "Cshared", userId: "Ualice", webhookEventId: "e-b2-file", messageId: "mf-b2", fileType: "image", timestamp: now + 200 }),
    unsendEvent({ chatId: "Cshared", userId: "Ualice", webhookEventId: "e-b2-unsend", messageId: "m-b1", timestamp: now + 250 }),
  ], { botId: bot2Id, secret: "secret-2" })).status).toBe(200);

  let b1 = (await f.rows()).intakes.find(row => row.messageId === "m-b1")!;
  expect(b1.state).toBe("pending");
  expect(b1.files).toEqual([]);

  // Moving intake out of `pending` (e.g. `draft`) stops further follow-up files.
  await f.t.run(({ db }) => db.patch(b1._id, { state: "draft" }));
  expect((await f.send([
    fileMessage({ chatId: "Cshared", userId: "Ualice", webhookEventId: "e-b1-late-file", messageId: "mf-late", fileType: "image", timestamp: now + 300 }),
  ])).status).toBe(200);
  b1 = (await f.rows()).intakes.find(row => row.messageId === "m-b1")!;
  expect(b1.files).toEqual([]);

  // Unsend without source.userId (unconsented LINE group user) still cancels pre-approval intake in same chat.
  expect((await f.send([
    unsendEvent({ chatId: "Cshared", webhookEventId: "e-b1-unsend-nouser", messageId: "m-b1", timestamp: now + 350 }),
  ])).status).toBe(200);
  expect((await f.rows()).intakes.find(row => row.messageId === "m-b1")).toMatchObject({
    state: "ignored", text: "", files: [],
  });

  const delayed = groupMention({
    groupId: "Cshared", webhookEventId: "e-delayed-b1", messageId: "m-delayed-b1", text: "@Bot Delayed", timestamp: now + 150,
  });
  expect((await f.send([delayed])).status).toBe(200);
  expect((await f.rows()).intakes.find(row => row.messageId === "m-delayed-b1")?.files)
    .toEqual([{ messageId: "mf-late", type: "image" }]);
  expect((await f.send([{
    ...delayed, webhookEventId: "e-delayed-b2", message: { ...delayed.message, id: "m-delayed-b2" },
  }], { botId: bot2Id, secret: "secret-2" })).status).toBe(200);
  expect((await f.rows()).intakes.find(row => row.messageId === "m-delayed-b2")?.files)
    .toEqual([{ messageId: "mf-b2", type: "image" }]);

  // Bot in `setup` state returns 503 for assistant events so LINE retries after setup completes.
  await f.t.run(({ db }) => db.patch(bot2Id, { state: "setup" }));
  expect((await f.send([
    groupMention({ groupId: "Cshared", userId: "Ualice", webhookEventId: "e-setup-msg", messageId: "m-setup", text: "@Bot retry me", timestamp: now + 400 }),
  ], { botId: bot2Id, secret: "secret-2" })).status).toBe(503);
  expect((await f.rows()).intakes.find(row => row.messageId === "m-setup")).toBeUndefined();
});

test("bounded cleanup sweeps expired intakes, file links, events and unsends while sparing active leases", async () => {
  const f = await setup();
  await f.enrollGroup("Cgroup", { approve: true, assistantEnabled: true });

  expect((await f.send([
    groupMention({ webhookEventId: "e-c1", messageId: "m-c1", text: "@Bot first", timestamp: now + 100 }),
    fileMessage({ webhookEventId: "e-cf1", messageId: "mf-c1", fileType: "image", timestamp: now + 200 }),
    groupMention({ webhookEventId: "e-c2", messageId: "m-c2", text: "@Bot leased", timestamp: now + 300 }),
    fileMessage({ webhookEventId: "e-cf2", messageId: "mf-c2", fileType: "video", timestamp: now + 350 }),
    unsendEvent({ chatId: "Cgroup", userId: "Ualice", webhookEventId: "e-cu1", messageId: "m-never", timestamp: now + 400 }),
  ])).status).toBe(200);

  const leased = (await f.rows()).intakes.find(row => row.messageId === "m-c2")!;
  const intakeExpiry = leased.expiresAt;
  expect(intakeExpiry).toBe(leased.createdAt + LINE_AI_INTAKE_TTL_MS);
  await f.t.run(({ db }) => db.patch(leased._id, {
    state: "processing", leaseId: "active-lease", leaseExpiresAt: intakeExpiry + 30_000,
  }));

  // Advance past intake TTL (24h), before active lease expiry and dedup/unsend TTL (7d).
  vi.setSystemTime(intakeExpiry + 1_000);
  const firstSweep = await f.t.mutation(internal.line_webhook.cleanupExpiredAiIntake, { limit: 50 });
  expect(firstSweep).toEqual({ deletedIntakes: 1, deletedFiles: 1, deletedRecentFiles: 2, deletedEvents: 0, deletedUnsends: 0 });
  expect((await f.rows()).intakes.map(row => row.messageId)).toEqual(["m-c2"]);
  expect((await f.rows()).fileLinks.map(row => row.messageId)).toEqual(["mf-c2"]);

  // Advance past dedup TTL (7d) and active lease expiry.
  vi.setSystemTime(leased.createdAt + LINE_AI_DEDUP_TTL_MS + 1_000);
  const secondSweep = await f.t.mutation(internal.line_webhook.cleanupExpiredAiIntake, { limit: 50 });
  expect(secondSweep).toEqual({ deletedIntakes: 1, deletedFiles: 1, deletedRecentFiles: 0, deletedEvents: 5, deletedUnsends: 1 });
  expect(await f.rows()).toMatchObject({ intakes: [], fileLinks: [], aiEvents: [], unsends: [] });
});
