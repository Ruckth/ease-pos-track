/** Role and resource rules shared by domain operations. */

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

/** Invalid sessions never gain staff privileges. */
export function actorFromSession<CustomerId extends string>(
  session: SessionLike<CustomerId>,
): Actor<CustomerId> {
  if (session.role === "customer") {
    // A customer session without a customer link is unusable, never staff.
    if (!session.customerId) throw new Error("SESSION_EXPIRED");
    return { role: "customer", customerId: session.customerId };
  }
  if (session.role !== "staff") throw new Error("SESSION_EXPIRED");
  return { role: "staff" };
}

export function isStaffActor(actor: Actor<string>) {
  return actor.role === "staff";
}

export function ownsTicket<CustomerId extends string>(
  actor: Actor<CustomerId>,
  doc: OwnedDocument<CustomerId>,
) {
  return actor.role === "customer"
    && doc.ownerCustomerId !== undefined
    && doc.ownerCustomerId === actor.customerId;
}

/** Staff read everything; customers read only tickets they own. */
export function canReadTicket<CustomerId extends string>(
  actor: Actor<CustomerId>,
  doc: OwnedDocument<CustomerId>,
) {
  return isStaffActor(actor) || ownsTicket(actor, doc);
}

/** Content mutations (edit, annotate, soft delete) follow read access. */
export function canWriteTicket<CustomerId extends string>(
  actor: Actor<CustomerId>,
  doc: OwnedDocument<CustomerId>,
) {
  return canReadTicket(actor, doc);
}

/** Workflow controls (status, restore, cross-ticket listing). */
export function canUseStaffControls(actor: Actor<string>) {
  return isStaffActor(actor);
}

/**
 * A ticket a customer may not change is reported as missing, so mutations cannot
 * be used to probe which ticket ids exist.
 */
export function assertCanWriteTicket<CustomerId extends string>(
  actor: Actor<CustomerId>,
  doc: OwnedDocument<CustomerId>,
) {
  if (!canWriteTicket(actor, doc)) throw new Error("TICKET_UNAVAILABLE");
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
export function newTicketOwnership<CustomerId extends string>(actor: Actor<CustomerId>) {
  return actor.role === "customer"
    ? { ownerCustomerId: actor.customerId, origin: "customer" as const }
    : { origin: "staff" as const };
}

/**
 * Staff use every active Project. A customer uses only the Projects they were
 * added to, and an archived Project takes no new Tickets from anyone.
 */
export function canUseProject(
  actor: Actor<string>,
  project: { archivedAt?: number },
  isMember: boolean,
) {
  if (project.archivedAt !== undefined) return false;
  return isStaffActor(actor) || isMember;
}

/** Actor columns stamped on audit events and upload intents. */
export function actorFields<CustomerId extends string>(actor: Actor<CustomerId>) {
  return actor.role === "customer"
    ? { actorRole: "customer" as const, actorCustomerId: actor.customerId }
    : { actorRole: "staff" as const };
}
