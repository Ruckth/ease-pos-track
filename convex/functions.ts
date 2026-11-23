/** The only module allowed to register Convex functions. */
import type { RoutableMethod } from "convex/server";
import { T3_DOCTOR_PATH } from "../shared/t3-doctor";
import { t3Identity, type T3Admission } from "./t3_identity";
import { v, ConvexError, type ObjectType, type PropertyValidators } from "convex/values";
import { query, mutation, action, internalQuery, internalMutation, internalAction, httpAction } from "./_generated/server";
import type { QueryCtx, MutationCtx, ActionCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import type { RegisteredMutation } from "convex/server";
import { components } from "./_generated/api";
import { requireActor, requirePendingIdentity } from "./session_auth";
import { accessTokenSessionId, constantTimeEquals } from "./identity_rules";
import { assertStaffActor, assertCustomerActor, assertOwnerActor } from "./authz";
import { localFixturesEnabled } from "./local_fixtures";
import { hasLegacyAccess, requireLegacyAccess } from "./pilot_access";

const policies = new WeakMap<object, string>();

function tagged<T extends object>(registration: T, policy: string): T {
  policies.set(registration, policy);
  return registration;
}

export function registrationPolicy(registration: object) {
  return policies.get(registration);
}

type Access = Awaited<ReturnType<typeof requireActor>>;
type Definition<C, A extends PropertyValidators, R> = {
  name: string;
  args: A;
  handler: (ctx: C, args: ObjectType<A>) => R;
};

async function guarded<R>(functionName: string, run: () => R): Promise<Awaited<R>> {
  try { return await run(); }
  catch (error) {
    if (error instanceof ConvexError) throw error;
    // Domain validators throw stable codes; never forward arbitrary messages.
    const code = error instanceof Error && /^[A-Z][A-Z_]+$/.test(error.message)
      ? error.message : "INTERNAL_ERROR";
    if (code === "INTERNAL_ERROR") console.error({
      code, functionName, errorClass: error instanceof Error ? error.constructor.name : typeof error,
      ...(localFixturesEnabled() && error instanceof Error ? { message: error.message } : {}),
    });
    throw new ConvexError({ code });
  }
}

type Role = "actor" | "staff" | "customer" | "owner";

function assertRole(role: Role, access: Access) {
  if (role === "staff") assertStaffActor(access.actor);
  if (role === "customer") assertCustomerActor(access.actor);
  if (role === "owner") assertOwnerActor(access.actor);
}

/** Browser credentials travel only as the verified Convex Auth JWT. */
function refuseRawToken(name: string, args: PropertyValidators) {
  if ("token" in args || "sessionToken" in args) throw new Error(`${name}: raw token arguments are not accepted`);
}

function protectedQuery(role: Role) {
  return <A extends PropertyValidators, R>(definition: Definition<QueryCtx & Access, A, R>) => {
    refuseRawToken(definition.name, definition.args);
    return tagged(query({
      args: v.object(definition.args),
      handler: (ctx, args) => guarded(definition.name, async () => {
        const access = await requireActor(ctx);
        assertRole(role, access);
        return await definition.handler(Object.assign(ctx, access), args);
      }),
    }), `${role}Query`);
  };
}

function protectedMutation(role: Role, options?: { allowRecoveryEnrollment: true }) {
  return <A extends PropertyValidators, R>(definition: Definition<MutationCtx & Access, A, R>) => {
    refuseRawToken(definition.name, definition.args);
    return tagged(mutation({
      args: v.object(definition.args),
      handler: (ctx, args) => guarded(definition.name, async () => {
        const access = await requireActor(ctx, options);
        assertRole(role, access);
        return await definition.handler(Object.assign(ctx, access), args);
      }),
    }), options ? "customerRecoveryMutation" : `${role}Mutation`);
  };
}

/** Live admission required; staff or customer. */
export const actorQuery = protectedQuery("actor");
export const actorMutation = protectedMutation("actor");
export const staffQuery = protectedQuery("staff");
export const staffMutation = protectedMutation("staff");
export const customerQuery = protectedQuery("customer");
export const customerMutation = protectedMutation("customer");
export const customerRecoveryMutation = protectedMutation("customer", { allowRecoveryEnrollment: true });
/** Team, Project, membership and identity administration. */
export const ownerQuery = protectedQuery("owner");
export const ownerMutation = protectedMutation("owner");

type Pending = Awaited<ReturnType<typeof requirePendingIdentity>>;
/** A pending Google identity can only read and claim its invitation. */
export function pendingIdentityQuery<A extends PropertyValidators, R>(definition: Definition<QueryCtx & Pending, A, R>) {
  refuseRawToken(definition.name, definition.args);
  return tagged(query({
    args: v.object(definition.args),
    handler: (ctx, args) => guarded(definition.name, async () =>
      await definition.handler(Object.assign(ctx, await requirePendingIdentity(ctx)), args)),
  }), "pendingIdentityQuery");
}
export function pendingIdentityMutation<A extends PropertyValidators, R>(definition: Definition<MutationCtx & Pending, A, R>) {
  refuseRawToken(definition.name, definition.args);
  return tagged(mutation({
    args: v.object(definition.args),
    handler: (ctx, args) => guarded(definition.name, async () =>
      await definition.handler(Object.assign(ctx, await requirePendingIdentity(ctx)), args)),
  }), "pendingIdentityMutation");
}

// Each intentionally unauthenticated or self-authenticating endpoint names an
// allowlisted purpose; scripts/check-arch.ts pins every export to its purpose.
type PublicIdentity = "viewer" | "invite-preview";
export function publicIdentityQuery(purpose: PublicIdentity) {
  return <A extends PropertyValidators, R>(definition: Definition<QueryCtx, A, R>) => {
    refuseRawToken(definition.name, definition.args);
    return tagged(query({
      args: v.object(definition.args),
      handler: (ctx, args) => guarded(definition.name, () => definition.handler(ctx, args)),
    }), `publicIdentityQuery:${purpose}`);
  };
}

/** Self-authenticating identity writes (saved-code recovery). */
type PublicIdentityWrite = "customer-recover";
export function publicIdentityMutation(purpose: PublicIdentityWrite) {
  return <A extends PropertyValidators, R>(definition: Definition<MutationCtx, A, R>) => {
    refuseRawToken(definition.name, definition.args);
    return tagged(mutation({
      args: v.object(definition.args),
      handler: (ctx, args) => guarded(definition.name, () => definition.handler(ctx, args)),
    }), `publicIdentityMutation:${purpose}`);
  };
}

/** Identity workflows backed by internal mutations that perform the relevant checks. */
type IdentityAction = "send-challenge" | "customer-sign-in";
export function identityAction(purpose: IdentityAction) {
  return <A extends PropertyValidators, R>(definition: Definition<ActionCtx, A, R>) => {
    refuseRawToken(definition.name, definition.args);
    return tagged(action({
      args: v.object(definition.args),
      handler: (ctx, args) => guarded(definition.name, () => definition.handler(ctx, args)),
    }), `identityAction:${purpose}`);
  };
}

/** The pinned Auth 2.0.0 core endpoints, re-exported only by purpose. */
type AuthCorePurpose = "refresh-session" | "sign-out" | "is-authenticated";
const CORE_KIND: Record<AuthCorePurpose, "isQuery" | "isMutation"> = {
  "refresh-session": "isMutation", "sign-out": "isMutation", "is-authenticated": "isQuery",
};
export function authCoreEndpoint<T extends object>(purpose: AuthCorePurpose, registration: T): T {
  const kind = CORE_KIND[purpose];
  if (!(registration as Record<string, unknown>)[kind] || !(registration as Record<string, unknown>).isPublic) {
    throw new Error(`authCoreEndpoint:${purpose}: unexpected registration kind`);
  }
  return tagged(registration, `authCore:${purpose}`);
}

type TokenBundle = { accessToken: string; refreshToken: string; refreshTokenExpiresAt: number; userId: string };
type MethodResult = { status: "complete"; tokens: TokenBundle } | { status: "error" } | Record<string, unknown>;
type AuthHelpers = {
  completeSignUp(args: { profile: unknown; authenticatedBy: object }): Promise<TokenBundle>;
  completeSignIn(args: { userId: string; profile: unknown; authenticatedBy: object }): Promise<TokenBundle>;
  revokeOtherSessions(): Promise<number>;
  revokeAllSessions(userId: string): Promise<number>;
};
export type AuthMethodCtx = MutationCtx & { convexAuth: AuthHelpers };
export type MethodBuilders = { authMutation: (fn: {
  args: PropertyValidators;
  // The package's builder is generic over its Profile; the handler ctx is ours.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (ctx: any, args: any) => unknown;
}) => object };

/**
 * A completed sign-in returns success only after its admission committed with
 * it: the session in the token bundle must resolve, through the core, to the
 * bundle's user and to an unrevoked admission row for that user. Otherwise the
 * whole mutation (ticket claim, account, session) rolls back.
 */
async function assertAdmitted(ctx: MutationCtx, result: unknown) {
  if (!result || typeof result !== "object" || (result as MethodResult).status !== "complete") return;
  const tokens = (result as { tokens: TokenBundle }).tokens;
  const sessionId = accessTokenSessionId(tokens.accessToken);
  const session = await ctx.runQuery(components.auth.public.getSession, { sessionId });
  const admission = await ctx.db.query("sessionAdmissions")
    .withIndex("by_auth_session", (q) => q.eq("authSessionId", sessionId)).unique();
  if (!session || session.userId !== tokens.userId || !admission || admission.revokedAt !== undefined
    || admission.userId !== tokens.userId) throw new Error("ADMISSION_REQUIRED");
}

/**
 * Application sign-in adapters on a method bound to the pinned core. The core
 * helpers run in the caller transaction; success requires admission.
 */
type AuthMethodPurpose = "google-complete" | "customer-sign-up"
  | "customer-change-password" | "local-fixture";
function bindAuthMethod<A extends PropertyValidators, R>(builders: MethodBuilders, definition: Definition<AuthMethodCtx, A, R>) {
  refuseRawToken(definition.name, definition.args);
  return builders.authMutation({
    args: definition.args,
    handler: (ctx: AuthMethodCtx, args: ObjectType<A>) => guarded(definition.name, async () => {
      const result = await definition.handler(ctx, args);
      await assertAdmitted(ctx, result);
      return result;
    }),
  });
}

export function authMethodMutation(builders: MethodBuilders, purpose: AuthMethodPurpose) {
  return <A extends PropertyValidators, R>(definition: Definition<AuthMethodCtx, A, R>) =>
    tagged(bindAuthMethod(builders, definition), `authMethod:${purpose}`) as RegisteredMutation<"public", ObjectType<A>, Promise<Awaited<R>>>;
}

/** Convex Auth exposes the registration, while admission needs its handler in the current transaction. */
function pinnedMutationHandler<A, R>(registration: object, name: string) {
  const mutation = registration as { isMutation?: boolean; _handler?: (ctx: MutationCtx, args: A) => Promise<R> };
  if (mutation.isMutation !== true || typeof mutation._handler !== "function") {
    throw new Error(`${name}: incompatible pinned Auth mutation`);
  }
  return mutation._handler;
}

/** The password action calls this mutation to admit a verified session. */
export function internalPasswordSignInMutation<A extends PropertyValidators, R>(
  builders: MethodBuilders, definition: Definition<AuthMethodCtx, A, R>,
) {
  const handler = pinnedMutationHandler<ObjectType<A>, Awaited<R>>(bindAuthMethod(builders, definition), definition.name);
  return tagged(internalMutation({
    args: v.object(definition.args),
    handler,
  }), "internalPasswordSignInMutation");
}

/**
 * Wraps a pinned package mutation whose handler must run inside an
 * application transaction (Google start records its one-use flow).
 */
export function wrapPackageMutation<A extends PropertyValidators, R>(purpose: "google-start" | "refresh-session", inner: object, definition: Definition<MutationCtx & { runInner: (args: Record<string, unknown>) => Promise<unknown> }, A, R>) {
  const handler = pinnedMutationHandler<Record<string, unknown>, unknown>(inner, definition.name);
  refuseRawToken(definition.name, definition.args);
  return tagged(mutation({
    args: v.object(definition.args),
    handler: (ctx, args) => guarded(definition.name, () =>
      definition.handler(Object.assign(ctx, { runInner: (innerArgs: Record<string, unknown>) => handler(ctx, innerArgs) }), args)),
  }), `authPackage:${purpose}`);
}

export function requireCallbackCredential(callbackToken: string | undefined) {
  const expected = process.env.UPLOAD_CALLBACK_SECRET;
  if (!expected) throw new Error("UPLOAD_CALLBACK_NOT_CONFIGURED");
  if (!callbackToken || !constantTimeEquals(callbackToken, expected)) throw new Error("TRUSTED_CALLBACK_REQUIRED");
}

/**
 * Trusted provider callback OR the live staff session bound to the originating
 * intent. Mixed credentials are refused.
 */
export function trustedCallbackMutation<A extends PropertyValidators & {
  callbackToken: ReturnType<typeof v.optional<ReturnType<typeof v.string>>>;
}, R>(definition: Definition<MutationCtx & { staffSessionId?: Doc<"sessionAdmissions">["_id"] }, A, R>) {
  refuseRawToken(definition.name, definition.args);
  return tagged(mutation({
    args: v.object(definition.args),
    handler: (ctx, args) => guarded(definition.name, async () => {
      await requireLegacyAccess(ctx);
      const identity = await ctx.auth.getUserIdentity();
      if (identity && args.callbackToken) throw new Error("MIXED_CREDENTIALS");
      if (identity) {
        const access = await requireActor(ctx);
        assertStaffActor(access.actor);
        return await definition.handler(Object.assign(ctx, { staffSessionId: access.session._id }), args);
      }
      requireCallbackCredential(args.callbackToken);
      return await definition.handler(ctx, args);
    }),
  }), "trustedCallbackMutation");
}

/** Public boolean for the separate upload transport; returns no release or account data. */
export function legacyUploadTransportQuery() {
  return tagged(query({ args: {}, handler: hasLegacyAccess }), "legacyUploadTransportQuery");
}

export function internalJobQuery<A extends PropertyValidators, R>(definition: Definition<QueryCtx, A, R>) {
  return tagged(internalQuery({
    args: v.object(definition.args),
    handler: (ctx, args) => guarded(definition.name, () => definition.handler(ctx, args)),
  }), "internalJobQuery");
}

export function internalJobMutation<A extends PropertyValidators, R>(definition: Definition<MutationCtx, A, R>) {
  return tagged(internalMutation({
    args: v.object(definition.args),
    handler: (ctx, args) => guarded(definition.name, () => definition.handler(ctx, args)),
  }), "internalJobMutation");
}

export function internalJobAction<A extends PropertyValidators, R>(definition: Definition<ActionCtx, A, R>) {
  return tagged(internalAction({
    args: v.object(definition.args),
    handler: (ctx, args) => guarded(definition.name, () => definition.handler(ctx, args)),
  }), "internalJobAction");
}

/**
 * Internal session-checked mutation for HTTP actions: the route forwards the
 * caller's Convex Auth JWT, so identity reaches here exactly as for a browser call.
 */
export function internalActorMutation<A extends PropertyValidators, R>(
  definition: Definition<MutationCtx & Access, A, R>,
) {
  refuseRawToken(definition.name, definition.args);
  return tagged(internalMutation({
    args: v.object(definition.args),
    handler: (ctx, args) => guarded(definition.name, async () => {
      const access = await requireActor(ctx);
      return await definition.handler(Object.assign(ctx, access), args);
    }),
  }), "internalActorMutation");
}

/** Live named staff admission for T3 Settings, resolved through t3Identity.browser. */
export function namedStaffQuery<A extends PropertyValidators, R>(
  definition: Definition<QueryCtx & { namedStaff: T3Admission }, A, R>,
) {
  refuseRawToken(definition.name, definition.args);
  return tagged(query({
    args: v.object(definition.args),
    handler: (ctx, args) => guarded(definition.name, async () => {
      const namedStaff = await t3Identity.browser(ctx);
      if (!namedStaff) throw new Error("NAMED_STAFF_REQUIRED");
      return await definition.handler(Object.assign(ctx, { namedStaff }), args);
    }),
  }), "namedStaffQuery");
}

export function namedStaffMutation<A extends PropertyValidators, R>(
  definition: Definition<MutationCtx & { namedStaff: T3Admission }, A, R>,
) {
  refuseRawToken(definition.name, definition.args);
  return tagged(mutation({
    args: v.object(definition.args),
    handler: (ctx, args) => guarded(definition.name, async () => {
      const namedStaff = await t3Identity.browser(ctx);
      if (!namedStaff) throw new Error("NAMED_STAFF_REQUIRED");
      return await definition.handler(Object.assign(ctx, { namedStaff }), args);
    }),
  }), "namedStaffMutation");
}

export const t3DoctorRoute = {
  path: T3_DOCTOR_PATH,
  method: "POST" satisfies RoutableMethod,
  credentialClass: "t3-doctor",
  operation: "t3_doctor:verify",
} as const;

/**
 * Application HTTP routes. The Google callback (/oauth/clerk/callback) and the
 * deployment JWKS are component- and platform-owned, mounted from
 * convex.config.ts, and never registered here.
 */
/** Hosted Ticket pages: publishing checks the forwarded JWT; serving is the capability-URL reader. */
export const pageRoutes = {
  publish: { pathPrefix: "/v1/tickets/", method: "POST" satisfies RoutableMethod, credentialClass: "convex-auth", operation: "pages:publish" },
  preflight: { pathPrefix: "/v1/tickets/", method: "OPTIONS" satisfies RoutableMethod, credentialClass: "cors", operation: "pages:preflight" },
  serve: { pathPrefix: "/p/", method: "GET" satisfies RoutableMethod, credentialClass: "share-key", operation: "pages:serve" },
} as const;

export const httpRouteManifest = [t3DoctorRoute, ...Object.values(pageRoutes)] as const;

export function pageHttp(route: keyof typeof pageRoutes, handler: (ctx: ActionCtx, request: Request) => Promise<Response>) {
  const { pathPrefix, method, credentialClass, operation } = pageRoutes[route];
  return { pathPrefix, method, handler: tagged(httpAction(handler), `http:${credentialClass}:${operation}`) };
}

export function t3DoctorHttp(handler: (ctx: ActionCtx, request: Request) => Promise<Response>) {
  const { path, method, credentialClass, operation } = t3DoctorRoute;
  return { path, method, handler: tagged(httpAction(handler), `http:${credentialClass}:${operation}`) };
}

export function internalGatewayQuery<A extends PropertyValidators, R>(definition: Definition<QueryCtx, A, R>) {
  return tagged(internalQuery({
    args: v.object(definition.args),
    handler: (ctx, args) => guarded(definition.name, () => definition.handler(ctx, args)),
  }), "internalGatewayQuery");
}
