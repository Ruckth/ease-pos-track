import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { actorFromSession } from "./authz";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const LOCKOUT_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const GLOBAL_MAX_ATTEMPTS = 50;
const GLOBAL_CLIENT_ID = "__global__";

function getAppPassword() {
  const password = process.env.APP_PASSWORD;
  if (!password) throw new Error("APP_PASSWORD is not configured.");
  return password;
}

function makeToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const login = mutation({
  args: {
    password: v.string(),
    clientId: v.string(),
  },
  handler: async (ctx, args) => {
    const clientId = args.clientId.trim();
    if (clientId.length < 16 || clientId.length > 128) {
      throw new Error("INVALID_SIGNIN_CLIENT");
    }

    const now = Date.now();
    const existingAttempt = await ctx.db
      .query("loginAttempts")
      .withIndex("by_client_id", (q) => q.eq("clientId", clientId))
      .unique();
    const globalAttempt = await ctx.db
      .query("loginAttempts")
      .withIndex("by_client_id", (q) => q.eq("clientId", GLOBAL_CLIENT_ID))
      .unique();

    const lockedUntil = Math.max(existingAttempt?.lockedUntil ?? 0, globalAttempt?.lockedUntil ?? 0);
    if (lockedUntil > now) {
      throw new Error("AUTH_RATE_LIMITED");
    }

    if (args.password !== getAppPassword()) {
      const withinWindow = existingAttempt && now - existingAttempt.firstAttemptAt <= ATTEMPT_WINDOW_MS;
      const attempts = withinWindow ? existingAttempt.attempts + 1 : 1;
      const lockedUntil = attempts >= MAX_ATTEMPTS ? now + LOCKOUT_MS : undefined;
      const value = {
        clientId,
        attempts,
        firstAttemptAt: withinWindow ? existingAttempt.firstAttemptAt : now,
        ...(lockedUntil === undefined ? {} : { lockedUntil }),
        updatedAt: now,
      };
      if (existingAttempt) await ctx.db.replace(existingAttempt._id, value);
      else await ctx.db.insert("loginAttempts", value);

      const globalWithinWindow = globalAttempt && now - globalAttempt.firstAttemptAt <= ATTEMPT_WINDOW_MS;
      const globalAttempts = globalWithinWindow ? globalAttempt.attempts + 1 : 1;
      const globalLockedUntil = globalAttempts >= GLOBAL_MAX_ATTEMPTS ? now + LOCKOUT_MS : undefined;
      const globalValue = {
        clientId: GLOBAL_CLIENT_ID,
        attempts: globalAttempts,
        firstAttemptAt: globalWithinWindow ? globalAttempt.firstAttemptAt : now,
        ...(globalLockedUntil === undefined ? {} : { lockedUntil: globalLockedUntil }),
        updatedAt: now,
      };
      if (globalAttempt) await ctx.db.replace(globalAttempt._id, globalValue);
      else await ctx.db.insert("loginAttempts", globalValue);
      throw new Error("INCORRECT_PASSWORD");
    }

    if (existingAttempt) await ctx.db.delete(existingAttempt._id);

    const expiredSessions = await ctx.db
      .query("sessions")
      .withIndex("by_expires_at", (q) => q.lt("expiresAt", now))
      .take(100);
    await Promise.all(expiredSessions.map((session) => ctx.db.delete(session._id)));

    const token = makeToken();

    await ctx.db.insert("sessions", {
      token,
      clientId,
      role: "staff",
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
    });

    return { token, expiresAt: now + SESSION_TTL_MS };
  },
});

export const logout = mutation({
  args: {
    token: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    if (session) await ctx.db.delete(session._id);
  },
});

/**
 * Backward-compatible staff session check. Existing callers keep working, but a
 * customer token can never be mistaken for authorization to enter the staff UI.
 * New role-aware callers should use currentSession instead.
 */
export const validateSession = query({
  args: {
    token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const token = args.token;
    if (!token) return false;
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (!session || session.expiresAt <= Date.now()) return false;
    return actorFromSession(session).role === "staff";
  },
});

/**
 * Single source of truth for "who is signed in" on the client. Legacy sessions
 * created before the customer portal have no role and resolve to staff.
 */
export const currentSession = query({
  args: {
    token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const token = args.token;
    if (!token) return null;

    const session = await ctx.db
      .query("sessions")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (!session || session.expiresAt <= Date.now()) return null;

    const actor = actorFromSession(session);
    if (actor.role === "staff") {
      return { role: "staff" as const, expiresAt: session.expiresAt, customerId: null, email: null };
    }

    const customer = await ctx.db.get(actor.customerId);
    if (!customer) return null;
    return {
      role: "customer" as const,
      expiresAt: session.expiresAt,
      customerId: customer._id,
      email: customer.email,
    };
  },
});

export const cleanupExpiredSessions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const expiredSessions = await ctx.db
      .query("sessions")
      .withIndex("by_expires_at", (q) => q.lt("expiresAt", Date.now()))
      .take(500);
    for (const session of expiredSessions) await ctx.db.delete(session._id);
    return expiredSessions.length;
  },
});
