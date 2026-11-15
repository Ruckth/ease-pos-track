import type { PropertyValidators, ObjectType } from "convex/values";
import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { requireActor } from "../session_auth";

type Access = Awaited<ReturnType<typeof requireActor>>;
type Operation<C, A extends PropertyValidators, R> = {
  args: A;
  handler: (ctx: C & Access, args: ObjectType<A>) => R;
};

// Preserve validators and inferred operation types without registering a function.
export function queryOperation<A extends PropertyValidators, R>(operation: Operation<QueryCtx, A, R>) { return operation; }
export function mutationOperation<A extends PropertyValidators, R>(operation: Operation<MutationCtx, A, R>) { return operation; }
