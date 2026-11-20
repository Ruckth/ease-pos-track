import { v } from "convex/values";
import { components } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { audit, consumeChallenge, hasOtherUsableOwner, isUsableOwner, revokeUserSessions } from "./domain/identity";
import { staffRole } from "./schema";
import { internalJobMutation, ownerMutation } from "./functions";
import { constantTimeEquals, normalizeEmail } from "./identity_rules";
import { restoreReference } from "../shared/identity-restore-crypto";
import { staffGoogleChangeIntent } from "../shared/staff-google-change";

const replacement = v.object({ googleSubject: v.string(), verifiedEmail: v.string() });
const change = v.union(v.object({ kind: v.literal("revoke") }), v.object({ kind: v.literal("replace"), replacement }));
const PENDING_VERIFICATION_MS = 15 * 60 * 1000;

async function staffBinding(ctx: MutationCtx, staffId: Id<"staff">, expectedGeneration: number) {
  const staff = await ctx.db.get(staffId);
  if (!staff || staff.generation !== expectedGeneration) throw new Error("STAFF_BINDING_CHANGED");
  const former = await ctx.db.get(staff.userId);
  if (!former || former.staffId !== staff._id || former.googleSubject !== staff.googleSubject
    || (former.kind !== "staff" && (former.kind !== "revoked" || staff.status !== "disabled"))) {
    throw new Error("STAFF_BINDING_CHANGED");
  }
  return { staff, former };
}

async function replacementGoogleUser(ctx: MutationCtx, input: { googleSubject: string; verifiedEmail: string }) {
  if (!input.googleSubject || input.googleSubject.length > 200) throw new Error("PENDING_IDENTITY_REQUIRED");
  const user = await ctx.db.query("users").withIndex("by_google_subject", q => q.eq("googleSubject", input.googleSubject)).unique();
  if (!user || user.kind !== "pending" || user.staffId || user.customerId || user.googleEmailVerified !== true
    || user.googleEmail !== normalizeEmail(input.verifiedEmail) || user.googleVerifiedAt === undefined
    || user.googleVerifiedAt <= Date.now() - PENDING_VERIFICATION_MS) throw new Error("PENDING_IDENTITY_REQUIRED");
  if (await ctx.runQuery(components.authGoogle.provider.getUserIdByAccount, { providerAccountId: input.googleSubject }) !== user._id) {
    throw new Error("PENDING_IDENTITY_REQUIRED");
  }
  return user;
}

async function changeGoogleBinding(ctx: MutationCtx, staff: Doc<"staff">, former: Doc<"users">, input: {
  candidate?: Doc<"users">; evidenceRef: string; actorStaffId?: Id<"staff">;
}) {
  if (!input.candidate && await isUsableOwner(ctx, staff) && !await hasOtherUsableOwner(ctx, staff._id)) {
    throw new Error("LAST_OWNER");
  }
  if (!input.candidate && former.kind === "revoked") throw new Error("STAFF_BINDING_CHANGED");
  const now = Date.now();
  await ctx.db.patch(former._id, { kind: "revoked" });
  await revokeUserSessions(ctx, former._id);
  const transition = { generation: staff.generation + 1, validAfter: now, updatedAt: now };
  if (input.candidate) {
    await ctx.db.patch(staff._id, {
      ...transition, userId: input.candidate._id, googleSubject: input.candidate.googleSubject!,
      email: input.candidate.googleEmail!,
    });
    await ctx.db.patch(input.candidate._id, { kind: "staff", staffId: staff._id });
    await revokeUserSessions(ctx, input.candidate._id);
  } else {
    await ctx.db.patch(staff._id, { ...transition, status: "disabled" });
  }
  await audit(ctx, input.candidate ? input.actorStaffId ? "staff.google_replaced" : "staff.google_operator_replaced" : "staff.google_revoked", {
    actorStaffId: input.actorStaffId, staffId: staff._id, previousUserId: former._id, replacementUserId: input.candidate?._id,
    detail: input.evidenceRef,
  });
  return { ok: true as const };
}

/** An independent Owner reviews the exact new subject and consumes recent mailbox proof. */
export const changeBinding = ownerMutation({
  name: "identity_staff_recovery:changeBinding",
  args: {
    staffId: v.id("staff"), expectedGeneration: v.number(), expectedRole: staffRole, change, evidenceRef: v.string(), proof: v.object({ code: v.string() }),
  },
  handler: async (ctx, args) => {
    if (!restoreReference.test(args.evidenceRef)) throw new Error("INVALID_EVIDENCE_REFERENCE");
    const { staff, former } = await staffBinding(ctx, args.staffId, args.expectedGeneration);
    if (staff.role !== args.expectedRole) throw new Error("STAFF_BINDING_CHANGED");
    if (args.change.kind === "replace" && staff._id === ctx.actor.staffId) throw new Error("INDEPENDENT_OWNER_REQUIRED");
    const intent = staffGoogleChangeIntent(args);
    const proof = await consumeChallenge(ctx, ctx.session, "staff-google-binding", intent, args.proof.code);
    if (!proof.ok) return proof;
    const candidate = args.change.kind === "replace" ? await replacementGoogleUser(ctx, args.change.replacement) : undefined;
    return await changeGoogleBinding(ctx, staff, former, { candidate, evidenceRef: args.evidenceRef, actorStaffId: ctx.actor.staffId });
  },
});

/** Sole active Owner lockout. The deployment operator configures the independently verified pair. */
export const replaceSoleOwner = internalJobMutation({
  name: "identity_staff_recovery:replaceSoleOwner",
  args: { staffId: v.id("staff"), expectedGeneration: v.number(), replacement, evidenceRef: v.string() },
  handler: async (ctx, args) => {
    const { staff, former } = await staffBinding(ctx, args.staffId, args.expectedGeneration);
    if (!await isUsableOwner(ctx, staff) || await hasOtherUsableOwner(ctx, staff._id)) throw new Error("SOLE_OWNER_REQUIRED");
    const configuredStaff = process.env.OWNER_REPLACEMENT_STAFF_ID;
    const configuredSubject = process.env.OWNER_REPLACEMENT_GOOGLE_SUBJECT;
    if (!configuredStaff || !configuredSubject || !constantTimeEquals(configuredStaff, staff._id)
      || !constantTimeEquals(configuredSubject, args.replacement.googleSubject) || !restoreReference.test(args.evidenceRef)) {
      throw new Error("OWNER_REPLACEMENT_NOT_AUTHORIZED");
    }
    const candidate = await replacementGoogleUser(ctx, args.replacement);
    return await changeGoogleBinding(ctx, staff, former, { candidate, evidenceRef: args.evidenceRef });
  },
});
