import type { MutationCtx, QueryCtx } from "./_generated/server";
import { actorFromSession } from "./authz";

async function requireSession(ctx: QueryCtx | MutationCtx, token: string) {
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();

  if (!session || session.expiresAt <= Date.now()) {
    throw new Error("SESSION_EXPIRED");
  }

  return session;
}

export async function requireActor(ctx: QueryCtx | MutationCtx, token: string) {
  const session = await requireSession(ctx, token);
  const actor = actorFromSession(session);
  if (actor.role === "customer" && !(await ctx.db.get(actor.customerId))) throw new Error("SESSION_EXPIRED");
  return { session, actor };
}
