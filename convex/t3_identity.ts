import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { t3ProofIntent } from "../shared/t3-doctor";
import { requireActor } from "./session_auth";
import { consumeChallenge, t3ChallengeIntent } from "./domain/identity";
import { activeDeploymentProject, namedIdentityEpoch, requireNamedEpoch } from "./pilot_access";

export type T3Staff = {
  id: string;
  account: string;
  role: "owner" | "staff";
  generation: number;
};

export type T3Admission = T3Staff & { sessionId: string };
export type T3Proof = ReturnType<typeof t3ProofIntent> & { challengeId: string; code: string };

type T3Identity = {
  // Resolve only a live, active named staff browser admission from ctx.auth.
  browser(ctx: QueryCtx): Promise<T3Admission | null>;
  // Resolve active named staff by immutable domain ID, including the current generation.
  staff(ctx: QueryCtx, staffId: string): Promise<T3Staff | null>;
  // Check current staff Project entitlement. The caller also checks the Project is active.
  project(ctx: QueryCtx, staff: T3Staff, projectId: Id<"projects">): Promise<boolean>;
  // Verify and consume in this transaction. Return false to commit a failed attempt.
  consume(ctx: MutationCtx, admission: T3Admission, proof: T3Proof): Promise<boolean>;
};

const T3_ACTIONS = new Set(["t3-key-issue", "t3-key-rotate", "t3-key-revoke"] as const);

async function currentStaff(ctx: QueryCtx, staffId: string): Promise<T3Staff | null> {
  const id = ctx.db.normalizeId("staff", staffId);
  const row = id && await ctx.db.get(id);
  if (!row || row.status !== "active") return null;
  // Inside a named pilot the holder must also be reconciled into the current epoch.
  try { requireNamedEpoch(row.pilotEpoch, await namedIdentityEpoch(ctx)); } catch { return null; }
  return { id: row._id, account: row.email, role: row.role, generation: row.generation };
}

/** Named identity (docs/identity.md) behind the T3 doctor key routes. */
export const t3Identity: T3Identity = {
  async browser(ctx) {
    let access;
    try { access = await requireActor(ctx); } catch { return null; }
    if (access.actor.role !== "staff" || !access.actor.staffId) return null;
    const staff = await currentStaff(ctx, access.actor.staffId);
    if (!staff || staff.generation !== access.session.generation) return null;
    return { ...staff, sessionId: access.session._id };
  },
  staff: currentStaff,
  // Launch policy: active named staff use every active Project in the deployment.
  async project(ctx, staff, projectId) {
    return Boolean(await currentStaff(ctx, staff.id) && await activeDeploymentProject(ctx, projectId));
  },
  async consume(ctx, admission, proof) {
    if (!T3_ACTIONS.has(proof.action)) return false;
    const id = ctx.db.normalizeId("sessionAdmissions", admission.sessionId);
    const session = id && await ctx.db.get(id);
    if (!session || session.revokedAt !== undefined || session.staffId !== admission.id
      || session.generation !== admission.generation) return false;
    const result = await consumeChallenge(ctx, session, proof.action, t3ChallengeIntent(session, proof.intendedChange),
      proof.code, proof.challengeId);
    return result.ok;
  },
};
