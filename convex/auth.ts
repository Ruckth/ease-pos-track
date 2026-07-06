import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;

function getAppPassword() {
  return process.env.APP_PASSWORD ?? "easepos";
}

function makeToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const login = mutation({
  args: {
    password: v.string(),
  },
  handler: async (ctx, args) => {
    if (args.password !== getAppPassword()) {
      throw new Error("Incorrect password");
    }

    const now = Date.now();
    const token = makeToken();

    await ctx.db.insert("sessions", {
      token,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
    });

    return { token, expiresAt: now + SESSION_TTL_MS };
  },
});

export const validateSession = query({
  args: {
    token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const token = args.token;
    if (!token) {
      return false;
    }

    const session = await ctx.db
      .query("sessions")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();

    return Boolean(session && session.expiresAt > Date.now());
  },
});
