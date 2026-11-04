import type { MutationCtx, QueryCtx } from "./_generated/server";
import { actorFromSession } from "./authz";

export async function requireSession(ctx: QueryCtx | MutationCtx, token: string) {
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();

  if (!session || session.expiresAt <= Date.now()) {
    throw new Error("SESSION_EXPIRED");
  }

  return session;
}

/**
 * Resolves the session and the actor behind it. Sessions without a role predate
 * the customer portal and resolve to staff.
 */
export async function requireActor(ctx: QueryCtx | MutationCtx, token: string) {
  const session = await requireSession(ctx, token);
  return { session, actor: actorFromSession(session) };
}
