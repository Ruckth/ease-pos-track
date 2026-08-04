import { v } from "convex/values";
import { action, internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  assertPasswordIsNotEmail,
  normalizeCustomerEmail,
  PASSWORD_MAX_LENGTH,
  validateClientId,
  validateCustomerEmail,
  validateCustomerPassword,
} from "./customer_validation";
import {
  CUSTOMER_GLOBAL_ATTEMPT_KEY,
  CUSTOMER_GLOBAL_GUARD,
  CUSTOMER_GUARD,
  customerAttemptKey,
  isLockedOut,
  planFailure,
} from "./login_guard";
import {
  createPasswordRecord,
  DECOY_PASSWORD_RECORD,
  resolvePasswordPepper,
  verifyPasswordRecord,
  type PasswordRecord,
} from "./password";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;

/**
 * Required deployment secret mixed into every derivation, so a leaked customers
 * table is not enough to mount an offline dictionary attack.
 *
 * There is no fallback: without it the account paths fail closed with a stable,
 * localized code rather than silently writing weaker hashes that would then be
 * invalidated the moment the pepper is configured. Both sign-up and sign-in check
 * it before any database work, so the failure is identical for every caller and
 * cannot be used to probe which emails exist.
 */
function requirePasswordPepper() {
  return resolvePasswordPepper(process.env.CUSTOMER_PASSWORD_PEPPER);
}

function makeToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readAttempts(ctx: MutationCtx, clientId: string) {
  return await ctx.db
    .query("loginAttempts")
    .withIndex("by_client_id", (q) => q.eq("clientId", clientId))
    .unique();
}

async function writeAttempts(
  ctx: MutationCtx,
  clientId: string,
  existing: { _id: Id<"loginAttempts"> } | null,
  record: { attempts: number; firstAttemptAt: number; lockedUntil?: number },
  now: number,
) {
  const value = { clientId, ...record, updatedAt: now };
  if (existing) await ctx.db.replace(existing._id, value);
  else await ctx.db.insert("loginAttempts", value);
}

async function recordFailure(ctx: MutationCtx, clientId: string) {
  const now = Date.now();
  const scopedKey = customerAttemptKey(clientId);
  const scoped = await readAttempts(ctx, scopedKey);
  const global = await readAttempts(ctx, CUSTOMER_GLOBAL_ATTEMPT_KEY);
  await writeAttempts(ctx, scopedKey, scoped, planFailure(scoped, now, CUSTOMER_GUARD), now);
  await writeAttempts(
    ctx,
    CUSTOMER_GLOBAL_ATTEMPT_KEY,
    global,
    planFailure(global, now, CUSTOMER_GLOBAL_GUARD),
    now,
  );
}

async function assertNotLockedOut(ctx: MutationCtx, clientId: string) {
  const scoped = await readAttempts(ctx, customerAttemptKey(clientId));
  const global = await readAttempts(ctx, CUSTOMER_GLOBAL_ATTEMPT_KEY);
  if (isLockedOut([scoped, global], Date.now())) throw new Error("AUTH_RATE_LIMITED");
}

async function clearFailures(ctx: MutationCtx, clientId: string) {
  const scoped = await readAttempts(ctx, customerAttemptKey(clientId));
  if (scoped) await ctx.db.delete(scoped._id);
}

async function issueCustomerSession(ctx: MutationCtx, customerId: Id<"customers">, clientId: string) {
  const now = Date.now();
  const expiredSessions = await ctx.db
    .query("sessions")
    .withIndex("by_expires_at", (q) => q.lt("expiresAt", now))
    .take(100);
  await Promise.all(expiredSessions.map((session) => ctx.db.delete(session._id)));

  const token = makeToken();
  await ctx.db.insert("sessions", {
    token,
    clientId,
    role: "customer",
    customerId,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  });
  return { token, expiresAt: now + SESSION_TTL_MS };
}

export const startRegistration = internalMutation({
  args: { email: v.string(), clientId: v.string() },
  handler: async (ctx, args) => {
    await assertNotLockedOut(ctx, args.clientId);
    const existing = await ctx.db
      .query("customers")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .unique();
    // A duplicate sign-up is a failed attempt, otherwise registration becomes an
    // unthrottled probe for which emails already have accounts.
    if (existing) {
      await recordFailure(ctx, args.clientId);
      throw new Error("EMAIL_ALREADY_REGISTERED");
    }
  },
});

export const finishRegistration = internalMutation({
  args: {
    email: v.string(),
    clientId: v.string(),
    passwordAlgorithm: v.string(),
    passwordSalt: v.string(),
    passwordHash: v.string(),
    passwordIterations: v.number(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("customers")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .unique();
    if (existing) throw new Error("EMAIL_ALREADY_REGISTERED");

    const customerId = await ctx.db.insert("customers", {
      email: args.email,
      passwordAlgorithm: args.passwordAlgorithm,
      passwordSalt: args.passwordSalt,
      passwordHash: args.passwordHash,
      passwordIterations: args.passwordIterations,
      createdAt: now,
      updatedAt: now,
    });
    await clearFailures(ctx, args.clientId);
    return await issueCustomerSession(ctx, customerId, args.clientId);
  },
});

export const startLogin = internalMutation({
  args: { email: v.string(), clientId: v.string() },
  handler: async (ctx, args) => {
    await assertNotLockedOut(ctx, args.clientId);
    const customer = await ctx.db
      .query("customers")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .unique();
    if (!customer) return { customerId: null, record: DECOY_PASSWORD_RECORD };
    return {
      customerId: customer._id,
      record: {
        passwordAlgorithm: customer.passwordAlgorithm,
        passwordSalt: customer.passwordSalt,
        passwordHash: customer.passwordHash,
        passwordIterations: customer.passwordIterations,
      } satisfies PasswordRecord,
    };
  },
});

export const failLogin = internalMutation({
  args: { clientId: v.string() },
  handler: async (ctx, args) => {
    await recordFailure(ctx, args.clientId);
  },
});

export const finishLogin = internalMutation({
  args: { customerId: v.id("customers"), clientId: v.string() },
  handler: async (ctx, args) => {
    const customer = await ctx.db.get(args.customerId);
    if (!customer) throw new Error("INVALID_CREDENTIALS");
    await clearFailures(ctx, args.clientId);
    return await issueCustomerSession(ctx, customer._id, args.clientId);
  },
});

/**
 * Sign-up runs as an action because PBKDF2 derivation is CPU heavy; all database
 * work happens in the internal mutations above.
 */
export const register = action({
  args: { email: v.string(), password: v.string(), clientId: v.string() },
  handler: async (ctx, args): Promise<{ token: string; expiresAt: number }> => {
    // Checked first: a deployment with no pepper must not create accounts at all.
    const pepper = requirePasswordPepper();
    const email = validateCustomerEmail(args.email);
    const password = validateCustomerPassword(args.password);
    assertPasswordIsNotEmail(email, password);
    const clientId = validateClientId(args.clientId);

    await ctx.runMutation(internal.customers.startRegistration, { email, clientId });
    const record = await createPasswordRecord(password, pepper);
    return await ctx.runMutation(internal.customers.finishRegistration, {
      email,
      clientId,
      ...record,
    });
  },
});

export const login = action({
  args: { email: v.string(), password: v.string(), clientId: v.string() },
  handler: async (ctx, args): Promise<{ token: string; expiresAt: number }> => {
    // Checked before the lookup, so a misconfigured deployment fails the same way
    // for every email instead of only for accounts that exist.
    const pepper = requirePasswordPepper();
    const email = normalizeCustomerEmail(args.email);
    const clientId = validateClientId(args.clientId);

    const challenge = await ctx.runMutation(internal.customers.startLogin, { email, clientId });
    // Oversized submissions are a failed attempt, not free derivation work.
    const withinBounds = args.password.length > 0 && args.password.length <= PASSWORD_MAX_LENGTH;
    // The decoy record keeps the work identical for unknown emails.
    const verified = withinBounds
      && await verifyPasswordRecord(args.password, pepper, challenge.record);
    if (!verified || challenge.customerId === null) {
      await ctx.runMutation(internal.customers.failLogin, { clientId });
      throw new Error("INVALID_CREDENTIALS");
    }
    return await ctx.runMutation(internal.customers.finishLogin, {
      customerId: challenge.customerId,
      clientId,
    });
  },
});

