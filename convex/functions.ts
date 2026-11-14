/** The only module allowed to register Convex functions. */
import { v, ConvexError, type ObjectType, type PropertyValidators } from "convex/values";
import { query, mutation, action, internalQuery, internalMutation, internalAction } from "./_generated/server";
import type { QueryCtx, MutationCtx, ActionCtx } from "./_generated/server";
import { requireActor } from "./session_auth";
import { constantTimeEquals } from "./password";
import { assertStaffActor, assertCustomerActor } from "./authz";

const tokenValidator = v.string();
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
    if (code === "INTERNAL_ERROR") console.error({ code: "INTERNAL_ERROR", functionName, errorClass: error instanceof Error ? error.constructor.name : typeof error });
    throw new ConvexError({ code });
  }
}

export function actorQuery<A extends PropertyValidators & { token: typeof tokenValidator }, R>(
  definition: Definition<QueryCtx & Access, A, R>,
) {
  return tagged(query({
    args: v.object(definition.args),
    handler: (ctx, args) => guarded(definition.name, async () => {
      const access = await requireActor(ctx, args.token);
      return await definition.handler(Object.assign(ctx, access), args);
    }),
  }), "actorQuery");
}

export function actorMutation<A extends PropertyValidators & { token: typeof tokenValidator }, R>(
  definition: Definition<MutationCtx & Access, A, R>,
) {
  return tagged(mutation({
    args: v.object(definition.args),
    handler: (ctx, args) => guarded(definition.name, async () => {
      const access = await requireActor(ctx, args.token);
      return await definition.handler(Object.assign(ctx, access), args);
    }),
  }), "actorMutation");
}

export function staffQuery<A extends PropertyValidators & { token: typeof tokenValidator }, R>(
  definition: Definition<QueryCtx & Access, A, R>,
) {
  return tagged(query({
    args: v.object(definition.args),
    handler: (ctx, args) => guarded(definition.name, async () => {
      const access = await requireActor(ctx, args.token);
      assertStaffActor(access.actor);
      return await definition.handler(Object.assign(ctx, access), args);
    }),
  }), "staffQuery");
}

export function staffMutation<A extends PropertyValidators & { token: typeof tokenValidator }, R>(
  definition: Definition<MutationCtx & Access, A, R>,
) {
  return tagged(mutation({
    args: v.object(definition.args),
    handler: (ctx, args) => guarded(definition.name, async () => {
      const access = await requireActor(ctx, args.token);
      assertStaffActor(access.actor);
      return await definition.handler(Object.assign(ctx, access), args);
    }),
  }), "staffMutation");
}

export function customerQuery<A extends PropertyValidators & { token: typeof tokenValidator }, R>(
  definition: Definition<QueryCtx & Access, A, R>,
) {
  return tagged(query({
    args: v.object(definition.args),
    handler: (ctx, args) => guarded(definition.name, async () => {
      const access = await requireActor(ctx, args.token);
      assertCustomerActor(access.actor);
      return await definition.handler(Object.assign(ctx, access), args);
    }),
  }), "customerQuery");
}

export function customerMutation<A extends PropertyValidators & { token: typeof tokenValidator }, R>(
  definition: Definition<MutationCtx & Access, A, R>,
) {
  return tagged(mutation({
    args: v.object(definition.args),
    handler: (ctx, args) => guarded(definition.name, async () => {
      const access = await requireActor(ctx, args.token);
      assertCustomerActor(access.actor);
      return await definition.handler(Object.assign(ctx, access), args);
    }),
  }), "customerMutation");
}

// Each intentionally unauthenticated endpoint must name an allowlisted purpose.
type PublicAuth = "staff-login" | "customer-login" | "customer-register" | "current-session" | "logout";
export function publicAuthQuery(purpose: PublicAuth) {
  return <A extends PropertyValidators, R>(definition: Definition<QueryCtx, A, R>) => tagged(query({
    args: v.object(definition.args),
    handler: (ctx, args) => guarded(definition.name, () => definition.handler(ctx, args)),
  }), `publicAuthQuery:${purpose}`);
}

export function publicAuthMutation(purpose: PublicAuth) {
  return <A extends PropertyValidators, R>(definition: Definition<MutationCtx, A, R>) => tagged(mutation({
    args: v.object(definition.args),
    handler: (ctx, args) => guarded(definition.name, () => definition.handler(ctx, args)),
  }), `publicAuthMutation:${purpose}`);
}

export function publicAuthAction(purpose: PublicAuth) {
  return <A extends PropertyValidators, R>(definition: Definition<ActionCtx, A, R>) => tagged(action({
    args: v.object(definition.args),
    handler: (ctx, args) => guarded(definition.name, () => definition.handler(ctx, args)),
  }), `publicAuthAction:${purpose}`);
}

export function requireCallbackCredential(callbackToken: string | undefined) {
  const expected = process.env.UPLOAD_CALLBACK_SECRET;
  if (!expected) throw new Error("UPLOAD_CALLBACK_NOT_CONFIGURED");
  if (!callbackToken || !constantTimeEquals(callbackToken, expected)) throw new Error("TRUSTED_CALLBACK_REQUIRED");
}

/** Trusted provider callback OR the staff session bound to the originating intent. */
export function trustedCallbackMutation<A extends PropertyValidators & {
  callbackToken: ReturnType<typeof v.optional<typeof tokenValidator>>;
  token: ReturnType<typeof v.optional<typeof tokenValidator>>;
}, R>(definition: Definition<MutationCtx & { staffSessionId?: Access["session"]["_id"] }, A, R>) {
  return tagged(mutation({
    args: v.object(definition.args),
    handler: (ctx, args) => guarded(definition.name, async () => {
      if (args.token) {
        const access = await requireActor(ctx, args.token);
        assertStaffActor(access.actor);
        return await definition.handler(Object.assign(ctx, { staffSessionId: access.session._id }), args);
      }
      requireCallbackCredential(args.callbackToken);
      return await definition.handler(ctx, args);
    }),
  }), "trustedCallbackMutation");
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
