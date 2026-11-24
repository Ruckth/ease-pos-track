import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { setupConvexAuth } from "@convex-dev/auth/server";
import { internalMutation } from "../../../convex/_generated/server";
import { components } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { internalPasswordSignInMutation, type MethodBuilders } from "../../../convex/functions";
import { admitGoogleCompletion, admitSession, recordGoogleFlow } from "../../../convex/domain/identity";
import { accessTokenSessionId } from "../../../convex/identity_rules";
import { ensureFixtureCustomer, ensureFixtureStaff, mintFixtureSession } from "../../../convex/local_identity";

const TTL = { accessTokenTtlSeconds: 3600, refreshInactivityTimeoutSeconds: 86_400, sessionMaxLifetimeSeconds: 86_400 };

// Test-only principals with real component credentials and admitted core sessions.
export const staff = internalMutation({
  args: { email: v.optional(v.string()), role: v.optional(v.union(v.literal("owner"), v.literal("staff"))), name: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const email = args.email ?? "owner@fixture.test";
    const member = await ensureFixtureStaff(ctx, { email, name: args.name ?? email, role: args.role ?? "owner", subject: `https://clerk.invalid|fixture-${email}` });
    const minted = await mintFixtureSession(ctx, { principal: "staff", staff: member });
    return { session: minted.authSessionId, staffId: member._id, userId: member.userId, refreshToken: minted.tokens.refreshToken };
  },
});

export const customer = internalMutation({
  args: { username: v.string(), password: v.optional(v.string()), projectIds: v.optional(v.array(v.id("projects"))) },
  handler: async (ctx, args) => {
    const member = await ensureFixtureCustomer(ctx, { username: args.username, displayName: args.username }, args.password);
    for (const projectId of args.projectIds ?? []) {
      const existing = await ctx.db.query("projectMembers").withIndex("by_project", (q) => q.eq("projectId", projectId).eq("customerId", member._id)).unique();
      if (!existing) await ctx.db.insert("projectMembers", { projectId, customerId: member._id, createdAt: Date.now() });
    }
    const minted = await mintFixtureSession(ctx, { principal: "customer", customer: member });
    return { session: minted.authSessionId, customerId: member._id, userId: member.userId, refreshToken: minted.tokens.refreshToken };
  },
});

/** Another admitted session for an existing principal (a second browser). */
export const session = internalMutation({
  args: { staffId: v.optional(v.id("staff")), customerId: v.optional(v.id("customers")) },
  handler: async (ctx, args) => {
    if (args.staffId) return (await mintFixtureSession(ctx, { principal: "staff", staff: (await ctx.db.get(args.staffId))! })).authSessionId;
    return (await mintFixtureSession(ctx, { principal: "customer", customer: (await ctx.db.get(args.customerId!))! })).authSessionId;
  },
});

/** A pending Google identity with an admitted pending-only session. */
export const pending = internalMutation({
  args: { email: v.string(), subject: v.string(), verified: v.optional(v.boolean()), name: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await ctx.db.insert("users", {
      kind: "pending", googleSubject: args.subject, googleEmail: args.email, googleEmailVerified: args.verified ?? true,
      ...(args.name ? { googleName: args.name } : {}), createdAt: Date.now(),
    });
    await ctx.runMutation(components.authClerk.provider._internal_dangerous_createAccount, { providerAccountId: args.subject, userId });
    const tokens = await ctx.runMutation(components.auth.public._internal_dangerous_signIn, {
      claims: { method: "google", profile: {} }, componentPath: "authGoogle", userId, ...TTL,
    });
    await admitSession(ctx, tokens, { principal: "pending" }, "google");
    return { session: accessTokenSessionId(tokens.accessToken), userId };
  },
});

/**
 * Google completion seam: a just-minted core session for `userId`, then the
 * application's flow and admission check exactly as the wrapped completion runs it.
 */
export const googleCompletion = internalMutation({
  args: { userId: v.id("users"), state: v.string() },
  handler: async (ctx, args) => {
    const tokens = await ctx.runMutation(components.auth.public._internal_dangerous_signIn, {
      claims: { method: "google", profile: {} }, componentPath: "authGoogle", userId: args.userId, ...TTL,
    });
    await admitGoogleCompletion(ctx, tokens, args.state);
    return accessTokenSessionId(tokens.accessToken);
  },
});

export const recordFlow = internalMutation({
  args: { state: v.string() },
  handler: async (ctx, args) => { await recordGoogleFlow(ctx, args.state); },
});

const testCore = setupConvexAuth({ component: components.auth });
const noAdmission: MethodBuilders = testCore.bindMethod({
  name: "testNoAdmission",
  createUser: makeFunctionReference<"mutation", { method: { name: string; profile: unknown } }, Id<"users">>("identity:createCustomerUser") as never,
});
/** Completes a sign-in but never admits it: the adapter must roll everything back. */
export const signInWithoutAdmission = internalPasswordSignInMutation(noAdmission, {
  name: "identityFixture:signInWithoutAdmission",
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const tokens = await ctx.convexAuth.completeSignIn({ userId: args.userId, profile: {}, authenticatedBy: components.authPassword });
    return { status: "complete" as const, tokens };
  },
});

/** Force an abort after restore credential replacement has succeeded. */
export const replaceThenAbort = internalMutation({
  args: { caseId: v.id("customerRestoreCases"), epoch: v.string(), envelope: v.object({ iv: v.bytes(), ciphertext: v.bytes() }) },
  handler: async (ctx, args) => {
    const ref = makeFunctionReference<"mutation", typeof args, { success: boolean }>("identity_restore:replacePassword");
    const result = await ctx.runMutation(ref, args);
    if (!result.success) throw new Error("REPLACEMENT_DID_NOT_RUN");
    throw new Error("FORCED_RESTORE_ROLLBACK");
  },
});
