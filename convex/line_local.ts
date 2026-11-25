import { v } from "convex/values";
import { internal } from "./_generated/api";
import { localLineFixtureToken } from "./adapters/line";
import { internalJobAction, internalJobMutation } from "./functions";
import { openLineSecret, sealLineSecret } from "./line_crypto";
import { requireLocalFixtures } from "./local_fixtures";

function localSite(sitePort: number) {
  requireLocalFixtures();
  const origin = new URL(process.env.CONVEX_SITE_URL ?? "");
  if (origin.origin !== `http://127.0.0.1:${sitePort}` && origin.origin !== `http://localhost:${sitePort}`) {
    throw new Error("LINE_REPLAY_LOCAL_SITE_REQUIRED");
  }
  return origin.origin;
}

export const seed = internalJobMutation({
  name: "line_local:seed", args: { projectKey: v.string() },
  handler: async (ctx, { projectKey }) => {
    requireLocalFixtures();
    const project = await ctx.db.query("projects").withIndex("by_key", q => q.eq("key", projectKey)).unique();
    if (!project || project.archivedAt !== undefined) throw new Error("PROJECT_NOT_FOUND");
    const lineUserId = `Ufixture-${projectKey}`;
    const existing = await ctx.db.query("lineBots").withIndex("by_line_user", q => q.eq("lineUserId", lineUserId)).unique();
    if (existing) return { name: existing.name, slug: existing.webhookSlug };
    const webhookSlug = crypto.randomUUID();
    const secret = crypto.randomUUID();
    const now = Date.now();
    const name = `Replay bot ${projectKey}`;
    await ctx.db.insert("lineBots", {
      projectId: project._id, lineUserId, name, locale: "th", webhookSlug,
      basicId: `@fixture-${projectKey}`, displayName: name,
      secretCipher: await sealLineSecret(secret), secretHint: secret.slice(-4),
      tokenCipher: await sealLineSecret(localLineFixtureToken), tokenHint: localLineFixtureToken.slice(-4),
      state: "active", allowDirectChats: false, createdAt: now, updatedAt: now, signatureFailures: 0,
    });
    return { name, slug: webhookSlug };
  },
});

export const fixtureBot = internalJobMutation({
  name: "line_local:fixtureBot", args: { botSelector: v.string() },
  handler: async (ctx, { botSelector }) => {
    requireLocalFixtures();
    const matches = await ctx.db.query("lineBots").filter(q => q.or(
      q.eq(q.field("name"), botSelector), q.eq(q.field("webhookSlug"), botSelector),
    )).take(2);
    if (matches.length !== 1 || !matches[0].lineUserId.startsWith("Ufixture-")) throw new Error("LINE_REPLAY_FIXTURE_BOT_REQUIRED");
    return matches[0];
  },
});

export const replay = internalJobAction({
  name: "line_local:replay", args: { sitePort: v.number(), botSelector: v.string(), fixture: v.string() },
  handler: async (ctx, { sitePort, botSelector, fixture }): Promise<{ status: number }> => {
    const origin = localSite(sitePort);
    const bot = await ctx.runMutation(internal.line_local.fixtureBot, { botSelector });
    const events: unknown = JSON.parse(fixture);
    if (!Array.isArray(events)) throw new Error("LINE_REPLAY_EXPECTED_EVENTS");
    const body = JSON.stringify({ destination: bot.lineUserId, events });
    const encode = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encode.encode(await openLineSecret(bot.secretCipher)),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encode.encode(body)));
    const response = await fetch(`${origin}/line/webhook/${bot.webhookSlug}`, {
      method: "POST", redirect: "error", headers: {
        "Content-Type": "application/json", "x-line-signature": btoa(String.fromCharCode(...mac)),
      }, body,
    });
    if (!response.ok) throw new Error("LINE_REPLAY_WEBHOOK_REJECTED");
    return { status: response.status };
  },
});
