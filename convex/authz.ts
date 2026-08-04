/**
 * Ownership and role rules for feedback tickets.
 *
 * Pure module: no Convex imports, so the rules can be unit tested directly and
 * reused by every query and mutation without drifting.
 *
 * Two invariants the whole app leans on:
 * - A session without a role is a staff session (sessions predate the portal).
 * - A ticket without an owner is staff-only (tickets predate the portal).
 */

export type ActorRole = "staff" | "customer";

export type Actor<CustomerId extends string = string> =
  | { role: "staff"; customerId?: undefined }
  | { role: "customer"; customerId: CustomerId };

export type SessionLike<CustomerId extends string = string> = {
  role?: ActorRole;
  customerId?: CustomerId;
};

export type OwnedDocument<CustomerId extends string = string> = {
  ownerCustomerId?: CustomerId;
};

/** Resolves the actor for a session. A missing role means staff. */
export function actorFromSession<CustomerId extends string>(
  session: SessionLike<CustomerId>,
): Actor<CustomerId> {
  if (session.role === "customer") {
    // A customer session without a customer link is unusable, never staff.
    if (!session.customerId) throw new Error("SESSION_EXPIRED");
    return { role: "customer", customerId: session.customerId };
  }
  return { role: "staff" };
}

export function isStaffActor(actor: Actor<string>) {
  return actor.role === "staff";
}

export function ownsFeedback<CustomerId extends string>(
  actor: Actor<CustomerId>,
  doc: OwnedDocument<CustomerId>,
) {
  return actor.role === "customer"
    && doc.ownerCustomerId !== undefined
    && doc.ownerCustomerId === actor.customerId;
}

/** Staff read everything; customers read only tickets they own. */
export function canReadFeedback<CustomerId extends string>(
  actor: Actor<CustomerId>,
  doc: OwnedDocument<CustomerId>,
) {
  return isStaffActor(actor) || ownsFeedback(actor, doc);
}

/** Content mutations (edit, annotate, soft delete) follow read access. */
export function canWriteFeedback<CustomerId extends string>(
  actor: Actor<CustomerId>,
  doc: OwnedDocument<CustomerId>,
) {
  return canReadFeedback(actor, doc);
}

/** Workflow controls (status, restore, backfill, cross-ticket listing). */
export function canUseStaffControls(actor: Actor<string>) {
  return isStaffActor(actor);
}

/**
 * A ticket a customer may not change is reported as missing, so mutations cannot
 * be used to probe which ticket ids exist.
 */
export function assertCanWriteFeedback<CustomerId extends string>(
  actor: Actor<CustomerId>,
  doc: OwnedDocument<CustomerId>,
) {
  if (!canWriteFeedback(actor, doc)) throw new Error("FEEDBACK_NOT_FOUND");
}

export function assertStaffActor(actor: Actor<string>) {
  if (!canUseStaffControls(actor)) throw new Error("STAFF_ONLY");
}

export function assertCustomerActor<CustomerId extends string>(
  actor: Actor<CustomerId>,
): CustomerId {
  if (actor.role !== "customer") throw new Error("CUSTOMER_ONLY");
  return actor.customerId;
}

/**
 * Ownership stamped on a new ticket. Derived from the session only — the client
 * never supplies ownerCustomerId.
 */
export function newFeedbackOwnership<CustomerId extends string>(actor: Actor<CustomerId>) {
  return actor.role === "customer"
    ? { ownerCustomerId: actor.customerId, origin: "customer" as const }
    : { origin: "staff" as const };
}

/** Actor columns stamped on audit events and upload intents. */
export function actorFields<CustomerId extends string>(actor: Actor<CustomerId>) {
  return actor.role === "customer"
    ? { actorRole: "customer" as const, actorCustomerId: actor.customerId }
    : { actorRole: "staff" as const };
}
