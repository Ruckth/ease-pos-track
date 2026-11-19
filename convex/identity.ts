/**
 * Identity endpoints: viewer, Owner bootstrap, staff invitations and team
 * administration, Project invitations, saved recovery codes and action proof.
 * Peers read named staff and customers through listStaffDirectory and the
 * Actor carried by every protected handler (docs/identity.md).
 */
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  customerMutation, customerRecoveryMutation, identityAction, internalJobMutation, internalJobQuery, ownerMutation, ownerQuery,
  pendingIdentityMutation, pendingIdentityQuery, publicIdentityQuery, staffQuery,
} from "./functions";
import { staffRole } from "./schema";
import { newChallengeCode, normalizeEmail } from "./identity_rules";
import { liveAdmission, requireActor } from "./session_auth";
import { localFixturesEnabled } from "./local_fixtures";
import {
  audit, bootstrapOwner as bootstrap, consumeChallenge, createChallenge, createProjectInvitation, createStaffInvitation, verifyCustomerPassword, customerCredentialSelector,
  invitationState, issueRecoveryCode, joinProjectInvitation, recoveryCodeMatches, projectInvitationBySecret,
  requireInvitationEpoch, reserveChallengeEmail, revokeUserSessions, setStaffRole as changeRole, staffInvitationBySecret, t3ChallengeIntent,
  transitionCustomer, transitionStaff, viewerFor, type ChallengePurpose,
} from "./domain/identity";
import { activeDeploymentProject, epochStamp, namedIdentityEpoch, requireClosedPilot, requireCurrentPilotEpoch, requireNamedEpoch } from "./pilot_access";
import { t3Runtime } from "./t3_config";
import { staffInvitationIntent } from "../shared/staff-invitation-intent";

// ------------------------------------------------------------------ Convex Auth user callbacks

const methodArgs = { method: v.object({ name: v.string(), profile: v.any() }) };

/** First Google sign-in creates a pending identity with zero workspace access. */
export const createGoogleUser = internalJobMutation({
  name: "identity:createGoogleUser",
  args: methodArgs,
  handler: async (ctx, { method }): Promise<Id<"users">> => {
    const profile = method.profile as { id?: unknown; email?: unknown; emailVerified?: unknown; name?: unknown };
    if (method.name !== "google" || typeof profile.id !== "string" || !profile.id) throw new Error("INVALID_PROFILE");
    const googleSubject = profile.id;
    if (await ctx.db.query("users").withIndex("by_google_subject", q => q.eq("googleSubject", googleSubject)).first()) {
      throw new Error("ACCESS_UNAVAILABLE");
    }
    const emailVerified = typeof profile.email === "string" && profile.emailVerified === true;
    return await ctx.db.insert("users", {
      kind: "pending", googleSubject,
      ...(typeof profile.email === "string" ? { googleEmail: profile.email.toLowerCase() } : {}),
      googleEmailVerified: emailVerified,
      googleVerifiedAt: emailVerified ? Date.now() : undefined,
      ...(typeof profile.name === "string" ? { googleName: profile.name.slice(0, 120) } : {}),
      createdAt: Date.now(),
    });
  },
});

/** Keeps the verified Google profile current; never changes the binding. */
export const syncGoogleProfile = internalJobMutation({
  name: "identity:syncGoogleProfile",
  args: { ...methodArgs, userId: v.id("users") },
  handler: async (ctx, { method, userId }) => {
    const profile = method.profile as { id?: unknown; email?: unknown; emailVerified?: unknown; name?: unknown };
    const user = await ctx.db.get(userId);
    if (method.name !== "google" || !user || user.kind === "revoked" || user.googleSubject !== profile.id) throw new Error("ACCESS_UNAVAILABLE");
    const emailVerified = typeof profile.email === "string" && profile.emailVerified === true;
    await ctx.db.patch(userId, {
      ...(typeof profile.email === "string" ? { googleEmail: profile.email.toLowerCase() } : {}),
      googleEmailVerified: emailVerified,
      googleVerifiedAt: emailVerified ? Date.now() : undefined,
      ...(typeof profile.name === "string" ? { googleName: profile.name.slice(0, 120) } : {}),
    });
    return null;
  },
});

/** Username signup creates the user; the signup adapter binds the customer in the same mutation. */
export const createCustomerUser = internalJobMutation({
  name: "identity:createCustomerUser",
  args: methodArgs,
  handler: async (ctx, { method }): Promise<Id<"users">> => {
    if (method.name !== "customerPassword") throw new Error("INVALID_PROFILE");
    return await ctx.db.insert("users", { kind: "customer", createdAt: Date.now() });
  },
});

// ------------------------------------------------------------------ viewer

/** Signed-out, stale and disabled sessions all read as null. */
export const viewer = publicIdentityQuery("viewer")({
  name: "identity:viewer",
  args: {},
  handler: async (ctx) => {
    let epoch: string | undefined;
    try { epoch = await namedIdentityEpoch(ctx); } catch { return null; }
    const live = await liveAdmission(ctx);
    if (!live?.sessionUserId || !live.admission || live.admission.revokedAt !== undefined
      || live.admission.userId !== live.sessionUserId
      || (epoch !== undefined && live.admission.pilotEpoch !== epoch)) return null;
    return await viewerFor(ctx, live.admission);
  },
});

// ------------------------------------------------------------------ bootstrap (operator only)

/** `pnpm convex:local run identity:bootstrapOwner '{"googleSubject":"..."}'` after the Owner's first sign-in. */
export const bootstrapOwner = internalJobMutation({
  name: "identity:bootstrapOwner",
  args: { googleSubject: v.string() },
  handler: async (ctx, args) => await bootstrap(ctx, args.googleSubject),
});

/** Operator lookup of pending Google identities, to verify the subject out of band. */
export const listPendingIdentities = internalJobQuery({
  name: "identity:listPendingIdentities",
  args: {},
  handler: async (ctx) => (await ctx.db.query("users").order("desc").take(50))
    .filter((user) => user.kind === "pending")
    .map((user) => ({ googleSubject: user.googleSubject, email: user.googleEmail, emailVerified: user.googleEmailVerified, createdAt: user.createdAt })),
});

/**
 * Named pilot reconciliation, operator only, with pilot traffic closed. Admits a
 * principal into the current epoch: advances its generation, revokes every
 * session and, for customers, drops the saved recovery code so a fresh one is
 * enrolled. Principals without current lineage cannot sign in.
 */
export const reconcilePilotPrincipal = internalJobMutation({
  name: "identity:reconcilePilotPrincipal",
  args: { epoch: v.string(), staffId: v.optional(v.id("staff")), customerId: v.optional(v.id("customers")) },
  handler: async (ctx, args) => {
    const settings = requireClosedPilot();
    requireCurrentPilotEpoch(args.epoch, settings.epoch);
    if ((args.staffId === undefined) === (args.customerId === undefined)) throw new Error("INVALID_INPUT");
    if (args.customerId && settings.previousEpoch) throw new Error("CUSTOMER_REPLACEMENT_REQUIRED");
    const principal = args.staffId ? await ctx.db.get(args.staffId) : await ctx.db.get(args.customerId!);
    if (!principal) throw new Error("PRINCIPAL_NOT_FOUND");
    if (principal.pilotEpoch === settings.epoch) return { generation: principal.generation };
    const now = Date.now();
    const generation = principal.generation + 1;
    const recovery = args.customerId ? { recoveryCodeDigest: undefined, recoveryCodeCreatedAt: undefined } : {};
    await ctx.db.patch(principal._id, { pilotEpoch: settings.epoch, generation, validAfter: now, updatedAt: now, ...recovery });
    await revokeUserSessions(ctx, principal.userId);
    await audit(ctx, "principal.pilot_reconciled", args.staffId ? { staffId: args.staffId } : { customerId: args.customerId });
    return { generation };
  },
});

// ------------------------------------------------------------------ peer export

/** Named staff for assignment and routing peers: ID, name and current role. */
export const listStaffDirectory = staffQuery({
  name: "identity:listStaffDirectory",
  args: {},
  handler: async (ctx) => {
    const staff = await ctx.db.query("staff").withIndex("by_status_role", (q) => q.eq("status", "active")).collect();
    return staff.map((member) => ({ staffId: member._id, name: member.name, role: member.role }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

// ------------------------------------------------------------------ team administration (Owner)

export const listTeam = ownerQuery({
  name: "identity:listTeam",
  args: {},
  handler: async (ctx) => {
    const staff = await ctx.db.query("staff").collect();
    const invitations = await ctx.db.query("staffInvitations").withIndex("by_status", (q) => q.eq("status", "pending")).order("desc").take(50);
    const members = await Promise.all(staff.map(async (member) => ({
      staffId: member._id, name: member.name, email: member.email, role: member.role, status: member.status, generation: member.generation,
      googleBindingRevoked: (await ctx.db.get(member.userId))?.kind === "revoked",
    })));
    return {
      staff: members.sort((a, b) => a.name.localeCompare(b.name)),
      invitations: invitations.map((invite) => ({
        invitationId: invite._id, email: invite.email, role: invite.role, expiresAt: invite.expiresAt,
        expired: invite.expiresAt <= Date.now(),
      })),
    };
  },
});

const proof = v.object({ code: v.string() });

/** Returns the invitation secret once; it is never stored or shown again. */
export const inviteStaff = ownerMutation({
  name: "identity:inviteStaff",
  args: { email: v.string(), role: staffRole, proof },
  handler: async (ctx, args) => {
    const email = normalizeEmail(args.email);
    const denied = await requireProof(ctx, ctx.session, "staff-invite-create", staffInvitationIntent(email, args.role), args.proof.code);
    if (denied) return denied;
    const created = await createStaffInvitation(ctx, { email, role: args.role, createdByStaffId: ctx.actor.staffId! });
    return { ok: true as const, ...created };
  },
});

/** Reissue revokes the earlier invitation and returns a new secret. */
export const reissueStaffInvitation = ownerMutation({
  name: "identity:reissueStaffInvitation",
  args: { invitationId: v.id("staffInvitations"), proof },
  handler: async (ctx, args) => {
    const invite = await ctx.db.get(args.invitationId);
    if (!invite || invite.status !== "pending") throw new Error("INVITE_NOT_FOUND");
    const denied = await requireProof(ctx, ctx.session, "staff-invite-reissue",
      staffInvitationIntent(invite.email, invite.role, invite._id), args.proof.code);
    if (denied) return denied;
    await ctx.db.patch(invite._id, { status: "revoked", updatedAt: Date.now() });
    await audit(ctx, "staff_invitation.revoked", { actorStaffId: ctx.actor.staffId });
    const created = await createStaffInvitation(ctx, { email: invite.email, role: invite.role, createdByStaffId: ctx.actor.staffId! });
    return { ok: true as const, ...created };
  },
});

export const revokeStaffInvitation = ownerMutation({
  name: "identity:revokeStaffInvitation",
  args: { invitationId: v.id("staffInvitations") },
  handler: async (ctx, args) => {
    const invite = await ctx.db.get(args.invitationId);
    if (!invite || invite.status !== "pending") throw new Error("INVITE_NOT_FOUND");
    await ctx.db.patch(invite._id, { status: "revoked", updatedAt: Date.now() });
    await audit(ctx, "staff_invitation.revoked", { actorStaffId: ctx.actor.staffId });
  },
});

async function requireProof(ctx: Parameters<typeof consumeChallenge>[0], admission: Parameters<typeof consumeChallenge>[1], purpose: ChallengePurpose, intent: string, code: string) {
  const result = await consumeChallenge(ctx, admission, purpose, intent, code);
  return result.ok ? null : { ok: false as const, error: result.error };
}

/** Role and access changes consume fresh, intent-bound proof in the same transaction. */
export const setStaffRole = ownerMutation({
  name: "identity:setStaffRole",
  args: { staffId: v.id("staff"), role: staffRole, proof },
  handler: async (ctx, args) => {
    const staff = await ctx.db.get(args.staffId);
    if (!staff) throw new Error("STAFF_NOT_FOUND");
    const denied = await requireProof(ctx, ctx.session, "staff-role", `${staff._id}:${args.role}`, args.proof.code);
    if (denied) return denied;
    await changeRole(ctx, staff, args.role, ctx.actor.staffId!);
    return { ok: true as const };
  },
});

export const setStaffAccess = ownerMutation({
  name: "identity:setStaffAccess",
  args: { staffId: v.id("staff"), status: v.union(v.literal("active"), v.literal("disabled")), proof },
  handler: async (ctx, args) => {
    const staff = await ctx.db.get(args.staffId);
    if (!staff) throw new Error("STAFF_NOT_FOUND");
    if (staff.status === args.status) return { ok: true as const };
    const purpose = args.status === "disabled" ? "staff-disable" : "staff-enable";
    const denied = await requireProof(ctx, ctx.session, purpose, staff._id, args.proof.code);
    if (denied) return denied;
    await transitionStaff(ctx, staff, args.status, ctx.actor.staffId!);
    return { ok: true as const };
  },
});

// ------------------------------------------------------------------ staff invitation acceptance (pending Google identity)

export const previewStaffInvitation = pendingIdentityQuery({
  name: "identity:previewStaffInvitation",
  args: { invitation: v.string() },
  handler: async (ctx, args) => {
    const invite = await staffInvitationBySecret(ctx, args.invitation);
    if (!invite) return { status: "INVITE_NOT_FOUND" as const };
    await requireInvitationEpoch(ctx, invite);
    const problem = invitationState(invite);
    if (problem) return { status: problem };
    const matches = ctx.user.googleEmailVerified === true && ctx.user.googleEmail === invite.email;
    return { status: matches ? "ready" as const : "WRONG_GOOGLE_ACCOUNT" as const, role: invite.role, invitedEmail: invite.email, signedInEmail: ctx.user.googleEmail ?? null };
  },
});

/** Binds the pending identity; staff authority then needs a fresh sign-in. */
export const acceptStaffInvitation = pendingIdentityMutation({
  name: "identity:acceptStaffInvitation",
  args: { invitation: v.string(), code: v.string() },
  handler: async (ctx, args) => {
    const invite = await staffInvitationBySecret(ctx, args.invitation);
    if (!invite) throw new Error("INVITE_NOT_FOUND");
    await requireInvitationEpoch(ctx, invite);
    const problem = invitationState(invite);
    if (problem) throw new Error(problem);
    if (ctx.user.googleEmailVerified !== true || ctx.user.googleEmail !== invite.email || !ctx.user.googleSubject) throw new Error("WRONG_GOOGLE_ACCOUNT");
    const denied = await requireProof(ctx, ctx.admission, "staff-invite", `${invite._id}:${invite.role}:${invite.email}`, args.code);
    if (denied) return denied;
    const now = Date.now();
    const staffId = await ctx.db.insert("staff", {
      userId: ctx.user._id, googleSubject: ctx.user.googleSubject, email: invite.email, name: ctx.user.googleName ?? invite.email,
      role: invite.role, status: "active", generation: 1, validAfter: now, createdAt: now, updatedAt: now,
      ...epochStamp(ctx.admission.pilotEpoch),
    });
    await ctx.db.patch(ctx.user._id, { kind: "staff", staffId });
    await ctx.db.patch(invite._id, { status: "redeemed", redeemedByStaffId: staffId, updatedAt: now });
    await revokeUserSessions(ctx, ctx.user._id);
    await audit(ctx, "staff_invitation.redeemed", { staffId, detail: invite.role });
    return { ok: true as const };
  },
});

// ------------------------------------------------------------------ one-time codes

type Delivery = { to: string; purpose: ChallengePurpose; code: string; challengeId: Id<"identityChallenges"> };
const OWNER_PURPOSES: readonly ChallengePurpose[] = [
  "staff-role", "staff-disable", "staff-enable", "staff-google-binding", "staff-invite-create", "staff-invite-reissue",
];
const T3_PURPOSES: readonly ChallengePurpose[] = ["t3-key-issue", "t3-key-rotate", "t3-key-revoke"];

/** Creates the challenge for the live session and returns where to deliver it. */
export const issueChallenge = internalJobMutation({
  name: "identity:issueChallenge",
  args: { purpose: v.string(), target: v.optional(v.string()), invitation: v.optional(v.string()), code: v.string() },
  handler: async (ctx, args): Promise<Delivery | null> => {
    const purpose = args.purpose as ChallengePurpose;
    // Transactional proof delivery has its own pilot switch.
    const epoch = await namedIdentityEpoch(ctx, "identitySender");
    const live = await liveAdmission(ctx);
    const admission = live?.admission;
    if (!admission || admission.revokedAt !== undefined || admission.userId !== live?.sessionUserId) throw new Error("SESSION_EXPIRED");
    requireNamedEpoch(admission.pilotEpoch, epoch);
    const deliver = async (to: string, intent: string) => {
      if (!await reserveChallengeEmail(ctx, admission, to)) return null;
      const challengeId = await createChallenge(ctx, admission, purpose, intent, args.code);
      return { to, purpose, code: args.code, challengeId };
    };
    if (purpose === "staff-invite") {
      const user = await ctx.db.get(admission.userId);
      if (admission.principal !== "pending" || !user || user.kind !== "pending") throw new Error("SESSION_EXPIRED");
      const invite = await staffInvitationBySecret(ctx, args.invitation ?? "");
      if (!invite) throw new Error("INVITE_NOT_FOUND");
      const problem = invitationState(invite);
      if (problem) throw new Error(problem);
      if (user.googleEmailVerified !== true || user.googleEmail !== invite.email) throw new Error("WRONG_GOOGLE_ACCOUNT");
      await requireInvitationEpoch(ctx, invite);
      return await deliver(invite.email, `${invite._id}:${invite.role}:${invite.email}`);
    }
    const { actor } = await requireActor(ctx);
    if (T3_PURPOSES.includes(purpose)) {
      // Personal T3 key changes: the holder's own mailbox, bound to this session and generation.
      if (actor.role !== "staff" || !actor.staffId || args.target === undefined || args.target.length > 1024) throw new Error("INVALID_INPUT");
      if (purpose !== "t3-key-revoke" && !t3Runtime()?.issuing) throw new Error("DOCTOR_ISSUANCE_UNAVAILABLE");
      const holder = (await ctx.db.get(actor.staffId))!;
      return await deliver(holder.email, t3ChallengeIntent(admission, args.target));
    }
    if (actor.role !== "staff" || actor.staffRole !== "owner" || !actor.staffId) throw new Error("OWNER_ONLY");
    if (!OWNER_PURPOSES.includes(purpose) || !args.target || args.target.length > 1024) throw new Error("INVALID_INPUT");
    const owner = (await ctx.db.get(actor.staffId))!;
    return await deliver(owner.email, args.target);
  },
});

/** Local test sender only: the disposable backend records the code instead of sending it. */
export const recordLocalDelivery = internalJobMutation({
  name: "identity:recordLocalDelivery",
  args: { to: v.string(), purpose: v.string(), code: v.string() },
  handler: async (ctx, args) => {
    if (!localFixturesEnabled()) throw new Error("IDENTITY_SENDER_UNAVAILABLE");
    await ctx.db.insert("identityOutbox", { ...args, createdAt: Date.now() });
  },
});

/** Local test sender inspection for fixtures and rehearsals. */
export const readLocalDelivery = internalJobQuery({
  name: "identity:readLocalDelivery",
  args: { to: v.string() },
  handler: async (ctx, args) => {
    if (!localFixturesEnabled()) throw new Error("IDENTITY_SENDER_UNAVAILABLE");
    return await ctx.db.query("identityOutbox").withIndex("by_to", (q) => q.eq("to", args.to)).order("desc").first();
  },
});

const COPY: Record<ChallengePurpose, string> = {
  "staff-invite": "confirm your Tackle Issue staff invitation / ยืนยันคำเชิญทีมงาน Tackle Issue",
  "staff-invite-create": "confirm creating a staff invitation / ยืนยันการสร้างคำเชิญทีมงาน",
  "staff-invite-reissue": "confirm reissuing a staff invitation / ยืนยันการออกคำเชิญทีมงานใหม่",
  "staff-role": "confirm a team role change / ยืนยันการเปลี่ยนบทบาททีม",
  "staff-disable": "confirm disabling a team member / ยืนยันการปิดการเข้าถึงของสมาชิกทีม",
  "staff-enable": "confirm restoring a team member / ยืนยันการคืนสิทธิ์สมาชิกทีม",
  "t3-key-issue": "confirm a new T3 Code connection key / ยืนยันการออกคีย์เชื่อมต่อ T3 Code",
  "t3-key-rotate": "confirm replacing a T3 Code connection key / ยืนยันการเปลี่ยนคีย์เชื่อมต่อ T3 Code",
  "t3-key-revoke": "confirm revoking a T3 Code connection key / ยืนยันการเพิกถอนคีย์เชื่อมต่อ T3 Code",
  "staff-google-binding": "confirm a team member’s Google account change / ยืนยันการเปลี่ยนบัญชี Google ของสมาชิกทีม",
};

/**
 * Identity sender. `IDENTITY_SENDER=resend` uses the restricted identity
 * credentials; `local` records into identityOutbox on the disposable backend
 * only. Anything else pauses invitations and sensitive staff actions.
 */
export const sendChallengeCode = identityAction("send-challenge")({
  name: "identity:sendChallengeCode",
  args: {
    purpose: v.union(v.literal("staff-invite"), v.literal("staff-role"), v.literal("staff-disable"), v.literal("staff-enable"),
      v.literal("staff-invite-create"), v.literal("staff-invite-reissue"),
      v.literal("staff-google-binding"), v.literal("t3-key-issue"), v.literal("t3-key-rotate"), v.literal("t3-key-revoke")),
    target: v.optional(v.string()),
    invitation: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ sent: true; challengeId: Id<"identityChallenges"> }> => {
    const sender = process.env.IDENTITY_SENDER;
    if (sender !== "resend" && !(sender === "local" && localFixturesEnabled())) throw new Error("IDENTITY_SENDER_UNAVAILABLE");
    const delivery: Delivery | null = await ctx.runMutation(internal.identity.issueChallenge, { ...args, code: newChallengeCode() });
    if (!delivery) throw new Error("RATE_LIMITED");
    const sent = { sent: true as const, challengeId: delivery.challengeId };
    if (sender === "local") {
      await ctx.runMutation(internal.identity.recordLocalDelivery, { to: delivery.to, purpose: delivery.purpose, code: delivery.code });
      return sent;
    }
    const apiKey = process.env.RESEND_IDENTITY_API_KEY;
    const from = process.env.IDENTITY_SENDER_FROM;
    if (!apiKey || !from) throw new Error("IDENTITY_SENDER_UNAVAILABLE");
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from, to: [delivery.to], subject: "Tackle Issue verification code / รหัสยืนยัน Tackle Issue",
        text: `Use ${delivery.code} to ${COPY[delivery.purpose]}. It expires in 5 minutes.\n\nใช้รหัส ${delivery.code} ภายใน 5 นาที`,
      }),
      redirect: "error",
    });
    if (!response.ok) throw new Error("IDENTITY_SENDER_UNAVAILABLE");
    return sent;
  },
});

// ------------------------------------------------------------------ Project invitations and customers (Owner)

export const createCustomerInvitation = ownerMutation({
  name: "identity:createCustomerInvitation",
  args: { projectId: v.id("projects"), eligibilityConfirmed: v.literal(true) },
  handler: async (ctx, args) => await createProjectInvitation(ctx, args.projectId, ctx.actor.staffId!),
});

export const listCustomerInvitations = ownerQuery({
  name: "identity:listCustomerInvitations",
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    if (!await activeDeploymentProject(ctx, args.projectId)) throw new Error("PROJECT_NOT_FOUND");
    const rows = await ctx.db.query("projectInvitations").withIndex("by_project", (q) => q.eq("projectId", args.projectId).eq("status", "pending")).order("desc").take(50);
    return rows.map((invite) => ({ invitationId: invite._id, expiresAt: invite.expiresAt, expired: invite.expiresAt <= Date.now(), createdAt: invite.createdAt }));
  },
});

export const revokeCustomerInvitation = ownerMutation({
  name: "identity:revokeCustomerInvitation",
  args: { invitationId: v.id("projectInvitations") },
  handler: async (ctx, args) => {
    const invite = await ctx.db.get(args.invitationId);
    if (!invite || invite.status !== "pending" || !await activeDeploymentProject(ctx, invite.projectId)) throw new Error("INVITE_NOT_FOUND");
    await ctx.db.patch(invite._id, { status: "revoked", updatedAt: Date.now() });
    await audit(ctx, "project_invitation.revoked", { actorStaffId: ctx.actor.staffId });
  },
});

export const setCustomerAccess = ownerMutation({
  name: "identity:setCustomerAccess",
  args: { customerId: v.id("customers"), status: v.union(v.literal("active"), v.literal("disabled")) },
  handler: async (ctx, args) => {
    const customer = await ctx.db.get(args.customerId);
    if (!customer) throw new Error("CUSTOMER_NOT_FOUND");
    if (customer.status !== args.status) await transitionCustomer(ctx, customer, args.status, ctx.actor.staffId!);
  },
});

/** Opening or previewing never consumes; shows the Project and the active identity. */
export const previewCustomerInvitation = publicIdentityQuery("invite-preview")({
  name: "identity:previewCustomerInvitation",
  args: { invitation: v.string() },
  handler: async (ctx, args) => {
    const invite = await projectInvitationBySecret(ctx, args.invitation);
    let project = null;
    try {
      if (invite) await requireInvitationEpoch(ctx, invite);
      project = invite ? await activeDeploymentProject(ctx, invite.projectId) : null;
    } catch { return { status: "INVITE_NOT_FOUND" as const }; }
    if (!invite?.eligibilityConfirmed || !project) return { status: "INVITE_NOT_FOUND" as const };
    const problem = invitationState(invite);
    if (problem) return { status: problem };
    const live = await liveAdmission(ctx);
    const viewer = live?.admission && live.sessionUserId === live.admission.userId && live.admission.revokedAt === undefined
      ? await viewerFor(ctx, live.admission) : null;
    const member = viewer?.kind === "customer" && await ctx.db.query("projectMembers").withIndex("by_project", (q) =>
      q.eq("projectId", project._id).eq("customerId", viewer.customerId)).unique();
    return {
      status: "ready" as const, projectName: project.name, projectKey: project.key, expiresAt: invite.expiresAt,
      viewer: viewer?.kind === "customer" ? { kind: "customer" as const, username: viewer.username, alreadyMember: Boolean(member) }
        : viewer ? { kind: viewer.kind } : null,
    };
  },
});

/** A returning customer adds the Project to their existing customerId. */
export const joinWithInvitation = customerMutation({
  name: "identity:joinWithInvitation",
  args: { invitation: v.string() },
  handler: async (ctx, args) => await joinProjectInvitation(ctx, args.invitation, ctx.actor.customerId!),
});

// ------------------------------------------------------------------ saved recovery code (customer)

/**
 * First setup needs only the live session (signup or post-recovery sign-in is
 * fresh). Replacing an existing code re-verifies the current password.
 */
export const createRecoveryCode = customerRecoveryMutation({
  name: "identity:createRecoveryCode",
  args: { currentPassword: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const customer = (await ctx.db.get(ctx.actor.customerId!))!;
    if (customer.recoveryCodeDigest !== undefined) {
      if (!args.currentPassword) return { ok: false as const, error: "PROOF_REQUIRED" };
      const verified = await verifyCustomerPassword(ctx, {
        userId: customer.userId, password: args.currentPassword.normalize("NFC"),
        rateLimitKey: await customerCredentialSelector(customer.username),
      });
      if (!verified.success) return { ok: false as const, error: verified.userError.error === "RATE_LIMITED" ? "RATE_LIMITED" : "INVALID_CREDENTIALS" };
    }
    return { ok: true as const, code: await issueRecoveryCode(ctx, customer) };
  },
});

/** A new or restored customer confirms possession before the session can work Tickets. */
export const confirmRecoveryEnrollment = customerRecoveryMutation({
  name: "identity:confirmRecoveryEnrollment",
  args: { code: v.string() },
  handler: async (ctx, args) => {
    const customer = (await ctx.db.get(ctx.actor.customerId!))!;
    if (!customer.recoveryEnrollmentRequired) return { ok: true as const };
    if (!await recoveryCodeMatches(customer, args.code)) return { ok: false as const, error: "RECOVERY_FAILED" };
    await ctx.db.patch(customer._id, { recoveryEnrollmentRequired: undefined, updatedAt: Date.now() });
    await audit(ctx, "customer.recovery_enrollment_confirmed", { customerId: customer._id });
    return { ok: true as const };
  },
});
