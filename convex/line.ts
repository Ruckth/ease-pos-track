import { v } from "convex/values";
import type { Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { assertStaffActor } from "./authz";
import { createLine } from "./adapters/line";
import { currentAssistantOptIn, lineBot, lineChat, lineProject, publicBot, webhookUrl } from "./domain/line";
import { currentLineLifecycle } from "./domain/line_ai_review";
import { lineAiReleaseEnabled, readLineAiConnection } from "./domain/line_ai_settings";
import { staffQuery, staffMutation, internalActorMutation, lineStaffAction } from "./functions";
import { openLineSecret, sealLineSecret } from "./line_crypto";
import { botInfo, locale, notify } from "./line_schema";

const project = { projectId: v.id("projects") };
const bot = { botId: v.id("lineBots") };
const chat = { chatId: v.id("lineChats") };

export const listBots = staffQuery({
  name: "line:listBots", args: project,
  handler: async (ctx, { projectId }) => {
    await lineProject(ctx, projectId);
    return (await ctx.db.query("lineBots").withIndex("by_project", q => q.eq("projectId", projectId)).collect()).map(publicBot);
  },
});

export const listChats = staffQuery({
  name: "line:listChats", args: bot,
  handler: async (ctx, { botId }) => {
    const current = await lineBot(ctx, botId);
    const project = await ctx.db.get(current.projectId);
    const chats = await ctx.db.query("lineChats").withIndex("by_bot_chat", q => q.eq("botId", botId)).collect();
    return chats.map(chat => ({
      ...chat, assistantEnabled: currentAssistantOptIn(chat, current.assistantRevision ?? 0, project?.inboxVisibilityVersion ?? 0),
    }));
  },
});

export const updateBot = staffMutation({
  name: "line:updateBot",
  args: { ...bot, locale: v.optional(locale), allowDirectChats: v.optional(v.boolean()), enabled: v.optional(v.boolean()) },
  handler: async (ctx, { botId, enabled, ...settings }) => {
    const current = await lineBot(ctx, botId);
    if (enabled !== undefined && current.state === "setup") throw new Error("LINE_SETUP_REQUIRED");
    const state = enabled === undefined ? current.state : enabled ? "active" : "disabled";
    await ctx.db.patch(botId, {
      ...settings, state, updatedAt: Date.now(),
      ...(state === current.state ? {} : { assistantRevision: (current.assistantRevision ?? 0) + 1 }),
    });
  },
});

const chatSettings = {
  ownerCustomerId: v.optional(v.id("customers")), displayNameOverride: v.optional(v.string()),
  notify, allowCreate: v.boolean(),
};

export const updateChat = staffMutation({
  name: "line:updateChat",
  args: { ...chat, ...chatSettings, approve: v.boolean(), joinedAt: v.number() },
  handler: async (ctx, { chatId, approve, joinedAt, ownerCustomerId, displayNameOverride, ...settings }) => {
    const current = await lineChat(ctx, chatId);
    if (current.joinedAt !== joinedAt) throw new Error("LINE_CHAT_ENROLLMENT_CHANGED");
    if (approve ? current.state !== "pending" : !["active", "muted"].includes(current.state)) {
      throw new Error("LINE_CHAT_STATE_CHANGED");
    }
    if (ownerCustomerId && !await ctx.db.query("projectMembers").withIndex("by_project",
      q => q.eq("projectId", current.projectId).eq("customerId", ownerCustomerId)).unique()) {
      throw new Error("LINE_OWNER_NOT_PROJECT_MEMBER");
    }
    const approvedBy = ctx.actor.staffId && ctx.db.normalizeId("staff", ctx.actor.staffId);
    if (approve && !approvedBy) throw new Error("NAMED_STAFF_REQUIRED");
    await ctx.db.patch(chatId, {
      ...settings, ownerCustomerId, displayNameOverride: displayNameOverride?.trim().slice(0, 120) || undefined,
      ...(current.ownerCustomerId === ownerCustomerId && current.allowCreate === settings.allowCreate ? {}
        : { assistantRevision: (current.assistantRevision ?? 0) + 1 }),
      ...(approve ? { state: "active" as const, approvedAt: Date.now(), approvedBy: approvedBy || undefined } : {}),
    });
  },
});

export const setChatState = staffMutation({
  name: "line:setChatState",
  args: { ...chat, joinedAt: v.number(), state: v.union(v.literal("rejected"), v.literal("muted"), v.literal("active")) },
  handler: async (ctx, { chatId, joinedAt, state }) => {
    const current = await lineChat(ctx, chatId);
    if (current.joinedAt !== joinedAt) throw new Error("LINE_CHAT_ENROLLMENT_CHANGED");
    const expected = { rejected: "pending", muted: "active", active: "muted" } as const;
    if (current.state !== expected[state]) throw new Error("LINE_CHAT_STATE_CHANGED");
    await ctx.db.patch(chatId, {
      state, assistantEnabled: false, assistantEnabledAt: undefined, assistantOptIn: undefined,
      assistantRevision: (current.assistantRevision ?? 0) + 1,
    });
  },
});

export const setAssistantEnabled = staffMutation({
  name: "line:setAssistantEnabled",
  args: { ...chat, joinedAt: v.number(), enabled: v.boolean() },
  handler: async (ctx, { chatId, joinedAt, enabled }) => {
    const current = await lineChat(ctx, chatId);
    if (current.joinedAt !== joinedAt) throw new Error("LINE_CHAT_ENROLLMENT_CHANGED");
    let assistantOptIn;
    if (enabled) {
      const bot = await lineBot(ctx, current.botId);
      const project = await lineProject(ctx, current.projectId);
      if (bot.state !== "active" || current.state !== "active" || !await currentLineLifecycle(ctx, current)) {
        throw new Error("LINE_CHAT_STATE_CHANGED");
      }
      const connection = await readLineAiConnection(ctx, current.projectId);
      if (!await lineAiReleaseEnabled(ctx) || !connection?.enabled) throw new Error("LINE_AI_CONNECTION_REQUIRED");
      const botRevision = bot.assistantRevision ?? 0;
      const projectVisibilityVersion = project.inboxVisibilityVersion ?? 0;
      if (currentAssistantOptIn(current, botRevision, projectVisibilityVersion)) return;
      assistantOptIn = { botRevision, projectVisibilityVersion };
    } else if (!current.assistantEnabled) {
      return;
    }
    await ctx.db.patch(chatId, {
      assistantEnabled: enabled, assistantRevision: (current.assistantRevision ?? 0) + 1,
      assistantEnabledAt: enabled ? Date.now() : undefined, assistantOptIn,
    });
  },
});

const credentials = { tokenCipher: v.string(), tokenHint: v.string() };
const createFields = {
  ...project, ...botInfo, ...credentials, name: v.string(), locale,
  secretCipher: v.string(), secretHint: v.string(),
};

export const permitAdd = internalActorMutation({
  name: "line:permitAdd", args: project,
  handler: async (ctx, { projectId }) => {
    assertStaffActor(ctx.actor);
    await lineProject(ctx, projectId);
  },
});

export const insertBot = internalActorMutation({
  name: "line:insertBot", args: createFields,
  handler: async (ctx, fields) => {
    assertStaffActor(ctx.actor);
    await lineProject(ctx, fields.projectId);
    const existing = await ctx.db.query("lineBots").withIndex("by_line_user", q => q.eq("lineUserId", fields.lineUserId)).unique();
    const now = Date.now();
    const endpointLease = now + 60_000;
    if (existing) {
      // A never-verified setup holds no chats or events. Whoever proves the token again may finish it,
      // in any Project, so a setup started in the wrong Project is not stranded there.
      if (existing.state !== "setup") throw new Error("LINE_CHANNEL_ALREADY_CONNECTED");
      if ((existing.endpointLease ?? 0) > now) throw new Error("LINE_ENDPOINT_BUSY");
      // A Project that takes over a setup starts from defaults, not the previous Project's choices.
      const moved = existing.projectId !== fields.projectId
        ? { allowDirectChats: false, signatureFailures: 0, lastError: undefined } : {};
      await ctx.db.patch(existing._id, { ...fields, ...moved, endpointLease, updatedAt: now });
      return { botId: existing._id, webhookSlug: existing.webhookSlug, endpointLease };
    }
    const webhookSlug = await newSlug(ctx);
    const botId = await ctx.db.insert("lineBots", {
      ...fields, webhookSlug, endpointLease, createdAt: now, updatedAt: now,
      signatureFailures: 0, state: "setup", allowDirectChats: false,
    });
    return { botId, webhookSlug, endpointLease };
  },
});

async function newSlug(ctx: Pick<import("./_generated/server").MutationCtx, "db">) {
  const slug = crypto.randomUUID();
  if (await ctx.db.query("lineBots").withIndex("by_slug", q => q.eq("webhookSlug", slug)).unique()) {
    throw new Error("LINE_SLUG_COLLISION");
  }
  return slug;
}

export const prepareBot = internalActorMutation({
  name: "line:prepareBot", args: bot,
  handler: async (ctx, { botId }) => {
    assertStaffActor(ctx.actor);
    return lineBot(ctx, botId);
  },
});

const endpointResult = v.object({
  endpointSet: v.boolean(), success: v.boolean(), statusCode: v.optional(v.number()), reason: v.optional(v.string()),
  webhookActive: v.optional(v.boolean()),
});

export const finishEndpoint = internalActorMutation({
  name: "line:finishEndpoint",
  args: { ...bot, endpointLease: v.number(), result: endpointResult },
  handler: async (ctx, { botId, endpointLease, result }) => {
    assertStaffActor(ctx.actor);
    const current = await lineBot(ctx, botId);
    if (current.endpointLease !== endpointLease || endpointLease <= Date.now()) throw new Error("LINE_ENDPOINT_CHANGED");
    await ctx.db.patch(botId, {
      endpointLease: undefined, updatedAt: Date.now(),
      state: current.state === "setup" && result.success ? "active" : current.state,
      lastError: result.success ? undefined : result.reason ?? "LINE_WEBHOOK_TEST_FAILED",
      ...(result.webhookActive === undefined ? {} : { webhookActive: result.webhookActive }),
    });
  },
});

const webhookTestReasons = new Set(["COULD_NOT_CONNECT", "REQUEST_TIMEOUT", "ERROR_STATUS_CODE", "UNCLASSIFIED"]);

async function testEndpoint(line: ReturnType<typeof createLine>, endpoint: string): Promise<Infer<typeof endpointResult>> {
  if (!endpoint.startsWith("https://") || endpoint.length > 500) {
    return { endpointSet: false, success: false, reason: "LINE_WEBHOOK_HTTPS_REQUIRED" };
  }
  try {
    const test = await line.testWebhook(endpoint);
    return { endpointSet: false, success: test.success, statusCode: test.statusCode,
      reason: test.reason && webhookTestReasons.has(test.reason) ? test.reason
        : test.success ? undefined : "LINE_WEBHOOK_TEST_FAILED" };
  } catch (error) {
    return { endpointSet: false, success: false,
      reason: error instanceof Error && error.message === "LINE_API_RATE_LIMITED"
        ? error.message : "LINE_WEBHOOK_REQUEST_FAILED" };
  }
}

async function configureEndpoint(line: ReturnType<typeof createLine>, endpoint: string) {
  const result = await testEndpoint(line, endpoint);
  if (!result.success) return result;
  try {
    await line.setWebhook(endpoint);
    const settings = await line.webhookSettings().catch(() => undefined);
    return { ...result, endpointSet: true, webhookActive: settings?.endpoint === endpoint ? settings.active : undefined };
  } catch (error) {
    return { ...result, success: false, reason: error instanceof Error && error.message === "LINE_API_RATE_LIMITED"
      ? error.message : "LINE_ENDPOINT_NOT_SET" };
  }
}

export const addBot = lineStaffAction({
  name: "line:addBot",
  args: { ...project, name: v.string(), channelSecret: v.string(), accessToken: v.string(), locale: v.optional(locale) },
  handler: async (ctx, args): Promise<Infer<typeof endpointResult> & { botId: Id<"lineBots"> }> => {
    await ctx.runMutation(internal.line.permitAdd, { projectId: args.projectId });
    const { projectId, locale = "th" } = args;
    const name = args.name.trim();
    const secret = args.channelSecret.trim(), token = args.accessToken.trim();
    if (name.length > 120
      || secret.length < 4 || secret.length > 256 || token.length < 4 || token.length > 2048) {
      throw new Error("LINE_BOT_FIELDS_INVALID");
    }
    const [secretCipher, tokenCipher] = await Promise.all([sealLineSecret(secret), sealLineSecret(token)]);
    const line = createLine(token);
    const { userId, basicId, displayName, pictureUrl } = await line.info();
    const current = await ctx.runMutation(internal.line.insertBot, {
      projectId, locale, name: name || displayName.trim().slice(0, 120) || basicId, lineUserId: userId, basicId, displayName, pictureUrl,
      secretCipher, tokenCipher, secretHint: secret.slice(-4), tokenHint: token.slice(-4),
    });
    const result = await configureEndpoint(line, webhookUrl(current.webhookSlug));
    await ctx.runMutation(internal.line.finishEndpoint, { botId: current.botId, endpointLease: current.endpointLease, result });
    return { botId: current.botId, ...result };
  },
});

const credentialChanges = { ...credentials, secretCipher: v.string(), secretHint: v.string() };

export const prepareCredentials = internalActorMutation({
  name: "line:prepareCredentials",
  args: { ...bot, previousTokenCipher: v.string(), previousSecretCipher: v.string(), pendingSecretCipher: v.string() },
  handler: async (ctx, { botId, previousTokenCipher, previousSecretCipher, pendingSecretCipher }) => {
    assertStaffActor(ctx.actor);
    const current = await lineBot(ctx, botId);
    if (current.tokenCipher !== previousTokenCipher || current.secretCipher !== previousSecretCipher
      || (current.endpointLease ?? 0) > Date.now()) throw new Error("LINE_BOT_CHANGED");
    if (current.state === "setup") throw new Error("LINE_SETUP_REQUIRED");
    const endpointLease = Date.now() + 60_000;
    await ctx.db.patch(botId, { pendingSecretCipher, endpointLease });
    // An earlier interrupted update's secret is restored if this attempt fails.
    return { endpointLease, earlierPending: current.pendingSecretCipher };
  },
});

export const finishCredentials = internalActorMutation({
  name: "line:finishCredentials",
  args: { ...bot, endpointLease: v.number(), fields: v.optional(v.object(credentialChanges)), earlierPending: v.optional(v.string()) },
  handler: async (ctx, { botId, endpointLease, fields, earlierPending }) => {
    assertStaffActor(ctx.actor);
    const current = await lineBot(ctx, botId);
    if (current.endpointLease !== endpointLease || endpointLease <= Date.now()) throw new Error("LINE_BOT_CHANGED");
    await ctx.db.patch(botId, {
      ...fields, pendingSecretCipher: fields ? undefined : earlierPending, endpointLease: undefined, updatedAt: Date.now(),
    });
  },
});

async function changeCredentials(ctx: import("./_generated/server").ActionCtx,
  { botId, accessToken, channelSecret }: { botId: Id<"lineBots">; accessToken?: string; channelSecret?: string }): Promise<void> {
  const current = await ctx.runMutation(internal.line.prepareBot, { botId });
  const token = accessToken?.trim() ?? await openLineSecret(current.tokenCipher);
  const secret = channelSecret?.trim() ?? await openLineSecret(current.secretCipher);
  if ((!accessToken && !channelSecret) || token.length < 4 || token.length > 2048 || secret.length < 4 || secret.length > 256) {
    throw new Error("LINE_BOT_FIELDS_INVALID");
  }
  const line = createLine(token);
  if ((await line.info()).userId !== current.lineUserId) throw new Error("LINE_TOKEN_BOT_MISMATCH");
  const endpoint = webhookUrl(current.webhookSlug);
  const [tokenCipher, secretCipher] = await Promise.all([sealLineSecret(token), sealLineSecret(secret)]);
  const { endpointLease, earlierPending } = await ctx.runMutation(internal.line.prepareCredentials, {
    botId, previousTokenCipher: current.tokenCipher, previousSecretCipher: current.secretCipher, pendingSecretCipher: secretCipher,
  });
  const test = await testEndpoint(line, endpoint);
  // A passing probe proves LINE signs with the candidate secret, so save it before the idempotent PUT.
  await ctx.runMutation(internal.line.finishCredentials, {
    botId, endpointLease, earlierPending, fields: test.success
      ? { tokenCipher, secretCipher, tokenHint: token.slice(-4), secretHint: secret.slice(-4) } : undefined,
  });
  if (!test.success) throw new Error(test.reason ?? "LINE_WEBHOOK_TEST_FAILED");
  try { await line.setWebhook(endpoint); }
  catch (error) {
    throw new Error(error instanceof Error && error.message === "LINE_API_RATE_LIMITED" ? error.message : "LINE_ENDPOINT_NOT_SET");
  }
}

export const updateCredentials = lineStaffAction({
  name: "line:updateCredentials",
  args: { ...bot, accessToken: v.optional(v.string()), channelSecret: v.optional(v.string()) },
  handler: changeCredentials,
});

export const manageRemoval = internalActorMutation({
  name: "line:manageRemoval", args: { ...chat, joinedAt: v.number(), expectedEventAt: v.optional(v.number()) },
  handler: async (ctx, { chatId, joinedAt, expectedEventAt }) => {
    assertStaffActor(ctx.actor);
    const current = await lineChat(ctx, chatId);
    const bot = await lineBot(ctx, current.botId);
    if (expectedEventAt === undefined) {
      // The confirmation applies to the enrollment staff saw, never to a later rejoin.
      if (current.joinedAt !== joinedAt) throw new Error("LINE_CHAT_ENROLLMENT_CHANGED");
      return { current, tokenCipher: bot.tokenCipher };
    }
    // LINE already handled the leave. If events arrived meanwhile, LINE's own leave event settles the chat.
    if (current.lastEventAt !== expectedEventAt) return null;
    // lastEventAt stays on LINE's clock, so a rejoin still queued here is not mistaken for a stale event.
    if (current.state !== "left") await ctx.db.patch(chatId, {
      state: "left", leftAt: Date.now(), assistantEnabled: false, assistantEnabledAt: undefined, assistantOptIn: undefined,
      assistantRevision: (current.assistantRevision ?? 0) + 1,
    });
    return null;
  },
});

export const removeChat = lineStaffAction({
  name: "line:removeChat", args: { ...chat, joinedAt: v.number() },
  handler: async (ctx, { chatId, joinedAt }): Promise<void> => {
    const prepared = await ctx.runMutation(internal.line.manageRemoval, { chatId, joinedAt });
    if (!prepared || prepared.current.state === "left") return;
    const { kind, lineChatId, lastEventAt } = prepared.current;
    if (kind !== "user") await createLine(await openLineSecret(prepared.tokenCipher)).leave(kind, lineChatId);
    await ctx.runMutation(internal.line.manageRemoval, { chatId, joinedAt, expectedEventAt: lastEventAt });
  },
});
