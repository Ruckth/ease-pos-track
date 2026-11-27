import { createHmac } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import { fixtures, identityTest } from "./identity-harness";
import { modules } from "./modules";
import { currentLineLifecycle } from "../../convex/domain/line_ai_review";
import { sealLineSecret } from "../../convex/line_crypto";

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
  vi.stubEnv("LINE_SECRETS_KEY", Buffer.alloc(32, 1).toString("base64"));
  vi.stubEnv("CONVEX_SITE_URL", "https://fixture.convex.site");
  fake.info.mockResolvedValue({ userId: "Ubot", basicId: "@bot", displayName: "Bot" });
  fake.setWebhook.mockResolvedValue({});
  fake.webhookSettings.mockResolvedValue(undefined);
  fake.testWebhook.mockResolvedValue({ success: true, statusCode: 200 });
  fake.groupSummary.mockResolvedValue({ groupName: "Fixture group" });
  fake.count.mockResolvedValue({ count: 5 });
  fake.profile.mockResolvedValue({ displayName: "Fixture user" });
  fake.reply.mockResolvedValue({});
  fake.leave.mockResolvedValue({});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

function group(type = "join", timestamp = now, webhookEventId = type) {
  return { type, timestamp, webhookEventId, replyToken: "reply-once",
    source: { type: "group", groupId: "Cgroup" }, message: { text: "must never persist" } };
}
function direct(type: string, timestamp = now, userId = "Ufriend") {
  return { type, timestamp, webhookEventId: type + userId, source: { type: "user", userId } };
}

async function fixture(channelSecret = "channel-secret", verify?: (endpoint: string, probe: (path: string) => Promise<Response>) => Promise<unknown>) {
  const t = identityTest(modules);
  const staff = await t.mutation(fixtures.staff, { email: "operator@fixture.test" });
  const projectId = await t.run(({ db }) => db.insert("projects", { key: "POS", name: "POS", createdAt: now, updatedAt: now }));
  const customer = await t.mutation(fixtures.customer, { username: "member", projectIds: [projectId] });
  const outsider = await t.mutation(fixtures.customer, { username: "outsider" });
  const add = { projectId, name: "Bot", channelSecret, accessToken: "access-token", locale: "en" as const };
  const token = staff.session;
  if (verify) fake.testWebhook.mockImplementation(endpoint => verify(endpoint, path => signedRequest(path, [], "Ubot", "channel-secret")));
  const result = await t.action(api.line.addBot, { ...add, token });
  const { botId } = result;
  async function rows() {
    return t.run(async ({ db }) => ({
      events: await db.query("lineInboundEvents").collect(), chats: await db.query("lineChats").collect(), bot: await db.get(botId),
    }));
  }
  function signedRequest(path: string, events: unknown[], destination: string, secret: string) {
    const body = JSON.stringify({ destination, events });
    return t.fetch(path, {
      method: "POST", body, headers: { "x-line-signature": createHmac("sha256", secret).update(body).digest("base64") },
    });
  }
  async function send(events: unknown[], destination = "Ubot", secret = add.channelSecret, slug?: string) {
    return signedRequest("/line/webhook/" + (slug ?? (await rows()).bot!.webhookSlug), events, destination, secret);
  }
  const processEvents = async () => {
    await vi.advanceTimersByTimeAsync(1);
    await t.finishInProgressScheduledFunctions();
  };
  return { t, projectId, token, staff, customer, outsider, botId, add, result, rows, send, processEvents };
}

test("signed intake filters chatter, dedupes and verifies bot destination and availability", async () => {
  const f = await fixture();
  expect((await f.send([], "Uwrong")).status).toBe(401);
  expect((await f.send([], "Ubot", "wrong")).status).toBe(401);
  expect((await f.rows()).bot?.signatureFailures).toBe(1);
  await f.t.mutation(api.line.updateBot, { token: f.token, botId: f.botId, enabled: false });
  expect((await f.send([group()])).status).toBe(200);
  await f.t.mutation(api.line.updateBot, { token: f.token, botId: f.botId, enabled: true });
  await f.t.mutation(internal.projects.setArchived, { projectId: f.projectId, archived: true });
  expect((await f.send([group()])).status).toBe(200);
  expect(await f.rows()).toMatchObject({ events: [], chats: [] });
  expect((await f.rows()).bot?.lastWebhookAt).toBeUndefined();
  await f.t.mutation(internal.projects.setArchived, { projectId: f.projectId, archived: false });
  expect((await f.send([])).status).toBe(200);
  expect((await f.send([group(), group("message"), group("postback")])).status).toBe(200);
  expect((await f.send([{ ...group(), deliveryContext: { isRedelivery: true } }])).status).toBe(200);
  await f.processEvents();
  const { events, chats } = await f.rows();
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ webhookEventId: "join", state: "done", payload: {} });
  expect(JSON.stringify(events)).not.toContain("must never persist");
  expect(chats[0]).toMatchObject({ state: "pending", name: "Fixture group", memberCount: 5 });
  expect(fake.reply).toHaveBeenCalledExactlyOnceWith("reply-once", "Thanks for adding this bot. Staff will approve this group soon.");
});

test("a Project can manage multiple bots and each bot lists only its own groups", async () => {
  const f = await fixture();
  fake.info.mockResolvedValueOnce({ userId: "Usecond", basicId: "@second", displayName: "Second" });
  const second = await f.t.action(api.line.addBot, {
    ...f.add, token: f.token, name: "Second", channelSecret: "second-secret", accessToken: "second-token",
  });
  expect(second.success).toBe(true);
  const bots = await f.t.query(api.line.listBots, { projectId: f.projectId, token: f.token });
  expect(bots.map(bot => bot._id)).toEqual([f.botId, second.botId]);
  expect(bots[0].webhookSlug).not.toBe(bots[1].webhookSlug);
  const otherGroup = { ...group("join", now, "second-group"), source: { type: "group", groupId: "Cother" } };
  expect((await f.send([group(), otherGroup])).status).toBe(200);
  const secondBotGroup = { ...group("join", now, "second-group"), source: { type: "group", groupId: "Csecond" } };
  expect((await f.send([secondBotGroup], "Usecond", "second-secret", bots[1].webhookSlug)).status).toBe(200);
  await f.processEvents();
  const chats = async (botId: typeof f.botId) => {
    const entries = await f.t.query(api.line.listChats, { botId, token: f.token });
    return entries.map(chat => chat.lineChatId).sort();
  };
  expect(await chats(f.botId)).toEqual(["Cgroup", "Cother"]);
  expect(await chats(second.botId)).toEqual(["Csecond"]);
});

test("a bot can use LINE's display name and read the active webhook setting", async () => {
  const f = await fixture();
  fake.info.mockResolvedValueOnce({ userId: "Uoptionalname", basicId: "@optionalname", displayName: "LINE POS Help" });
  fake.setWebhook.mockImplementationOnce(endpoint => {
    fake.webhookSettings.mockResolvedValueOnce({ endpoint, active: false });
    return Promise.resolve({});
  });
  const result = await f.t.action(api.line.addBot, { ...f.add, name: "", token: f.token });
  expect(result).toMatchObject({ success: true, webhookActive: false });
  const bots = await f.t.query(api.line.listBots, { projectId: f.projectId, token: f.token });
  expect(bots.find(bot => bot._id === result.botId)).toMatchObject({ name: "LINE POS Help", webhookActive: false });
});

test("approval validates Project membership, stale events stay ignored, rejoin clears approval", async () => {
  const f = await fixture();
  await f.send([group()]);
  await f.processEvents();
  const chatId = (await f.rows()).chats[0]._id;
  const approve = { token: f.token, chatId, approve: true, joinedAt: now, notify: "all" as const, allowCreate: false,
    displayNameOverride: "Approved group" };
  await expect(f.t.mutation(api.line.updateChat, { ...approve, ownerCustomerId: f.outsider.customerId }))
    .rejects.toThrow("LINE_OWNER_NOT_PROJECT_MEMBER");
  await f.t.mutation(api.line.updateChat, { ...approve, ownerCustomerId: f.customer.customerId });
  expect((await f.rows()).chats[0]).toMatchObject({ state: "active", approvedBy: f.staff.staffId, notify: "all" });
  fake.count.mockResolvedValueOnce({ count: 6 });
  await f.send([group("memberJoined", now + 1)]);
  await f.processEvents();
  expect((await f.rows()).chats[0].memberCount).toBe(6);
  await f.send([group("leave", now + 2)]);
  await f.processEvents();
  expect((await f.rows()).chats[0].state).toBe("left");
  await f.send([group("join", now + 1, "stale")]);
  await f.processEvents();
  expect((await f.rows()).chats[0].state).toBe("left");
  fake.reply.mockRejectedValueOnce(new Error("expired"));
  await f.send([group("join", now + 3, "rejoin")]);
  await f.processEvents();
  const { chats, events } = await f.rows();
  expect(chats[0]).toMatchObject({ state: "pending", notify: "own", allowCreate: true });
  for (const field of ["ownerCustomerId", "approvedAt", "approvedBy", "displayNameOverride"]) {
    expect(chats[0]).not.toHaveProperty(field);
  }
  expect(events.find(event => event.webhookEventId === "rejoin")?.state).toBe("done");
});

test("a stale approval cannot approve a newer enrollment", async () => {
  const f = await fixture();
  await f.send([group()]);
  await f.processEvents();
  const { _id: chatId, joinedAt } = (await f.rows()).chats[0];
  const approve = { token: f.token, chatId, approve: true, joinedAt, notify: "own" as const, allowCreate: true };

  await f.send([group("leave", now + 1)]);
  await f.processEvents();
  await f.send([group("join", now + 2, "rejoin")]);
  await f.processEvents();

  await expect(f.t.mutation(api.line.updateChat, approve)).rejects.toThrow("LINE_CHAT_ENROLLMENT_CHANGED");
  expect((await f.rows()).chats[0]).toMatchObject({ _id: chatId, joinedAt: now + 2, state: "pending" });
  await f.t.mutation(api.line.updateChat, { ...approve, joinedAt: now + 2 });
  expect((await f.rows()).chats[0].state).toBe("active");
});

test("rejoin processed before the preceding leave clears approval and overrides", async () => {
  const f = await fixture();
  await f.send([group()]);
  await f.processEvents();
  const chatId = (await f.rows()).chats[0]._id;
  await f.t.mutation(api.line.updateChat, {
    token: f.token, chatId, approve: true, joinedAt: now, ownerCustomerId: f.customer.customerId,
    notify: "all", allowCreate: false, displayNameOverride: "Approved group",
  });
  await f.send([group("join", now + 2, "rejoin")]);
  await f.processEvents();
  await f.send([group("leave", now + 1)]);
  await f.processEvents();
  const { chats, events } = await f.rows();
  expect(chats[0]).toMatchObject({ state: "pending", joinedAt: now + 2, notify: "own", allowCreate: true });
  for (const field of ["ownerCustomerId", "approvedAt", "approvedBy", "displayNameOverride"]) {
    expect(chats[0]).not.toHaveProperty(field);
  }
  expect(events.find(event => event.webhookEventId === "leave")?.state).toBe("ignored");
});

test("direct chats follow the bot switch and unfollow marks them left", async () => {
  const f = await fixture();
  await f.send([direct("follow")]);
  await f.processEvents();
  expect((await f.rows()).chats[0]).toMatchObject({ state: "pending", name: "Fixture user" });
  await f.t.mutation(api.line.updateBot, { token: f.token, botId: f.botId, allowDirectChats: true });
  await f.send([direct("unfollow", now + 1), direct("follow", now + 1, "Uother")]);
  await f.processEvents();
  const { chats } = await f.rows();
  expect(chats.find(chat => chat.lineChatId === "Ufriend")?.state).toBe("left");
  expect(chats.find(chat => chat.lineChatId === "Uother")?.state).toBe("active");
  expect(fake.reply).not.toHaveBeenCalled();
});

test("every public bot and chat operation rejects customers and anonymous callers", async () => {
  const f = await fixture();
  await f.send([group()]);
  await f.processEvents();
  const { t, botId, projectId } = f;
  const chatId = (await f.rows()).chats[0]._id;
  for (const token of [undefined, f.customer.session]) {
    const operations = [
      () => t.query(api.line.listBots, { token, projectId }),
      () => t.query(api.line.listChats, { token, botId }),
      () => t.action(api.line.addBot, { ...f.add, token }),
      () => t.action(api.line.updateCredentials, { token, botId, channelSecret: "different" }),
      () => t.action(api.line.removeChat, { token, chatId, joinedAt: now }),
      () => t.mutation(api.line.updateBot, { token, botId, enabled: false }),
      () => t.mutation(api.line.updateChat, { token, chatId, approve: true, joinedAt: now, allowCreate: true, notify: "own" }),
      () => t.mutation(api.line.setChatState, { token, chatId, joinedAt: now, state: "rejected" }),
    ];
    for (const operation of operations) await expect(operation()).rejects.toThrow(token ? "STAFF_ONLY" : "SESSION_EXPIRED");
  }
  expect(fake.info).toHaveBeenCalledTimes(1);
  expect(fake.leave).not.toHaveBeenCalled();
  const bots = await t.query(api.line.listBots, { token: f.token, projectId });
  const chats = await t.query(api.line.listChats, { token: f.token, botId });
  expect(bots[0]).toMatchObject({ secretHint: "cret", tokenHint: "oken" });
  expect(f.result).toMatchObject({ endpointSet: true, success: true });
  for (const rows of [bots, chats, [f.result]]) {
    expect(JSON.stringify(rows)).not.toMatch(/secretCipher|tokenCipher|channel-secret|access-token/);
  }
});

test("bot management enforces identity uniqueness and rotates only matching credentials", async () => {
  const f = await fixture();
  const { t, botId, token } = f;
  await expect(t.action(api.line.addBot, { ...f.add, token })).rejects.toThrow("LINE_CHANNEL_ALREADY_CONNECTED");
  const original = (await f.rows()).bot!;
  fake.info.mockResolvedValueOnce({ userId: "Uother" });
  await expect(t.action(api.line.updateCredentials, { token, botId, accessToken: "replacement" })).rejects.toThrow("LINE_TOKEN_BOT_MISMATCH");
  expect((await f.rows()).bot?.tokenCipher).toBe(original.tokenCipher);
  await t.action(api.line.updateCredentials, { token, botId, accessToken: "replacement" });
  expect((await f.rows()).bot?.tokenHint).toBe("ment");
  expect((await f.rows()).bot?.webhookSlug).toBe(original.webhookSlug);
  expect((await f.send([], "Uwrong", undefined, original.webhookSlug)).status).toBe(401);
  expect((await f.send([], "Ubot", "wrong", original.webhookSlug)).status).toBe(401);
  expect((await f.send([group()], "Ubot", undefined, original.webhookSlug)).status).toBe(200);
  await f.processEvents();
  const { _id: chatId, joinedAt } = (await f.rows()).chats[0];
  await t.action(api.line.removeChat, { token, chatId, joinedAt });
  expect(fake.leave).toHaveBeenCalledExactlyOnceWith("group", "Cgroup");
  expect((await f.rows()).chats[0].state).toBe("left");
});

test("a LINE outage while fetching names and counts still enrolls the chat", async () => {
  const f = await fixture();
  fake.groupSummary.mockRejectedValue(new Error("provider failure"));
  fake.count.mockRejectedValue(new Error("provider failure"));
  await f.send([group()]);
  await f.processEvents();
  expect((await f.rows()).events[0]).toMatchObject({ state: "done", attempt: 1 });
  expect((await f.rows()).chats[0]).toMatchObject({ state: "pending", name: "LINE group" });
  expect((await f.rows()).chats[0]).not.toHaveProperty("memberCount");
  expect(fake.reply).toHaveBeenCalledOnce();
});

test("a failed count lookup keeps the member count already known", async () => {
  const f = await fixture();
  await f.send([group()]);
  await f.processEvents();
  expect((await f.rows()).chats[0].memberCount).toBe(5);
  fake.count.mockRejectedValue(new Error("provider failure"));
  await f.send([group("memberJoined", now + 1)]);
  await f.processEvents();
  expect((await f.rows()).chats[0]).toMatchObject({ memberCount: 5, lastMembershipAt: now + 1 });
});

test("processing failures stop after bounded retries and persist a safe error", async () => {
  const f = await fixture();
  await f.send([group()]);
  // A different key cannot open the stored token, so every attempt fails before calling LINE.
  vi.stubEnv("LINE_SECRETS_KEY", Buffer.alloc(32, 2).toString("base64"));
  await f.processEvents();
  for (const delay of [2_001, 4_001]) {
    await vi.advanceTimersByTimeAsync(delay);
    await f.t.finishInProgressScheduledFunctions();
  }
  expect((await f.rows()).events[0]).toMatchObject({
    state: "failed", attempt: 3, error: "LINE_EVENT_PROCESSING_FAILED", payload: {},
  });
  expect(fake.groupSummary).not.toHaveBeenCalled();
  expect(fake.reply).not.toHaveBeenCalled();
});

test("the delayed wakeup recovers an event interrupted before obtaining a lease", async () => {
  const f = await fixture();
  await f.send([group()]);
  await f.t.run(async ctx => {
    const scheduled = await ctx.db.system.query("_scheduled_functions").collect();
    const pending = scheduled.filter(job => job.state.kind === "pending").sort((a, b) => a.scheduledTime - b.scheduledTime);
    expect(pending).toHaveLength(2);
    const [immediate] = pending;
    await ctx.scheduler.cancel(immediate._id);
  });
  await vi.advanceTimersByTimeAsync(45_001);
  await f.t.finishInProgressScheduledFunctions();
  expect((await f.rows()).events[0]).toMatchObject({ state: "done", attempt: 1 });
  expect(fake.reply).toHaveBeenCalledTimes(1);
});

test("setup retries a timed-out PUT with the same webhook URL", async () => {
  fake.setWebhook.mockRejectedValueOnce(new Error("timeout"));
  const f = await fixture();
  expect(f.result).toMatchObject({ success: false, endpointSet: false, reason: "LINE_ENDPOINT_NOT_SET" });
  const original = (await f.rows()).bot!;
  expect(original.state).toBe("setup");
  const endpoint = fake.setWebhook.mock.lastCall![0];
  const retry = await f.t.action(api.line.addBot, { ...f.add, token: f.token });
  expect(retry).toMatchObject({ botId: f.botId, success: true, endpointSet: true });
  expect(fake.testWebhook.mock.calls).toEqual([[endpoint], [endpoint]]);
  expect(fake.setWebhook.mock.calls).toEqual([[endpoint], [endpoint]]);
  expect((await f.rows()).bot).toMatchObject({ webhookSlug: original.webhookSlug, state: "active" });
});

test("incorrect setup secret leaves LINE's endpoint alone and same-Project Add resumes setup", async () => {
  const f = await fixture("mistyped", async (endpoint, probe) => {
    const { status } = await probe(new URL(endpoint).pathname);
    return { success: status === 200, statusCode: status };
  });
  expect(f.result).toMatchObject({ success: false, statusCode: 401 });
  expect((await f.rows()).bot?.state).toBe("setup");
  expect(fake.setWebhook).not.toHaveBeenCalled();
  // Live events before setup settles are retried by LINE, not acknowledged and dropped.
  expect((await f.send([group()], "Ubot", "mistyped")).status).toBe(503);
  expect((await f.rows()).events).toEqual([]);
  const other = await f.t.run(({ db }) => db.insert("projects", { key: "OTHER", name: "Other", createdAt: now, updatedAt: now }));
  // A setup that never verified is not stranded in the Project it was started from.
  await f.t.mutation(api.line.updateBot, { token: f.token, botId: f.botId, allowDirectChats: true });
  const moved = await f.t.action(api.line.addBot, { ...f.add, projectId: other, token: f.token });
  expect(moved).toMatchObject({ botId: f.botId, success: false });
  // The receiving Project starts from defaults, not the previous Project's choices.
  expect((await f.rows()).bot).toMatchObject({ projectId: other, state: "setup", allowDirectChats: false });
  const resumed = await f.t.action(api.line.addBot, { ...f.add, projectId: other, channelSecret: "channel-secret", token: f.token });
  expect(resumed).toMatchObject({ botId: f.botId, success: true, endpointSet: true });
  expect((await f.rows()).bot).toMatchObject({ projectId: other, state: "active" });
  expect(fake.setWebhook).toHaveBeenCalledTimes(1);
  // Once connected, no other Project can take the bot.
  await expect(f.t.action(api.line.addBot, { ...f.add, channelSecret: "channel-secret", token: f.token }))
    .rejects.toThrow("LINE_CHANNEL_ALREADY_CONNECTED");
});

test("credential updates test the new secret while live events use the saved secret", async () => {
  const f = await fixture();
  const update = { botId: f.botId, token: f.token, channelSecret: "corrected-secret" };
  fake.testWebhook.mockImplementationOnce(async () => ({ success: (await f.send([])).status === 200 }));
  await expect(f.t.action(api.line.updateCredentials, update)).rejects.toThrow("LINE_WEBHOOK_TEST_FAILED");
  expect((await f.send([])).status).toBe(200);
  fake.testWebhook.mockImplementationOnce(async () => {
    expect((await f.send([group()])).status).toBe(200);
    // Signed with the secret being saved: LINE is asked to retry, and nothing is stored.
    expect((await f.send([group("join", now, "early")], "Ubot", update.channelSecret)).status).toBe(503);
    return { success: (await f.send([], "Ubot", update.channelSecret)).status === 200 };
  });
  fake.setWebhook.mockRejectedValueOnce(new Error("timeout"));
  await expect(f.t.action(api.line.updateCredentials, update)).rejects.toThrow("LINE_ENDPOINT_NOT_SET");
  // The passing probe proved LINE signs with the new secret, so it is saved even though the PUT timed out.
  expect((await f.send([group("join", now, "after-timeout")], "Ubot", update.channelSecret)).status).toBe(200);
  expect((await f.send([])).status).toBe(401);
  await f.t.action(api.line.updateCredentials, update);
  expect((await f.send([], "Ubot", update.channelSecret)).status).toBe(200);
  expect((await f.send([])).status).toBe(401);
  const endpoint = fake.setWebhook.mock.calls[0][0];
  expect(fake.setWebhook.mock.calls).toEqual([[endpoint], [endpoint], [endpoint]]);
});

test.each(["closed", "admitted", "outside"] as const)("the named pilot blocks LINE intake, claim and settlement (%s)", async mode => {
  const f = await fixture();
  await f.send([group(), group("join", now + 1, "claimed")]);
  const [queued, claimed] = (await f.rows()).events;
  const job = await f.t.mutation(internal.line_jobs.claim, { eventId: claimed._id });
  expect(job).not.toBeNull();
  const epoch = "1".repeat(64), manifestDigest = "2".repeat(64);
  await f.t.run(async ({ db }) => {
    const other = await db.insert("projects", { key: "OTHER", name: "Other", createdAt: now, updatedAt: now });
    await db.insert("pilotRelease", {
      epoch, manifestDigest, deploymentOrigin: process.env.CONVEX_CLOUD_URL!,
      projectIds: [mode === "outside" ? other : f.projectId], ticketDisposalDeadline: now + 60_000,
    });
  });
  for (const [name, value] of Object.entries({
    TICKET_DEPLOYMENT_MODE: "named-pilot", TICKET_PILOT_EPOCH: epoch,
    TICKET_PILOT_MANIFEST_SHA256: manifestDigest, TICKET_PILOT_TRAFFIC: mode === "closed" ? "closed" : "open",
    TICKET_PILOT_INVITATIONS: "false", TICKET_PILOT_IDENTITY_SENDER: "false",
    MEDIA_CLEANUP_ENABLED: "false", LOCAL_FIXTURES_ENABLED: "false",
  })) vi.stubEnv(name, value);

  const lastWebhookAt = (await f.rows()).bot?.lastWebhookAt;
  vi.setSystemTime(now + 1_000);
  expect((await f.send([group("join", now + 1, "denied")])).status).toBe(404);
  expect((await f.rows()).bot?.lastWebhookAt).toBe(lastWebhookAt);
  expect(await f.t.mutation(internal.line_jobs.claim, { eventId: queued._id })).toBeNull();
  expect(await f.t.mutation(internal.line_jobs.finish, { eventId: claimed._id, leaseId: job!.leaseId })).toBe(false);
  const { events, chats } = await f.rows();
  expect(events.map(event => event.state)).toEqual(["ignored", "ignored"]);
  expect(chats).toEqual([]);
  expect(fake.reply).not.toHaveBeenCalled();
  expect(fake.groupSummary).not.toHaveBeenCalled();
});

test("intake retries when credentials change after signature verification", async () => {
  const f = await fixture();
  const bot = (await f.rows()).bot!;
  const newSecretCipher = await sealLineSecret("updated-secret");
  await f.t.run(({ db }) => db.patch(f.botId, { secretCipher: newSecretCipher }));
  const status = await f.t.mutation(internal.line_webhook.accept, {
    botId: f.botId, slug: bot.webhookSlug, destination: bot.lineUserId, verifiedSecretCipher: bot.secretCipher,
    events: [{ webhookEventId: "before-rotation", kind: "group", type: "join", lineChatId: "Cgroup", timestamp: now, payload: {} }],
  });
  expect(status).toBe(503);
  expect((await f.rows()).events).toEqual([]);
});

test("a removal confirmed for an earlier enrollment never makes the bot leave a rejoined group", async () => {
  const f = await fixture();
  await f.send([group()]);
  await f.processEvents();
  const { _id: chatId, joinedAt } = (await f.rows()).chats[0];
  await f.send([group("leave", now + 1)]);
  await f.processEvents();
  await f.send([group("join", now + 2, "rejoin")]);
  await f.processEvents();
  await expect(f.t.action(api.line.removeChat, { token: f.token, chatId, joinedAt }))
    .rejects.toThrow("LINE_CHAT_ENROLLMENT_CHANGED");
  await expect(f.t.mutation(api.line.setChatState, { token: f.token, chatId, joinedAt, state: "rejected" }))
    .rejects.toThrow("LINE_CHAT_ENROLLMENT_CHANGED");
  await expect(f.t.mutation(api.line.updateChat, { token: f.token, chatId, joinedAt, approve: false, notify: "off", allowCreate: false }))
    .rejects.toThrow("LINE_CHAT_ENROLLMENT_CHANGED");
  expect(fake.leave).not.toHaveBeenCalled();
  expect((await f.rows()).chats[0]).toMatchObject({ state: "pending", joinedAt: now + 2 });
});

test("a rejoin recorded while LINE handles the leave is left for LINE's own leave event to settle", async () => {
  const f = await fixture();
  await f.send([group()]);
  await f.processEvents();
  const { _id: chatId, joinedAt } = (await f.rows()).chats[0];
  fake.leave.mockImplementationOnce(async () => {
    await f.t.run(({ db }) => db.patch(chatId, { state: "pending", joinedAt: now + 2, lastEventAt: now + 2 }));
    return {};
  });
  await f.t.action(api.line.removeChat, { token: f.token, chatId, joinedAt });
  expect((await f.rows()).chats[0]).toMatchObject({ state: "pending", joinedAt: now + 2 });
});

test("an interrupted credential update keeps asking LINE to retry after its lease", async () => {
  const f = await fixture();
  const pendingSecretCipher = await sealLineSecret("new-secret");
  await f.t.run(({ db }) => db.patch(f.botId, { pendingSecretCipher, endpointLease: now + 60_000 }));
  vi.setSystemTime(now + 120_000);
  const lastWebhookAt = (await f.rows()).bot?.lastWebhookAt;
  expect((await f.send([group()], "Ubot", "new-secret")).status).toBe(503);
  expect((await f.send([], "Ubot", "new-secret")).status).toBe(200);
  expect((await f.send([group()], "Ubot", "unknown-secret")).status).toBe(401);
  expect((await f.rows()).events).toEqual([]);
  expect((await f.rows()).bot?.lastWebhookAt).toBe(lastWebhookAt);

  // A later attempt that fails restores the interrupted update's secret rather than dropping it.
  fake.testWebhook.mockRejectedValueOnce(new Error("timeout"));
  await expect(f.t.action(api.line.updateCredentials, { token: f.token, botId: f.botId, channelSecret: "typo-secret" }))
    .rejects.toThrow("LINE_WEBHOOK_REQUEST_FAILED");
  expect((await f.send([group()], "Ubot", "new-secret")).status).toBe(503);
  expect((await f.send([group()], "Ubot", "typo-secret")).status).toBe(401);
  expect((await f.rows()).events).toEqual([]);
});

test("a removal keeps LINE's clock, so a rejoin still queued afterwards is enrolled", async () => {
  const f = await fixture();
  await f.send([group()]);
  await f.processEvents();
  const { _id: chatId, joinedAt } = (await f.rows()).chats[0];
  vi.setSystemTime(now + 60_000);
  await f.t.action(api.line.removeChat, { token: f.token, chatId, joinedAt });
  expect((await f.rows()).chats[0].state).toBe("left");
  await f.send([group("join", now + 5, "rejoin")]);
  await f.processEvents();
  expect((await f.rows()).chats[0]).toMatchObject({ state: "pending", joinedAt: now + 5 });
});

test("direct authority follows the signed clock across unfollow, follow and delayed redelivery", async () => {
  const f = await fixture();
  const lifecycle = () => f.t.run(async ctx => currentLineLifecycle(ctx, (await ctx.db.query("lineChats").first())!));
  await f.send([direct("follow")]);
  await f.processEvents();
  expect(await lifecycle()).toBe(true);
  await f.send([direct("unfollow")]);
  expect(await lifecycle()).toBe(false);
  const follow = { ...direct("follow", now + 2), webhookEventId: "follow-again" };
  await f.send([follow]);
  expect(await lifecycle()).toBe(false);
  await f.processEvents();
  await f.send([direct("unfollow"), follow, { ...direct("unfollow", now + 1), webhookEventId: "late" }]);
  expect(await lifecycle()).toBe(true);
});
