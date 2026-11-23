/**
 * Disposable-backend identity fixtures: named principals with real component
 * credentials and real core sessions with admission. Every helper is reached
 * only after requireLocalFixtures().
 */
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { components } from "./_generated/api";
import { admitSession } from "./domain/identity";
import { accessTokenSessionId, actorFromAdmission, PASSWORD_MIN_CODE_POINTS } from "./identity_rules";

export const LOCAL_CUSTOMER_PASSWORD = "local customer passphrase";
export const LOCAL_STAFF = [
  { email: "owner@local.test", name: "Local Owner", role: "owner" as const, subject: "local-fixture-owner" },
  { email: "staff@local.test", name: "Local Staff", role: "staff" as const, subject: "local-fixture-staff" },
];
export const LOCAL_CUSTOMERS = [
  { username: "alice", displayName: "Alice" },
  { username: "bob", displayName: "Bob" },
];

const FIXTURE_TTL = { accessTokenTtlSeconds: 3600, refreshInactivityTimeoutSeconds: 86_400, sessionMaxLifetimeSeconds: 86_400 };

export async function ensureFixtureStaff(ctx: MutationCtx, input: typeof LOCAL_STAFF[number]) {
  const existing = await ctx.db.query("staff").withIndex("by_email", (q) => q.eq("email", input.email)).unique();
  if (existing) {
    if (existing.googleSubject === input.subject && !await ctx.runQuery(components.authClerk.provider.getUserIdByAccount, { providerAccountId: input.subject })) {
      await ctx.runMutation(components.authClerk.provider._internal_dangerous_createAccount, { providerAccountId: input.subject, userId: existing.userId });
    }
    return existing;
  }
  const now = Date.now();
  const userId = await ctx.db.insert("users", {
    kind: "staff", googleSubject: input.subject, googleEmail: input.email, googleEmailVerified: true, googleName: input.name, createdAt: now,
  });
  const staffId = await ctx.db.insert("staff", {
    userId, googleSubject: input.subject, email: input.email, name: input.name, role: input.role,
    status: "active", generation: 1, validAfter: now, createdAt: now, updatedAt: now,
  });
  await ctx.db.patch(userId, { staffId });
  await ctx.runMutation(components.authClerk.provider._internal_dangerous_createAccount, { providerAccountId: input.subject, userId });
  return (await ctx.db.get(staffId))!;
}

export async function ensureFixtureCustomer(ctx: MutationCtx, input: typeof LOCAL_CUSTOMERS[number], password = LOCAL_CUSTOMER_PASSWORD) {
  const existing = await ctx.db.query("customers").withIndex("by_username", (q) => q.eq("username", input.username)).unique();
  if (existing) return existing;
  const now = Date.now();
  const userId = await ctx.db.insert("users", { kind: "customer", createdAt: now });
  const customerId = await ctx.db.insert("customers", {
    userId, username: input.username, displayName: input.displayName, status: "active", generation: 1, validAfter: now, createdAt: now, updatedAt: now,
  });
  await ctx.db.patch(userId, { customerId });
  const named = await ctx.runMutation(components.authUsername.public.setUsername, { userId, username: input.username });
  if (!named.success) throw new Error("USERNAME_TAKEN");
  const stored = await ctx.runMutation(components.authPassword.public._internal_dangerous_setPassword, {
    userId, password: password.normalize("NFC"), minimumLength: PASSWORD_MIN_CODE_POINTS,
  });
  if (!stored.success) throw new Error(stored.userError.error);
  return (await ctx.db.get(customerId))!;
}

/** A real core session plus admission, as a verified sign-in would write. */
export async function mintFixtureSession(ctx: MutationCtx, principal:
  | { principal: "staff"; staff: Doc<"staff"> } | { principal: "customer"; customer: Doc<"customers"> }
  | { principal: "pending"; userId: Id<"users"> }) {
  const userId = principal.principal === "pending" ? principal.userId
    : principal.principal === "staff" ? principal.staff.userId : principal.customer.userId;
  const customer = principal.principal === "customer";
  const tokens = await ctx.runMutation(components.auth.public._internal_dangerous_signIn, {
    claims: { method: "localFixture", profile: {} }, componentPath: customer ? "authPassword" : "authGoogle", userId, ...FIXTURE_TTL,
  });
  await admitSession(ctx, tokens, principal, customer ? "password" : "google");
  const authSessionId = accessTokenSessionId(tokens.accessToken);
  const admission = (await ctx.db.query("sessionAdmissions").withIndex("by_auth_session", (q) => q.eq("authSessionId", authSessionId)).unique())!;
  return { authSessionId, admissionId: admission._id as Id<"sessionAdmissions">, tokens };
}

/** The protected-call check for a fixture session, without a JWT transport. */
export async function fixtureAccess(ctx: QueryCtx | MutationCtx, authSessionId: string) {
  const session = await ctx.runQuery(components.auth.public.getSession, { sessionId: authSessionId });
  const admission = await ctx.db.query("sessionAdmissions").withIndex("by_auth_session", (q) => q.eq("authSessionId", authSessionId)).unique();
  const actor = actorFromAdmission<Id<"staff">, Id<"customers">>({
    sessionUserId: session?.userId ?? null, admission,
    staff: admission?.staffId ? await ctx.db.get(admission.staffId) : null,
    customer: admission?.customerId ? await ctx.db.get(admission.customerId) : null,
  });
  return { actor, session: admission! };
}
