import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { LineAiProvider } from "../adapters/line_ai_provider";
import { assertOwnerActor, type Actor } from "../authz";
import { openLineSecret, sealLineSecret } from "../line_crypto";
import { hasLegacyAccess } from "../pilot_access";
import { lineProject } from "./line";

type DbContext = Pick<QueryCtx, "db">;

/**
 * External AI calls run only on legacy or disposable deployments with
 * LINE_AI_ENABLED exactly "true". The named-account pilot always returns false.
 */
export async function lineAiReleaseEnabled(ctx: DbContext) {
  return process.env.LINE_AI_ENABLED === "true" && await hasLegacyAccess(ctx);
}

/** The stored connection row, including keyCipher; never return it to a browser. */
export async function readLineAiConnection(ctx: DbContext, projectId: Id<"projects">) {
  return await ctx.db.query("lineAiConnections").withIndex("by_project", q => q.eq("projectId", projectId)).unique();
}

/** Owner of a current Project on a deployment where LINE is available. */
export async function lineAiOwnerProject(ctx: DbContext & { actor: Actor }, projectId: Id<"projects">) {
  assertOwnerActor(ctx.actor);
  await lineProject(ctx, projectId);
}

export function publicLineAiConnection(row: Doc<"lineAiConnections"> | null) {
  if (!row) return null;
  const { provider, model, enabled, keyHint, revision, testedAt, updatedAt } = row;
  return { provider, model, enabled: enabled && row.keyCipher !== undefined, keyHint: keyHint ?? null,
    revision, testedAt: testedAt ?? null, updatedAt };
}

/** Binds the key to its Project and provider so a ciphertext cannot be replayed into another row. */
export async function sealLineAiKey(projectId: Id<"projects">, provider: LineAiProvider, apiKey: string) {
  return await sealLineSecret(JSON.stringify({ projectId, provider, apiKey }));
}

/** Worker seam: opens an enabled connection's key, or throws LINE_AI_NOT_CONFIGURED. */
export async function openLineAiKey(row: Pick<Doc<"lineAiConnections">, "projectId" | "provider" | "keyCipher" | "enabled">) {
  if (!row.enabled || !row.keyCipher) throw new Error("LINE_AI_NOT_CONFIGURED");
  let sealed: unknown;
  try { sealed = JSON.parse(await openLineSecret(row.keyCipher)); }
  catch { throw new Error("LINE_AI_KEY_UNREADABLE"); }
  const { projectId, provider, apiKey } = (sealed ?? {}) as Record<string, unknown>;
  if (projectId !== row.projectId || provider !== row.provider || typeof apiKey !== "string") {
    throw new Error("LINE_AI_KEY_UNREADABLE");
  }
  return apiKey;
}
