import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import type { Actor } from "./authz";
import { lineAiModels, scanLineRequest, syntheticLineAiInput } from "./adapters/line_ai_provider";
import { lineProject } from "./domain/line";
import {
  lineAiOwnerProject, lineAiReleaseEnabled, publicLineAiConnection, readLineAiConnection, sealLineAiKey,
} from "./domain/line_ai_settings";
import { internalActorMutation, lineStaffAction, ownerMutation, staffQuery } from "./functions";
import { lineAiProvider } from "./line_ai_provider_schema";

const project = { projectId: v.id("projects") };

/** Safe summary for staff: never the key or its ciphertext. */
export const get = staffQuery({
  name: "line_ai_settings:get", args: project,
  handler: async (ctx, { projectId }) => {
    await lineProject(ctx, projectId);
    return {
      releaseEnabled: await lineAiReleaseEnabled(ctx),
      canManage: ctx.actor.role === "staff" && ctx.actor.staffRole === "owner",
      models: lineAiModels,
      connection: publicLineAiConnection(await readLineAiConnection(ctx, projectId)),
    };
  },
});

function editor(ctx: Pick<MutationCtx, "db"> & { actor: Actor }) {
  return (ctx.actor.staffId && ctx.db.normalizeId("staff", ctx.actor.staffId)) || undefined;
}

async function recordConnectionChange(ctx: Pick<MutationCtx, "db">, connectionId: Id<"lineAiConnections">,
  action: Doc<"lineAiConnectionEvents">["action"]) {
  const row = await ctx.db.get(connectionId);
  if (!row) throw new Error("LINE_AI_NOT_CONFIGURED");
  const { projectId, provider, model, revision, enabled, updatedAt, updatedBy } = row;
  await ctx.db.insert("lineAiConnectionEvents", {
    projectId, provider, model, revision, enabled, action, createdAt: updatedAt, staffId: updatedBy,
  });
  return publicLineAiConnection(row);
}

export const disable = ownerMutation({
  name: "line_ai_settings:disable", args: project,
  handler: async (ctx, { projectId }) => {
    await lineAiOwnerProject(ctx, projectId);
    const row = await readLineAiConnection(ctx, projectId);
    if (!row) return null;
    // The key is discarded; enabling again requires a new tested key.
    await ctx.db.patch(row._id, {
      enabled: false, keyCipher: undefined, keyHint: undefined, revision: row.revision + 1,
      authorizationRevision: (row.authorizationRevision ?? 0) + 1,
      updatedAt: Date.now(), updatedBy: editor(ctx),
    });
    return recordConnectionChange(ctx, row._id, "disconnected");
  },
});

export const setPaused = ownerMutation({
  name: "line_ai_settings:setPaused",
  args: { ...project, paused: v.boolean(), expectedRevision: v.number() },
  handler: async (ctx, { projectId, paused, expectedRevision }) => {
    await lineAiOwnerProject(ctx, projectId);
    if (!paused && !await lineAiReleaseEnabled(ctx)) throw new Error("LINE_AI_DISABLED");
    const row = await readLineAiConnection(ctx, projectId);
    if (!row?.keyCipher) throw new Error("LINE_AI_NOT_CONFIGURED");
    if (row.revision !== expectedRevision) throw new Error("LINE_AI_CONNECTION_CHANGED");
    if (row.enabled !== paused) return publicLineAiConnection(row);
    await ctx.db.patch(row._id, {
      enabled: !paused, revision: row.revision + 1, updatedAt: Date.now(), updatedBy: editor(ctx),
      authorizationRevision: (row.authorizationRevision ?? 0) + 1,
    });
    return recordConnectionChange(ctx, row._id, paused ? "paused" : "resumed");
  },
});

async function permitTest(ctx: Parameters<typeof lineAiOwnerProject>[0], projectId: Id<"projects">) {
  await lineAiOwnerProject(ctx, projectId);
  if (!await lineAiReleaseEnabled(ctx)) throw new Error("LINE_AI_DISABLED");
}

export const beginTest = internalActorMutation({
  name: "line_ai_settings:beginTest", args: project,
  handler: async (ctx, { projectId }) => {
    await permitTest(ctx, projectId);
    return { revision: (await readLineAiConnection(ctx, projectId))?.revision ?? 0 };
  },
});

export const commitTest = internalActorMutation({
  name: "line_ai_settings:commitTest",
  args: { ...project, provider: lineAiProvider, model: v.string(), keyCipher: v.string(), keyHint: v.string(), expectedRevision: v.number() },
  handler: async (ctx, { projectId, expectedRevision, ...fields }) => {
    await permitTest(ctx, projectId);
    const row = await readLineAiConnection(ctx, projectId);
    // A change made while the test ran wins; this result is discarded.
    if ((row?.revision ?? 0) !== expectedRevision) throw new Error("LINE_AI_CONNECTION_CHANGED");
    const now = Date.now();
    const next = {
      ...fields, enabled: row?.keyCipher ? row.enabled : true, revision: expectedRevision + 1,
      testedAt: now, updatedAt: now, updatedBy: editor(ctx),
    };
    if (row) {
      await ctx.db.patch(row._id, next);
      return recordConnectionChange(ctx, row._id, "saved");
    }
    const connectionId = await ctx.db.insert("lineAiConnections", { projectId, ...next });
    return recordConnectionChange(ctx, connectionId, "saved");
  },
});

/** Owner-only: proves the key with one synthetic text, image and PDF request, then saves it. */
export const testAndSave = lineStaffAction({
  name: "line_ai_settings:testAndSave",
  args: { ...project, provider: lineAiProvider, apiKey: v.string() },
  handler: async (ctx, { projectId, provider, apiKey }): Promise<ReturnType<typeof publicLineAiConnection>> => {
    const { revision } = await ctx.runMutation(internal.line_ai_settings.beginTest, { projectId });
    const key = apiKey.trim();
    if (key.length < 8 || key.length > 512 || !/^[\x21-\x7e]+$/.test(key)) throw new Error("LINE_AI_KEY_INVALID");
    const model = lineAiModels[provider];
    // A failed test throws a stable code and leaves the saved connection untouched.
    await scanLineRequest({ provider, model, apiKey: key }, syntheticLineAiInput());
    return await ctx.runMutation(internal.line_ai_settings.commitTest, {
      projectId, provider, model, keyCipher: await sealLineAiKey(projectId, provider, key), keyHint: key.slice(-4),
      expectedRevision: revision,
    });
  },
});
