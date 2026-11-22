import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { components } from "./_generated/api";
import { actorFromAdmission } from "./identity_rules";
import { namedIdentityEpoch, requireNamedEpoch } from "./pilot_access";
import { customerCredentialIsCurrent, identityRecoveryAdmission } from "./identity_recovery_access";

type Ctx = QueryCtx | MutationCtx;

/**
 * The live Convex Auth session behind the caller's verified JWT and the
 * admission row a verified sign-in completion wrote for it. The JWT subject is
 * the core session ID; a revoked or expired session has no row.
 */
export async function liveAdmission(ctx: Ctx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  const session = await ctx.runQuery(components.auth.public.getSession, { sessionId: identity.subject });
  const pilot = await identityRecoveryAdmission(ctx);
  const row = await ctx.db.query("sessionAdmissions")
    .withIndex("by_auth_session", (q) => q.eq("authSessionId", identity.subject)).unique();
  const admission = row?.pilotEpoch === pilot?.epoch ? row : null;
  return { authSessionId: identity.subject, sessionUserId: session?.userId ?? null, admission };
}

/** Every protected browser call: live session, admission, active principal at its generation. */
export async function requireActor(ctx: Ctx, options?: { allowRecoveryEnrollment?: boolean }) {
  const epoch = await namedIdentityEpoch(ctx);
  const live = await liveAdmission(ctx);
  const admission = live?.admission ?? null;
  const staff = admission?.staffId ? await ctx.db.get(admission.staffId) : null;
  const customer = admission?.customerId ? await ctx.db.get(admission.customerId) : null;
  const actor = actorFromAdmission<Id<"staff">, Id<"customers">>({
    sessionUserId: live?.sessionUserId ?? null, admission, staff, customer,
  });
  // A pilot admits only sessions issued under the current epoch, for a
  // principal reconciled into it. Missing lineage fails like stale lineage.
  requireNamedEpoch(admission!.pilotEpoch, epoch);
  requireNamedEpoch((staff ?? customer)?.pilotEpoch, epoch);
  if (customer && !customerCredentialIsCurrent(customer, await identityRecoveryAdmission(ctx))) throw new Error("SESSION_EXPIRED");
  if (customer?.recoveryEnrollmentRequired && !options?.allowRecoveryEnrollment) throw new Error("RECOVERY_ENROLLMENT_REQUIRED");
  return { actor, session: admission as Doc<"sessionAdmissions"> };
}

/** A signed-in Google identity that is not yet bound to staff. */
export async function requirePendingIdentity(ctx: Ctx) {
  const epoch = await namedIdentityEpoch(ctx);
  const live = await liveAdmission(ctx);
  const admission = live?.admission;
  if (!live?.sessionUserId || !admission || admission.revokedAt !== undefined
    || admission.userId !== live.sessionUserId || admission.principal !== "pending") throw new Error("SESSION_EXPIRED");
  const user = await ctx.db.get(admission.userId);
  if (!user || user.kind !== "pending") throw new Error("SESSION_EXPIRED");
  requireNamedEpoch(admission.pilotEpoch, epoch);
  return { admission, user };
}
