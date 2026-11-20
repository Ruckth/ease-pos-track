/**
 * Identity domain: principals, session admission and revocation, invitations,
 * saved recovery codes and single-use action proof. Registration and policy
 * live in convex/functions.ts; callers here already passed their policy.
 */
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { components } from "../_generated/api";
import {
  CHALLENGE_MAX_FAILURES, CHALLENGE_TTL_MS, GOOGLE_FLOW_TTL_MS, PROJECT_INVITE_TTL_MS, STAFF_INVITE_TTL_MS,
  canonicalRecoveryCode, challengeCodeDigest, constantTimeEquals, encodeRecoveryCode, formatRecoveryCode,
  accessTokenSessionId, googleFlowAdmissible, newInvitationSecret, randomBytes, recoveryCodeDigest, secretDigest, sha256Hex,
  normalizeUsername, PASSWORD_MIN_CODE_POINTS,
} from "../identity_rules";
import { isLockedOut, planFailure, type GuardConfig } from "../login_guard";
import { activeDeploymentProject, epochStamp, namedIdentityEpoch, requireNamedEpoch } from "../pilot_access";
import { readPilotSettings } from "../../shared/pilot-settings";
import { customerCredentialIsCurrent, identityRecoveryAdmission } from "../identity_recovery_access";
import { isMember } from "./projects";

type Ctx = QueryCtx | MutationCtx;
type TokenBundle = { accessToken: string; userId: string };

export async function audit(ctx: MutationCtx, action: string, fields: {
  actorStaffId?: Id<"staff">; staffId?: Id<"staff">; customerId?: Id<"customers">; detail?: string;
  restoreCaseId?: Id<"customerRestoreCases">; previousUserId?: Id<"users">; replacementUserId?: Id<"users">;
}) {
  await ctx.db.insert("identityAudit", { action, ...fields, createdAt: Date.now() });
}

// ---------------------------------------------------------------- admission

/** Insert the admission for a session minted earlier in this same mutation. */
export async function admitSession(ctx: MutationCtx, tokens: TokenBundle, principal:
  | { principal: "pending" }
  | { principal: "staff"; staff: Doc<"staff"> }
  | { principal: "customer"; customer: Doc<"customers"> },
  method: "google" | "password") {
  const authSessionId = accessTokenSessionId(tokens.accessToken);
  const session = await ctx.runQuery(components.auth.public.getSession, { sessionId: authSessionId });
  if (!session || session.userId !== tokens.userId) throw new Error("ADMISSION_REQUIRED");
  const userId = tokens.userId as Id<"users">;
  // A named pilot admits only principals enrolled or reconciled into its epoch.
  const epoch = await namedIdentityEpoch(ctx);
  if (principal.principal !== "pending") {
    requireNamedEpoch((principal.principal === "staff" ? principal.staff : principal.customer).pilotEpoch, epoch);
  }
  const base = { authSessionId, userId, method, createdAt: Date.now(), ...epochStamp(epoch) };
  if (principal.principal === "staff") {
    if (principal.staff.userId !== userId || principal.staff.status !== "active") throw new Error("ACCESS_UNAVAILABLE");
    await ctx.db.insert("sessionAdmissions", { ...base, principal: "staff", staffId: principal.staff._id, generation: principal.staff.generation });
  } else if (principal.principal === "customer") {
    if (principal.customer.userId !== userId || principal.customer.status !== "active"
      || !customerCredentialIsCurrent(principal.customer, await identityRecoveryAdmission(ctx))) throw new Error("ACCESS_UNAVAILABLE");
    await ctx.db.insert("sessionAdmissions", { ...base, principal: "customer", customerId: principal.customer._id, generation: principal.customer.generation });
  } else {
    await ctx.db.insert("sessionAdmissions", { ...base, principal: "pending", generation: 0 });
  }
}

/** Only live core sessions can authorize calls. Older admission IDs remain as Ticket attribution. */
export async function revokeUserSessions(ctx: MutationCtx, userId: Id<"users">, exceptAuthSessionId?: string) {
  const sessions = await ctx.runQuery(components.auth.public.listSessions, { userId });
  const sessionIds = sessions.map((session) => session.sessionId).filter((id) => id !== exceptAuthSessionId);
  if (sessionIds.length) await ctx.runMutation(components.auth.public.revokeSessions, { sessionIds });
  const now = Date.now();
  await Promise.all(sessionIds.map(async id => {
    const admission = await ctx.db.query("sessionAdmissions").withIndex("by_auth_session", q => q.eq("authSessionId", id)).unique();
    if (admission && admission.revokedAt === undefined) await ctx.db.patch(admission._id, { revokedAt: now });
  }));
  return sessionIds.length;
}

/** Records a Google flow at start; completion consumes it exactly once. */
export async function recordGoogleFlow(ctx: MutationCtx, state: string) {
  const now = Date.now();
  const epoch = await namedIdentityEpoch(ctx);
  await ctx.db.insert("googleFlows", { stateDigest: await secretDigest("google-state", state), startedAt: now, ...epochStamp(epoch) });
  for (const stale of await ctx.db.query("googleFlows").withIndex("by_started", (q) => q.lt("startedAt", now - GOOGLE_FLOW_TTL_MS)).take(20)) {
    await ctx.db.delete(stale._id);
  }
}

/**
 * Google completion admission: the same initiated flow, then a pending
 * identity or a staff principal whose last transition predates the flow.
 */
export async function admitGoogleCompletion(ctx: MutationCtx, tokens: TokenBundle, state: string) {
  const stateDigest = await secretDigest("google-state", state);
  const started = await ctx.db.query("googleFlows").withIndex("by_state", (q) => q.eq("stateDigest", stateDigest)).unique();
  const pilot = await identityRecoveryAdmission(ctx);
  if (!started || started.pilotEpoch !== pilot?.epoch || started.consumedAt !== undefined
    || started.startedAt < Date.now() - GOOGLE_FLOW_TTL_MS) {
    throw new Error("SIGN_IN_RESTART_REQUIRED");
  }
  // A flow started under an earlier epoch (or none) cannot complete in this one.
  requireNamedEpoch(started.pilotEpoch, await namedIdentityEpoch(ctx));
  await ctx.db.patch(started._id, { consumedAt: Date.now() });
  const user = await ctx.db.get(tokens.userId as Id<"users">);
  if (!user) throw new Error("ACCESS_UNAVAILABLE");
  if (user.kind === "pending") return await admitSession(ctx, tokens, { principal: "pending" }, "google");
  if (user.kind !== "staff" || !user.staffId) throw new Error("ACCESS_UNAVAILABLE");
  const staff = await ctx.db.get(user.staffId);
  if (!staff || !googleFlowAdmissible(started.startedAt, staff)) throw new Error("ACCESS_UNAVAILABLE");
  await admitSession(ctx, tokens, { principal: "staff", staff }, "google");
}

// ---------------------------------------------------------------- viewer

export async function viewerFor(ctx: Ctx, admission: Doc<"sessionAdmissions">) {
  if (admission.principal === "pending") {
    const user = await ctx.db.get(admission.userId);
    if (!user || user.kind !== "pending") return null;
    return {
      kind: "pending" as const, email: user.googleEmail ?? null, emailVerified: user.googleEmailVerified === true,
      name: user.googleName ?? null, googleSubject: user.googleEmailVerified ? user.googleSubject ?? null : null,
    };
  }
  if (admission.principal === "staff" && admission.staffId) {
    const staff = await ctx.db.get(admission.staffId);
    if (!staff || staff.status !== "active" || staff.generation !== admission.generation) return null;
    return { kind: "staff" as const, staffId: staff._id, role: staff.role, name: staff.name, email: staff.email };
  }
  if (admission.principal === "customer" && admission.customerId) {
    const customer = await ctx.db.get(admission.customerId);
    if (!customer || customer.status !== "active" || customer.generation !== admission.generation
      || !customerCredentialIsCurrent(customer, await identityRecoveryAdmission(ctx))) return null;
    return {
      kind: "customer" as const, customerId: customer._id, username: customer.username,
      displayName: customer.displayName, needsRecoveryCode: customer.recoveryCodeDigest === undefined,
      recoveryEnrollmentRequired: customer.recoveryEnrollmentRequired === true,
    };
  }
  return null;
}

// ---------------------------------------------------------------- attempt budgets

export const RECOVERY_GUARD: GuardConfig = { windowMs: 60 * 60 * 1000, maxAttempts: 10, lockoutMs: 60 * 60 * 1000 };
export const CREDENTIAL_INGRESS_GUARD: GuardConfig = { windowMs: 10 * 60 * 1000, maxAttempts: 200, lockoutMs: 10 * 60 * 1000 };
export const INVITE_GUARD: GuardConfig = { windowMs: 60 * 60 * 1000, maxAttempts: 20, lockoutMs: 60 * 60 * 1000 };
const CHALLENGE_EMAIL_GUARD: GuardConfig = { windowMs: 15 * 60 * 1000, maxAttempts: 5, lockoutMs: 15 * 60 * 1000 };

export async function customerCredentialSelector(username: string) {
  return `customer:${await sha256Hex(username)}`;
}

export function recoveryAttemptKey(selector: string) {
  return `recover:${selector}`;
}

async function attemptRow(ctx: MutationCtx, key: string) {
  return await ctx.db.query("identityAttempts").withIndex("by_key", (q) => q.eq("key", key)).unique();
}
export async function budgetExhausted(ctx: MutationCtx, key: string) {
  return isLockedOut([await attemptRow(ctx, key)], Date.now());
}
/** Failures are returned, not thrown, so this write commits. */
export async function recordAttemptFailure(ctx: MutationCtx, key: string, config: GuardConfig) {
  const now = Date.now();
  const existing = await attemptRow(ctx, key);
  const value = { key, ...planFailure(existing, now, config), updatedAt: now };
  if (existing) await ctx.db.replace(existing._id, value);
  else await ctx.db.insert("identityAttempts", value);
}
export async function clearAttempts(ctx: MutationCtx, key: string) {
  const existing = await attemptRow(ctx, key);
  if (existing) await ctx.db.delete(existing._id);
}

export async function userIdForUsername(ctx: Pick<QueryCtx, "runQuery">, username: string) {
  return await ctx.runQuery(components.authUsername.public.getUserIdByUsername, { username });
}

type CredentialScope = Awaited<ReturnType<typeof identityRecoveryAdmission>>;
type PasswordSignInCandidate = {
  customerId: Id<"customers">;
  userId: Id<"users">;
  username: string;
  generation: number;
  epoch?: string;
  pilotEpoch?: string;
  credentialEpoch?: string;
  credentialVersion: string;
};

async function activeCustomerPasswordAccount(ctx: MutationCtx, username: string, pilot: CredentialScope) {
  const [userId, customer] = await Promise.all([
    userIdForUsername(ctx, username),
    ctx.db.query("customers").withIndex("by_username", q => q.eq("username", username)).unique(),
  ]);
  if (!customer || customer.userId !== userId || customer.status !== "active"
    || !customerCredentialIsCurrent(customer, pilot)) return null;
  const user = await ctx.db.get(customer.userId);
  return user?.kind === "customer" && user.customerId === customer._id ? customer : null;
}

/** Commit the selector charge and snapshot the account before the action does password work. */
export async function reserveCustomerPasswordSignIn(ctx: MutationCtx, rawUsername: string): Promise<
  { status: "denied" } | { status: "dummy" } | { status: "ready"; candidate: PasswordSignInCandidate }
> {
  const pilot = await identityRecoveryAdmission(ctx);
  let username: string;
  try { username = normalizeUsername(rawUsername); } catch { return { status: "denied" }; }
  const customer = await activeCustomerPasswordAccount(ctx, username, pilot);
  if (!customer) {
    const unknownBudget = "signin:unrecognized";
    if (await budgetExhausted(ctx, unknownBudget)) return { status: "denied" };
    await recordAttemptFailure(ctx, unknownBudget, CREDENTIAL_INGRESS_GUARD);
  }
  const rateLimitKey = await customerCredentialSelector(username);
  const reserved = await ctx.runMutation(components.authPassword.public.reserveVerification, {
    rateLimitKey, userId: customer?.userId,
  });
  await recordPasswordAttempt(ctx, rateLimitKey);
  if (!reserved) return { status: "denied" };
  if (!customer || !reserved.credentialVersion) return { status: "dummy" };
  return {
    status: "ready",
    candidate: {
      customerId: customer._id, userId: customer.userId, username,
      generation: customer.generation, epoch: pilot?.epoch, pilotEpoch: customer.pilotEpoch,
      credentialEpoch: customer.credentialEpoch, credentialVersion: reserved.credentialVersion,
    },
  };
}

/** Recheck the verified snapshot in the transaction that will issue the session. */
export async function verifiedCustomerForSignIn(ctx: MutationCtx, candidate: PasswordSignInCandidate) {
  const pilot = await identityRecoveryAdmission(ctx);
  if (pilot?.epoch !== candidate.epoch) return null;
  const customer = await activeCustomerPasswordAccount(ctx, candidate.username, pilot);
  if (!customer || customer._id !== candidate.customerId || customer.userId !== candidate.userId
    || customer.generation !== candidate.generation || customer.pilotEpoch !== candidate.pilotEpoch
    || customer.credentialEpoch !== candidate.credentialEpoch) return null;

  const rateLimitKey = await customerCredentialSelector(candidate.username);
  const current = await ctx.runMutation(components.authPassword.public.finishReservedVerification, {
    userId: customer.userId, version: candidate.credentialVersion, rateLimitKey,
  });
  if (!current) return null;
  await clearAttempts(ctx, rateLimitKey);
  return customer;
}

export async function verifyCustomerPassword(ctx: MutationCtx, input: {
  userId: string; password: string; rateLimitKey: string;
}) {
  const result = await ctx.runMutation(components.authPassword.public.verifyPassword, input);
  if (result.success) await clearAttempts(ctx, input.rateLimitKey);
  else await recordPasswordAttempt(ctx, input.rateLimitKey);
  return result;
}

// The component owns selector throttling. This index lets the approved
// retention job remove the component bucket and its last-activity record together.
async function recordPasswordAttempt(ctx: MutationCtx, key: string) {
  const previous = await attemptRow(ctx, key);
  const now = Date.now();
  if (previous) await ctx.db.patch(previous._id, { updatedAt: now, attempts: previous.attempts + 1 });
  else await ctx.db.insert("identityAttempts", { key, updatedAt: now, attempts: 1, firstAttemptAt: now });
}

// ---------------------------------------------------------------- principals

async function hasStaffGoogleBinding(ctx: Ctx, staff: Doc<"staff">) {
  const user = await ctx.db.get(staff.userId);
  if (!staff.googleSubject || user?.kind !== "staff" || user.staffId !== staff._id || user.googleSubject !== staff.googleSubject) return false;
  return await ctx.runQuery(components.authGoogle.provider.getUserIdByAccount, { providerAccountId: staff.googleSubject }) === staff.userId;
}

export async function hasOtherUsableOwner(ctx: Ctx, exceptStaffId: Id<"staff">) {
  const epoch = await namedIdentityEpoch(ctx);
  for await (const staff of ctx.db.query("staff").withIndex("by_status_role", (q) => q.eq("status", "active").eq("role", "owner"))) {
    if (staff._id !== exceptStaffId && staff.pilotEpoch === epoch && await hasStaffGoogleBinding(ctx, staff)) return true;
  }
  return false;
}

export async function isUsableOwner(ctx: Ctx, staff: Doc<"staff">) {
  return staff.status === "active" && staff.role === "owner"
    && staff.pilotEpoch === await namedIdentityEpoch(ctx) && await hasStaffGoogleBinding(ctx, staff);
}

/** Disable or re-enable a principal: advance generation and validAfter, revoke all sessions. */
export async function transitionStaff(ctx: MutationCtx, staff: Doc<"staff">, status: "active" | "disabled", actorStaffId: Id<"staff">) {
  if (status === "disabled" && await isUsableOwner(ctx, staff) && !await hasOtherUsableOwner(ctx, staff._id)) {
    throw new Error("LAST_OWNER");
  }
  if (status === "active" && !await hasStaffGoogleBinding(ctx, staff)) throw new Error("STAFF_BINDING_REVOKED");
  const now = Date.now();
  await ctx.db.patch(staff._id, { status, generation: staff.generation + 1, validAfter: now, updatedAt: now });
  await revokeUserSessions(ctx, staff.userId);
  await audit(ctx, status === "disabled" ? "staff.disabled" : "staff.enabled", { actorStaffId, staffId: staff._id });
}

export async function setStaffRole(ctx: MutationCtx, staff: Doc<"staff">, role: "owner" | "staff", actorStaffId: Id<"staff">) {
  if (staff.role === role) return;
  if (role === "staff" && await isUsableOwner(ctx, staff) && !await hasOtherUsableOwner(ctx, staff._id)) {
    throw new Error("LAST_OWNER");
  }
  await ctx.db.patch(staff._id, { role, updatedAt: Date.now() });
  await audit(ctx, "staff.role_changed", { actorStaffId, staffId: staff._id, detail: role });
}

export async function transitionCustomer(ctx: MutationCtx, customer: Doc<"customers">, status: "active" | "disabled", actorStaffId: Id<"staff">) {
  const now = Date.now();
  // Preserve the issuance generation for codes written before it was stored separately.
  const recoveryCodeGeneration = customer.recoveryCodeDigest
    ? customer.recoveryCodeGeneration ?? customer.generation : undefined;
  await ctx.db.patch(customer._id, { status, recoveryCodeGeneration, generation: customer.generation + 1, validAfter: now, updatedAt: now });
  await revokeUserSessions(ctx, customer.userId);
  await audit(ctx, status === "disabled" ? "customer.disabled" : "customer.enabled", { actorStaffId, customerId: customer._id });
}

/**
 * Internal, audited, one-use: exactly the configured Google subject, zero
 * Owners ever recorded, and the subject's pending identity already signed in.
 */
export async function bootstrapOwner(ctx: MutationCtx, googleSubject: string) {
  const configured = process.env.OWNER_BOOTSTRAP_GOOGLE_SUBJECT;
  if (!configured || !constantTimeEquals(configured, googleSubject)) throw new Error("BOOTSTRAP_NOT_AUTHORIZED");
  if (await ctx.db.query("staff").first()) throw new Error("BOOTSTRAP_ALREADY_USED");
  const user = await ctx.db.query("users").withIndex("by_google_subject", (q) => q.eq("googleSubject", googleSubject)).unique();
  if (!user || user.kind !== "pending") throw new Error("PENDING_IDENTITY_REQUIRED");
  if (!user.googleEmail || user.googleEmailVerified !== true) throw new Error("VERIFIED_EMAIL_REQUIRED");
  const now = Date.now();
  const staffId = await ctx.db.insert("staff", {
    userId: user._id, googleSubject, email: user.googleEmail, name: user.googleName ?? user.googleEmail,
    role: "owner", status: "active", generation: 1, validAfter: now, createdAt: now, updatedAt: now,
    ...epochStamp(currentPilotEpoch()),
  });
  await ctx.db.patch(user._id, { kind: "staff", staffId });
  // Staff authority needs a fresh sign-in after activation.
  await revokeUserSessions(ctx, user._id);
  await audit(ctx, "owner.bootstrapped", { staffId });
  return { staffId };
}

// ---------------------------------------------------------------- invitations

export async function createStaffInvitation(ctx: MutationCtx, input: { email: string; role: "owner" | "staff"; createdByStaffId: Id<"staff"> }) {
  const epoch = await namedIdentityEpoch(ctx, "invitation");
  const secret = newInvitationSecret();
  const now = Date.now();
  const invitationId = await ctx.db.insert("staffInvitations", {
    email: input.email, role: input.role, secretDigest: await secretDigest("staff-invite", secret), status: "pending",
    expiresAt: now + STAFF_INVITE_TTL_MS, createdByStaffId: input.createdByStaffId, createdAt: now, updatedAt: now,
    ...epochStamp(epoch),
  });
  await audit(ctx, "staff_invitation.created", { actorStaffId: input.createdByStaffId, detail: input.role });
  return { invitationId, secret, expiresAt: now + STAFF_INVITE_TTL_MS };
}

/**
 * In a named pilot an invitation is usable only while invitations are open
 * and only within the epoch that issued it. Outside a pilot this is a no-op.
 */
export async function requireInvitationEpoch(ctx: Ctx, invite: { pilotEpoch?: string }) {
  requireNamedEpoch(invite.pilotEpoch, await namedIdentityEpoch(ctx, "invitation"));
}

/** Current pilot epoch from configuration only, for internal operator writes. */
export function currentPilotEpoch() {
  return readPilotSettings(process.env)?.epoch;
}

export function invitationState(invite: { status: "pending" | "redeemed" | "revoked"; expiresAt: number }) {
  if (invite.status === "revoked") return "INVITE_REVOKED" as const;
  if (invite.status === "redeemed") return "INVITE_USED" as const;
  if (invite.expiresAt <= Date.now()) return "INVITE_EXPIRED" as const;
  return null;
}

export async function staffInvitationBySecret(ctx: Ctx, secret: string) {
  if (!secret || secret.length > 200) return null;
  const digest = await secretDigest("staff-invite", secret);
  return await ctx.db.query("staffInvitations").withIndex("by_secret", (q) => q.eq("secretDigest", digest)).unique();
}

export async function projectInvitationBySecret(ctx: Ctx, secret: string) {
  if (!secret || secret.length > 200) return null;
  const digest = await secretDigest("project-invite", secret);
  return await ctx.db.query("projectInvitations").withIndex("by_secret", (q) => q.eq("secretDigest", digest)).unique();
}

export async function createProjectInvitation(ctx: MutationCtx, projectId: Id<"projects">, createdByStaffId: Id<"staff">) {
  const epoch = await namedIdentityEpoch(ctx, "invitation");
  // The pilot allowlist bounds which Projects can enroll customers.
  const project = await activeDeploymentProject(ctx, projectId);
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  const secret = newInvitationSecret();
  const now = Date.now();
  const invitationId = await ctx.db.insert("projectInvitations", {
    eligibilityConfirmed: true, projectId, secretDigest: await secretDigest("project-invite", secret), status: "pending",
    expiresAt: now + PROJECT_INVITE_TTL_MS, createdByStaffId, createdAt: now, updatedAt: now, ...epochStamp(epoch),
  });
  await audit(ctx, "project_invitation.created", { actorStaffId: createdByStaffId, detail: project.key });
  return { invitationId, secret, expiresAt: now + PROJECT_INVITE_TTL_MS };
}

async function requireProjectInvitation(ctx: Ctx, secret: string) {
  const invite = await projectInvitationBySecret(ctx, secret);
  if (!invite?.eligibilityConfirmed) throw new Error("INVITE_NOT_FOUND");
  await requireInvitationEpoch(ctx, invite);
  return invite;
}

/** Rejects unusable invitations with a specific code; the Project must be active. */
export async function requireRedeemableProjectInvitation(ctx: Ctx, secret: string) {
  const invite = await requireProjectInvitation(ctx, secret);
  const problem = invitationState(invite);
  if (problem) throw new Error(problem);
  const project = await activeDeploymentProject(ctx, invite.projectId);
  if (!project) throw new Error("INVITE_NOT_FOUND");
  return { invite, project };
}

/** A completed Join can be replayed by its redeemer while membership is still active. */
export async function joinProjectInvitation(ctx: MutationCtx, secret: string, customerId: Id<"customers">) {
  const invite = await requireProjectInvitation(ctx, secret);
  if (!await activeDeploymentProject(ctx, invite.projectId)) throw new Error("INVITE_NOT_FOUND");
  const problem = invitationState(invite);
  if (!problem) return await redeemProjectInvitation(ctx, invite, customerId);
  if (problem === "INVITE_USED" && invite.redeemedByCustomerId === customerId
    && await isMember(ctx, invite.projectId, { role: "customer", customerId })) {
    return { status: "already_member" as const, projectId: invite.projectId };
  }
  throw new Error(problem);
}

/** Adds the Project to the customer; existing membership does not use the invite. */
export async function redeemProjectInvitation(ctx: MutationCtx, invite: Doc<"projectInvitations">, customerId: Id<"customers">) {
  if (await isMember(ctx, invite.projectId, { role: "customer", customerId })) {
    return { status: "already_member" as const, projectId: invite.projectId };
  }
  await ctx.db.insert("projectMembers", { projectId: invite.projectId, customerId, createdAt: Date.now() });
  await ctx.db.patch(invite._id, { status: "redeemed", redeemedByCustomerId: customerId, updatedAt: Date.now() });
  await audit(ctx, "project_invitation.redeemed", { customerId });
  return { status: "joined" as const, projectId: invite.projectId };
}

// ---------------------------------------------------------------- recovery codes

/** Reveals a fresh code once; any previous code stops working. */
export async function issueRecoveryCode(ctx: MutationCtx, customer: Doc<"customers">) {
  const code = encodeRecoveryCode(randomBytes(16));
  await ctx.db.patch(customer._id, {
    recoveryCodeDigest: await recoveryCodeDigest(customer._id, customer.generation, code),
    recoveryCodeGeneration: customer.generation, recoveryCodeCreatedAt: Date.now(), updatedAt: Date.now(),
  });
  await audit(ctx, "recovery_code.issued", { customerId: customer._id });
  return formatRecoveryCode(code);
}

export async function recoveryCodeMatches(customer: Doc<"customers"> | null, input: string) {
  const canonical = canonicalRecoveryCode(input);
  const digest = await recoveryCodeDigest(customer?._id ?? "", customer?.recoveryCodeGeneration ?? customer?.generation ?? 0, canonical ?? "0".repeat(26));
  const matches = constantTimeEquals(digest, customer?.recoveryCodeDigest ?? "0".repeat(64));
  return canonical !== null && customer?.recoveryCodeDigest !== undefined && matches;
}

/** The caller has verified recovery proof and validated the password. */
export async function replaceCustomerPassword(
  ctx: MutationCtx,
  customer: Doc<"customers">,
  password: string,
) {
  const rateLimitKey = await customerCredentialSelector(customer.username);
  const stored = await ctx.runMutation(components.authPassword.public._internal_dangerous_setPassword, {
    userId: customer.userId, password, minimumLength: PASSWORD_MIN_CODE_POINTS, requireDifferent: true, rateLimitKey,
  });
  if (!stored.success) return { success: false as const, error: stored.userError.error };
  const now = Date.now();
  await ctx.db.patch(customer._id, {
    generation: customer.generation + 1, validAfter: now, updatedAt: now,
    recoveryCodeDigest: undefined, recoveryCodeGeneration: undefined, recoveryCodeCreatedAt: undefined, recoveryEnrollmentRequired: true,
  });
  await revokeUserSessions(ctx, customer.userId);
  await clearAttempts(ctx, rateLimitKey);
  await clearAttempts(ctx, recoveryAttemptKey(rateLimitKey));
  return { success: true as const };
}

// ---------------------------------------------------------------- action proof

export type ChallengePurpose = "staff-invite" | "staff-role" | "staff-disable" | "staff-enable"
  | "staff-invite-create" | "staff-invite-reissue" | "staff-google-binding"
  | "t3-key-issue" | "t3-key-rotate" | "t3-key-revoke";

/** T3 key proof binds the deployment, principal, generation and exact intended change. */
export function t3ChallengeIntent(admission: Doc<"sessionAdmissions">, intendedChange: string) {
  return JSON.stringify([1, process.env.CONVEX_CLOUD_URL ?? "", admission.staffId ?? null, admission.generation, intendedChange]);
}

export function challengeKey() {
  const key = process.env.IDENTITY_CODE_KEY;
  if (!key || key.length < 32) throw new Error("IDENTITY_SENDER_UNAVAILABLE");
  return key;
}

export async function intentDigest(purpose: ChallengePurpose, intent: string) {
  return await sha256Hex(`intent:v1:${purpose}:${intent}`);
}

/** Share the budget across sessions, proof purposes and retries to the same mailbox. */
export async function reserveChallengeEmail(ctx: MutationCtx, admission: Doc<"sessionAdmissions">, email: string) {
  const principalKey = `proof-email:principal:${admission.staffId ?? admission.userId}`;
  const mailboxKey = `proof-email:mailbox:${await sha256Hex(email.toLowerCase())}`;
  if (await budgetExhausted(ctx, principalKey) || await budgetExhausted(ctx, mailboxKey)) return false;
  await recordAttemptFailure(ctx, principalKey, CHALLENGE_EMAIL_GUARD);
  await recordAttemptFailure(ctx, mailboxKey, CHALLENGE_EMAIL_GUARD);
  return true;
}

/** Replaces earlier challenges of the same purpose for this session. */
export async function createChallenge(ctx: MutationCtx, admission: Doc<"sessionAdmissions">, purpose: ChallengePurpose, intent: string, code: string) {
  const key = challengeKey();
  const now = Date.now();
  for (const earlier of await ctx.db.query("identityChallenges").withIndex("by_admission", (q) =>
    q.eq("admissionId", admission._id).eq("purpose", purpose)).take(10)) {
    if (earlier.consumedAt === undefined) await ctx.db.patch(earlier._id, { consumedAt: now });
  }
  const challengeId = await ctx.db.insert("identityChallenges", {
    admissionId: admission._id, purpose, intentDigest: await intentDigest(purpose, intent),
    codeDigest: "", failedAttempts: 0, expiresAt: now + CHALLENGE_TTL_MS, createdAt: now,
  });
  // Deletion belongs only to the approved retention job (pilot_retention:expire).
  await ctx.db.patch(challengeId, { codeDigest: await challengeCodeDigest(key, challengeId, code) });
  return challengeId;
}

/**
 * Consumes proof in the caller's transaction. A wrong code is returned (so the
 * failure count commits); a missing, expired, exhausted or mismatched-intent
 * challenge is PROOF_REQUIRED.
 */
export async function consumeChallenge(ctx: MutationCtx, admission: Doc<"sessionAdmissions">, purpose: ChallengePurpose, intent: string, code: string, challengeId?: string) {
  const challenge = (await ctx.db.query("identityChallenges").withIndex("by_admission", (q) =>
    q.eq("admissionId", admission._id).eq("purpose", purpose)).order("desc").first());
  if (!challenge || (challengeId !== undefined && challenge._id !== challengeId)
    || challenge.consumedAt !== undefined || challenge.expiresAt <= Date.now()
    || challenge.failedAttempts >= CHALLENGE_MAX_FAILURES
    || challenge.intentDigest !== await intentDigest(purpose, intent)) return { ok: false as const, error: "PROOF_REQUIRED" as const };
  const expected = await challengeCodeDigest(challengeKey(), challenge._id, code.replace(/\s/g, ""));
  if (!constantTimeEquals(expected, challenge.codeDigest)) {
    await ctx.db.patch(challenge._id, { failedAttempts: challenge.failedAttempts + 1 });
    return { ok: false as const, error: "INVALID_CODE" as const };
  }
  await ctx.db.patch(challenge._id, { consumedAt: Date.now() });
  return { ok: true as const };
}
