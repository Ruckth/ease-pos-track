/**
 * convex-test with the pinned Convex Auth 2.0.0 components registered.
 *
 * Session handles in these suites are real core session IDs minted with
 * admission (seed or fixtures/identity.ts). The `token` field a test passes is
 * transport only: it is removed from the function arguments and delivered as
 * the verified JWT subject via withIdentity, exactly where a browser's access
 * token puts it. No public function accepts a token argument.
 */
import { convexTest } from "convex-test";
import { makeFunctionReference, type FunctionArgs, type FunctionReference, type FunctionReturnType } from "convex/server";
import authCore from "@convex-dev/auth/test";
import passwordComponent from "@convex-dev/auth/components/password/test";
import usernameComponent from "@convex-dev/auth/components/username/test";
import googleComponent from "@convex-dev/auth/components/google/test";
import type { Id } from "../../convex/_generated/dataModel";
import schema from "../../convex/schema";
import { modules } from "./modules";

type Modules = Record<string, () => Promise<unknown>>;
type WithToken<F extends FunctionReference<"query" | "mutation" | "action">> = FunctionArgs<F> & { token?: string };

export function identityTest(testModules: Modules = modules) {
  const t = convexTest(schema, { ...testModules, "../../convex/identityFixture.ts": () => import("./fixtures/identity") });
  authCore.registerCore(t);
  passwordComponent.registerPassword(t);
  usernameComponent.registerUsername(t);
  googleComponent.registerGoogleOauth(t);
  const route = <K extends "query" | "mutation" | "action">(kind: K) =>
    (ref: FunctionReference<K>, args: Record<string, unknown> = {}) => {
      const { token, ...rest } = args;
      const target = typeof token === "string" ? t.withIdentity({ subject: token }) : t;
      return (target[kind] as (ref: FunctionReference<K>, args: Record<string, unknown>) => Promise<unknown>)(ref, rest);
    };
  return Object.assign(Object.create(t) as typeof t, {
    query: route("query") as <F extends FunctionReference<"query">>(ref: F, args?: WithToken<F>) => Promise<FunctionReturnType<F>>,
    mutation: route("mutation") as <F extends FunctionReference<"mutation">>(ref: F, args?: WithToken<F>) => Promise<FunctionReturnType<F>>,
    action: route("action") as <F extends FunctionReference<"action">>(ref: F, args?: WithToken<F>) => Promise<FunctionReturnType<F>>,
    /** The underlying convex-test instance (no token routing). */
    raw: t,
  });
}

export type IdentityTest = ReturnType<typeof identityTest>;

export const fixtures = {
  staff: makeFunctionReference<"mutation", { email?: string; role?: "owner" | "staff"; name?: string },
    { session: string; staffId: Id<"staff">; userId: Id<"users">; refreshToken: string }>("identityFixture:staff"),
  customer: makeFunctionReference<"mutation", { username: string; password?: string; projectIds?: Id<"projects">[] },
    { session: string; customerId: Id<"customers">; userId: Id<"users">; refreshToken: string }>("identityFixture:customer"),
  session: makeFunctionReference<"mutation", { staffId?: Id<"staff">; customerId?: Id<"customers"> }, string>("identityFixture:session"),
  pending: makeFunctionReference<"mutation", { email: string; subject: string; verified?: boolean; name?: string }, { session: string; userId: Id<"users"> }>("identityFixture:pending"),
  googleCompletion: makeFunctionReference<"mutation", { userId: Id<"users">; state: string }, string>("identityFixture:googleCompletion"),
  recordFlow: makeFunctionReference<"mutation", { state: string }, null>("identityFixture:recordFlow"),
  signInWithoutAdmission: makeFunctionReference<"mutation", { userId: Id<"users"> }, unknown>("identityFixture:signInWithoutAdmission"),
};

/** The admission and principal behind a session handle. */
export async function whoami(t: IdentityTest, session: string) {
  return await t.run(async (ctx) => {
    const admission = (await ctx.db.query("sessionAdmissions").withIndex("by_auth_session", (q) => q.eq("authSessionId", session)).unique())!;
    return { admissionId: admission._id, customerId: admission.customerId, staffId: admission.staffId, userId: admission.userId };
  });
}
