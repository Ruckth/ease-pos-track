import { ConvexHttpClient } from "convex/browser";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import { internalJobAction, internalJobMutation } from "./functions";
import { requireLocalFixtures } from "./local_fixtures";

const projectKey = "POS";
const groupId = "Cfixture";

export const group = internalJobMutation({
  name: "line_capture_fixture:group", args: { botId: v.id("lineBots") },
  handler: async (ctx, { botId }) => {
    requireLocalFixtures();
    const bot = await ctx.db.get(botId);
    if (bot?.lineUserId !== "Ufixture-POS") throw new Error("LINE_REPLAY_FIXTURE_BOT_REQUIRED");
    const existing = await ctx.db.query("lineChats").withIndex("by_bot_chat",
      q => q.eq("botId", botId).eq("lineChatId", groupId)).unique();
    if (existing) return existing._id;
    const now = Date.now();
    return ctx.db.insert("lineChats", { botId, projectId: bot.projectId, kind: "group", lineChatId: groupId,
      name: "POS training group", state: "pending", joinedAt: now, lastEventAt: now, allowCreate: true, notify: "off" });
  },
});

/** Prepare the local fixture group through the same staff operations and signed webhook as the app. */
export const seed = internalJobAction({
  name: "line_capture_fixture:seed", args: {},
  handler: async (ctx): Promise<void> => {
    requireLocalFixtures();
    if (process.env.LINE_CAPTURE_ENABLED !== "true" || process.env.LINE_AI_ENABLED === "true") {
      throw new Error("KEYLESS_CAPTURE_FIXTURE_REQUIRED");
    }
    const fixture = await ctx.runMutation(internal.seed.install, {});
    const owner = new ConvexHttpClient(process.env.CONVEX_CLOUD_URL!);
    owner.setAuth(fixture.accessTokens[0]);
    const { slug } = await ctx.runMutation(internal.line_local.seed, { projectKey });
    const bot = await ctx.runMutation(internal.line_local.fixtureBot, { botSelector: slug });
    const chatId = await ctx.runMutation(internal.line_capture_fixture.group, { botId: bot._id });
    const chat = (await owner.query(api.line.listChats, { botId: bot._id })).find(item => item._id === chatId);
    if (!chat) throw new Error("LINE_FIXTURE_CHAT_UNAVAILABLE");
    if (chat.state === "pending") await owner.mutation(api.line.updateChat, {
      chatId, joinedAt: chat.joinedAt, approve: true, notify: "off", allowCreate: true,
    });
    const settings = await owner.query(api.line_capture.settings, { projectId: bot.projectId });
    if (!settings.projectEnabled) await owner.mutation(api.line_capture.setProjectCapture, { projectId: bot.projectId, enabled: true });
    if (!settings.chats.some(item => item.chatId === chatId && item.enabled)) {
      await owner.mutation(api.line_capture.setChatCapture, { chatId, joinedAt: chat.joinedAt, enabled: true });
    }
    const sitePort = Number(new URL(process.env.CONVEX_SITE_URL!).port);
    const timestamp = Date.now();
    // Rehearsals in the same hour can replay the signed deliveries and retain the same Ticket receipts.
    const hour = Math.floor(timestamp / 3_600_000);
    for (const [purpose, text] of [
      ["review", "Receipt preview cuts off the total · ยอดรวมบนใบเสร็จถูกตัด"],
      ["create", "Training checkout displayed the wrong subtotal"],
      ["link", "Training printer repeated the receipt"],
    ]) {
      const key = `fixture-${purpose}-${hour}`;
      const source = { type: "group", groupId, userId: `Ufixture-${purpose}` };
      const events = [
        { type: "message", timestamp, source, webhookEventId: key, message: { type: "text", id: key,
          text: `@POS ${text}`, mention: { mentionees: [{ type: "user", isSelf: true, index: 0, length: 4 }] } } },
        ...["png", "jpeg"].map((format, i) => ({
          type: "message", timestamp: timestamp + i, source, webhookEventId: `${key}-image-${i}`,
          message: { type: "image", id: `fixture-${format}-${key}`, contentProvider: { type: "line" },
            imageSet: { id: key, index: i + 1, total: 2 } },
        })),
      ];
      const delivery = { botSelector: slug, sitePort, fixture: JSON.stringify(events) };
      await ctx.runAction(internal.line_local.replay, delivery);
      await ctx.runAction(internal.line_local.replay, delivery);
    }
  },
});
