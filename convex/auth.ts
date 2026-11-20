/**
 * Convex Auth 2.0.0 adapters. One core; staff use Google, customers use a
 * username and password. Every completed sign-in inserts its admission in the
 * same mutation that minted the session (see authMethodMutation).
 */
import { v } from "convex/values";
import type { FunctionReturnType } from "convex/server";
import { setupConvexAuth, type AuthCore } from "@convex-dev/auth/server";
import { setupGoogle } from "@convex-dev/auth/methods/google/server";
import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  authCoreEndpoint, authMethodMutation, identityAction, internalPasswordSignInMutation, publicIdentityMutation,
  wrapPackageMutation, type AuthMethodCtx, type MethodBuilders,
} from "./functions";
import { accessTokenSessionId, checkNewPassword, normalizeDisplayName, normalizeUsername, PASSWORD_MIN_CODE_POINTS } from "./identity_rules";
import {
  admitGoogleCompletion, admitSession, audit, budgetExhausted, clearAttempts, INVITE_GUARD, recordAttemptFailure,
  recordGoogleFlow, recoveryCodeMatches, redeemProjectInvitation, requireRedeemableProjectInvitation, revokeUserSessions,
  verifyCustomerPassword, reserveUnrecognizedPasswordVerification, customerCredentialSelector, recoveryAttemptKey,
  replaceCustomerPassword, RECOVERY_GUARD, CREDENTIAL_INGRESS_GUARD,
} from "./domain/identity";
import { requireActor } from "./session_auth";
import { requireLocalFixtures } from "./local_fixtures";
import { epochStamp, namedIdentityEpoch } from "./pilot_access";
import { customerCredentialIsCurrent, identityRecoveryAdmission } from "./identity_recovery_access";

const core = setupConvexAuth({ component: components.auth, usersTable: "users" });

export const refreshSession = wrapPackageMutation("refresh-session", core.refreshSession, {
  name: "auth:refreshSession",
  args: { refreshToken: v.string() },
  handler: async (ctx, args) => {
    const pilot = await identityRecoveryAdmission(ctx);
    const result = await ctx.runInner(args) as FunctionReturnType<typeof components.auth.public.refresh>;
    if (!pilot || result.kind !== "rotated") return result;
    const sessionId = accessTokenSessionId(result.tokens.accessToken);
    const admission = await ctx.db.query("sessionAdmissions").withIndex("by_auth_session", q => q.eq("authSessionId", sessionId)).unique();
    if (admission?.pilotEpoch === pilot.epoch && admission.userId === result.tokens.userId && admission.revokedAt === undefined) return result;
    await ctx.runMutation(components.auth.public.revokeSessions, { sessionIds: [sessionId] });
    return { kind: "noSession" as const };
  },
});
export const signOut = authCoreEndpoint("sign-out", core.signOut);
export const isAuthenticated = authCoreEndpoint("is-authenticated", core.isAuthenticated);

// ------------------------------------------------------------------ Google

function allowedRedirectOrigins() {
  const origins = (process.env.AUTH_REDIRECT_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean);
  // Push-time evaluation needs a value; the local default is the Vite port range.
  return origins.length ? origins : ["http://localhost:5173"];
}

/**
 * setupGoogle binds its completion through the core. This core decoration wraps
 * that one builder so the stock ticket redemption, the app's flow check and
 * admission run in one mutation.
 */
const admittingCore: AuthCore<"users"> = {
  ...core,
  bindMethod: (options) => {
    const builders = core.bindMethod(options);
    return {
      authMutation: ((fn: { handler: (ctx: never, args: { code: string; state: string }) => Promise<unknown> }) =>
        authMethodMutation(builders, "google-complete")({
          name: "auth:completeSignInWithGoogle",
          args: { code: v.string(), state: v.string() },
          handler: async (ctx, args: { code: string; state: string }) => {
            const result = await fn.handler(ctx as never, args) as { status: string; tokens?: { accessToken: string; userId: string } };
            if (result.status === "complete" && result.tokens) await admitGoogleCompletion(ctx, result.tokens, args.state);
            return result;
          },
        })) as never,
    };
  },
};

const google = setupGoogle(admittingCore, {
  component: components.authGoogle,
  allowedRedirectOrigins: allowedRedirectOrigins(),
}).attachUserCallbacks({
  createUser: internal.identity.createGoogleUser,
  onSignIn: internal.identity.syncGoogleProfile,
});

export const completeSignInWithGoogle = google.completeSignInWithGoogle;

/** Records the one-use flow beside the stock authorization request. */
export const startSignInWithGoogle = wrapPackageMutation("google-start", google.startSignInWithGoogle, {
  name: "auth:startSignInWithGoogle",
  args: { redirectTo: v.string() },
  handler: async (ctx, args) => {
    const started = await ctx.runInner(args) as { redirect: string; state: string };
    await recordGoogleFlow(ctx, started.state);
    return started;
  },
});

// ------------------------------------------------------------------ customer username/password

const password: MethodBuilders = core.bindMethod({
  name: "customerPassword",
  createUser: internal.identity.createCustomerUser,
});

const failure = (error: string, extra: Record<string, number> = {}) => ({ status: "error" as const, userError: { error, ...extra } });

async function userIdForUsername(ctx: Pick<MutationCtx, "runQuery">, username: string) {
  return await ctx.runQuery(components.authUsername.public.getUserIdByUsername, { username });
}

/** Generic failure for unknown, disabled and wrong-password attempts. */
const passwordSignInArgs = { username: v.string(), password: v.string() };
type PasswordSignInResult = ReturnType<typeof failure> | {
  status: "complete";
  tokens: Awaited<ReturnType<AuthMethodCtx["convexAuth"]["completeSignIn"]>>;
};

export const signInWithPassword = identityAction("customer-sign-in")({
  name: "auth:signInWithPassword",
  args: passwordSignInArgs,
  handler: async (ctx, args): Promise<PasswordSignInResult> => {
    const result = await ctx.runMutation(internal.auth.attemptPasswordSignIn, args);
    if (result.status !== "dummy") return result;
    // Only the committed reservation authorizes expensive work. No submitted
    // credentials are needed in the dummy action.
    await ctx.runAction(components.authPassword.public.runDummyVerification, {});
    return failure("INVALID_CREDENTIALS");
  },
});

export const attemptPasswordSignIn = internalPasswordSignInMutation(password, {
  name: "auth:attemptPasswordSignIn",
  args: passwordSignInArgs,
  handler: async (ctx, args) => {
    const pilot = await identityRecoveryAdmission(ctx);
    let username: string;
    try { username = normalizeUsername(args.username); } catch { return failure("INVALID_CREDENTIALS"); }
    const [userId, customer, rateLimitKey] = await Promise.all([
      userIdForUsername(ctx, username),
      ctx.db.query("customers").withIndex("by_username", (q) => q.eq("username", username)).unique(),
      customerCredentialSelector(username),
    ]);
    const password = args.password.normalize("NFC");
    if (!customer || customer.userId !== userId || customer.status !== "active" || !customerCredentialIsCurrent(customer, pilot)) {
      return await reserveUnrecognizedPasswordVerification(ctx, { password, rateLimitKey })
        ? { status: "dummy" as const } : failure("INVALID_CREDENTIALS");
    }
    const verified = await verifyCustomerPassword(ctx, {
      userId: customer.userId, password, rateLimitKey,
    });
    if (!verified.success) return failure("INVALID_CREDENTIALS");
    const tokens = await ctx.convexAuth.completeSignIn({ userId: customer.userId, profile: { kind: "customer" }, authenticatedBy: components.authPassword });
    await admitSession(ctx, tokens, { principal: "customer", customer }, "password");
    return { status: "complete" as const, tokens };
  },
});

/**
 * Invitation-bound signup: credential, customer, membership, admission and
 * invite consumption commit together or not at all.
 */
export const signUpWithInvitation = authMethodMutation(password, "customer-sign-up")({
  name: "auth:signUpWithInvitation",
  args: { invitation: v.string(), username: v.string(), displayName: v.string(), password: v.string() },
  handler: async (ctx, args) => {
    const pilot = await identityRecoveryAdmission(ctx);
    // Staff and existing customers switch account or use the join path.
    if (await ctx.auth.getUserIdentity()) return failure("SIGN_OUT_REQUIRED");
    const { invite } = await requireRedeemableProjectInvitation(ctx, args.invitation);
    const inviteKey = `invite:${invite._id}`;
    if (await budgetExhausted(ctx, inviteKey)) return failure("RATE_LIMITED", { retryAfterMs: INVITE_GUARD.lockoutMs });
    let username: string;
    let displayName: string;
    try { username = normalizeUsername(args.username); }
    catch (error) {
      await recordAttemptFailure(ctx, inviteKey, INVITE_GUARD);
      return failure((error as Error).message);
    }
    try { displayName = normalizeDisplayName(args.displayName); } catch { return failure("INVALID_DISPLAY_NAME"); }
    const checked = checkNewPassword(args.password);
    if ("problem" in checked) return failure(checked.problem);
    if (await userIdForUsername(ctx, username)
      || await ctx.db.query("customers").withIndex("by_username", (q) => q.eq("username", username)).unique()) {
      await recordAttemptFailure(ctx, inviteKey, INVITE_GUARD);
      return failure("USERNAME_TAKEN");
    }
    const tokens = await ctx.convexAuth.completeSignUp({ profile: { kind: "customer" }, authenticatedBy: components.authPassword });
    const userId = tokens.userId as Id<"users">;
    const now = Date.now();
    const customerId = await ctx.db.insert("customers", {
      userId, username, displayName, status: "active", generation: 1, validAfter: now, createdAt: now, updatedAt: now,
      ...epochStamp(await namedIdentityEpoch(ctx, "invitation")),
      credentialEpoch: pilot?.epoch,
      recoveryEnrollmentRequired: true,
    });
    await ctx.db.patch(userId, { customerId });
    const named = await ctx.runMutation(components.authUsername.public.setUsername, { userId, username });
    if (!named.success) throw new Error("USERNAME_TAKEN");
    const stored = await ctx.runMutation(components.authPassword.public._internal_dangerous_setPassword, {
      userId, password: checked.password, minimumLength: PASSWORD_MIN_CODE_POINTS,
      rateLimitKey: await customerCredentialSelector(username),
    });
    // Rolls back the principal, session and invite with it.
    if (!stored.success) throw new Error(stored.userError.error);
    await redeemProjectInvitation(ctx, invite, customerId);
    await admitSession(ctx, tokens, { principal: "customer", customer: (await ctx.db.get(customerId))! }, "password");
    await clearAttempts(ctx, inviteKey);
    await audit(ctx, "customer.enrolled", { customerId });
    return { status: "complete" as const, tokens };
  },
});

/** Verifies the old password and revokes the customer's other sessions. */
export const changePassword = authMethodMutation(password, "customer-change-password")({
  name: "auth:changePassword",
  args: { currentPassword: v.string(), newPassword: v.string() },
  handler: async (ctx, args) => {
    const { actor, session } = await requireActor(ctx);
    if (actor.role !== "customer") throw new Error("CUSTOMER_ONLY");
    const checked = checkNewPassword(args.newPassword);
    if ("problem" in checked) return { success: false as const, error: checked.problem };
    const customer = (await ctx.db.get(actor.customerId!))!;
    const verified = await verifyCustomerPassword(ctx, {
      userId: session.userId, password: args.currentPassword.normalize("NFC"),
      rateLimitKey: await customerCredentialSelector(customer.username),
    });
    if (!verified.success) {
      return { success: false as const, error: verified.userError.error === "RATE_LIMITED" ? "RATE_LIMITED" : "INVALID_CREDENTIALS" };
    }
    const stored = await ctx.runMutation(components.authPassword.public._internal_dangerous_setPassword, {
      userId: session.userId, password: checked.password, minimumLength: PASSWORD_MIN_CODE_POINTS,
    });
    if (!stored.success) return { success: false as const, error: stored.userError.error };
    await revokeUserSessions(ctx, session.userId, session.authSessionId);
    await audit(ctx, "customer.password_changed", { customerId: actor.customerId });
    return { success: true as const };
  },
});

/**
 * Saved-code recovery: digest, active identity and generation, then password
 * write, code consumption, generation increment and revocation of every
 * session in one transaction. No session is issued.
 */
export const recoverWithCode = publicIdentityMutation("customer-recover")({
  name: "auth:recoverWithCode",
  args: { username: v.string(), recoveryCode: v.string(), newPassword: v.string() },
  handler: async (ctx, args) => {
    const pilot = await identityRecoveryAdmission(ctx);
    const reject = { success: false as const, error: "RECOVERY_FAILED" };
    let username: string;
    try { username = normalizeUsername(args.username); } catch { return reject; }
    const customer = await ctx.db.query("customers").withIndex("by_username", (q) => q.eq("username", username)).unique();
    // Match the high-entropy proof before consulting any budget debited by guesses.
    const matches = await recoveryCodeMatches(customer, args.recoveryCode);
    if (!matches || customer?.status !== "active" || !customerCredentialIsCurrent(customer, pilot)) {
      const rpcKey = "recover:invalid-rpc";
      if (!await budgetExhausted(ctx, rpcKey)) {
        const selectorKey = recoveryAttemptKey(await customerCredentialSelector(username));
        if (!await budgetExhausted(ctx, selectorKey)) {
          await recordAttemptFailure(ctx, rpcKey, CREDENTIAL_INGRESS_GUARD);
          await recordAttemptFailure(ctx, selectorKey, RECOVERY_GUARD);
        }
      }
      return reject;
    }
    const checked = checkNewPassword(args.newPassword);
    if ("problem" in checked) return { success: false as const, error: checked.problem };
    const result = await replaceCustomerPassword(ctx, customer, checked.password);
    if (!result.success) return result;
    await audit(ctx, "customer.recovered", { customerId: customer._id });
    return { success: true as const };
  },
});

// ------------------------------------------------------------------ local test provider

const fixture: MethodBuilders = core.bindMethod({ name: "localFixture", createUser: internal.identity.createCustomerUser });

/**
 * Disposable-backend stand-in for Google (staff by email) and a password-free
 * customer session for browser fixtures (by username), through the same core,
 * admission and generation checks. Refused unless LOCAL_FIXTURES_ENABLED and a
 * loopback CONVEX_CLOUD_URL.
 */
export const signInLocalFixture = authMethodMutation(fixture, "local-fixture")({
  name: "auth:signInLocalFixture",
  args: { email: v.optional(v.string()), username: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireLocalFixtures();
    if (args.username !== undefined) {
      const customer = await ctx.db.query("customers").withIndex("by_username", (q) => q.eq("username", args.username!.trim().toLowerCase())).unique();
      if (!customer || customer.status !== "active") return failure("INVALID_CREDENTIALS");
      const tokens = await ctx.convexAuth.completeSignIn({ userId: customer.userId, profile: {}, authenticatedBy: components.authPassword });
      await admitSession(ctx, tokens, { principal: "customer", customer }, "password");
      return { status: "complete" as const, tokens };
    }
    const staff = await ctx.db.query("staff").withIndex("by_email", (q) => q.eq("email", (args.email ?? "").trim().toLowerCase())).unique();
    if (!staff || staff.status !== "active") return failure("INVALID_CREDENTIALS");
    const tokens = await ctx.convexAuth.completeSignIn({ userId: staff.userId, profile: {}, authenticatedBy: components.authGoogle });
    await admitSession(ctx, tokens, { principal: "staff", staff }, "google");
    return { status: "complete" as const, tokens };
  },
});
