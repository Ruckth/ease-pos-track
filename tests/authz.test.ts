import assert from "node:assert/strict";
import test from "node:test";
import {
  actorFields,
  assertCanWriteTicket,
  assertOwnerActor,
  assertCustomerActor,
  assertStaffActor,
  canReadTicket,
  canUseProject,
  canUseStaffControls,
  canWriteTicket,
  newTicketOwnership,
  ownsTicket,
} from "../convex/authz";
import { actorFromAdmission, googleFlowAdmissible } from "../convex/identity_rules";

const live = { status: "active" as const, generation: 2 };
function admitted(principal: "staff" | "customer", id: string) {
  return actorFromAdmission({
    sessionUserId: "user_1",
    admission: { principal, userId: "user_1", generation: 2, ...(principal === "staff" ? { staffId: id } : { customerId: id }) },
    staff: { ...live, userId: "user_1", role: "staff" },
    customer: { ...live, userId: "user_1" },
  });
}
const staff = admitted("staff", "staff_1");
const alice = admitted("customer", "customer_alice");
const bob = admitted("customer", "customer_bob");

const staffTicket = {};
const aliceTicket = { ownerCustomerId: "customer_alice" };
const bobTicket = { ownerCustomerId: "customer_bob" };

test("admission maps a live session to exactly one active principal at its generation", () => {
  assert.deepEqual(staff, { role: "staff", staffId: "staff_1", staffRole: "staff" });
  assert.deepEqual(alice, { role: "customer", customerId: "customer_alice" });
  const base = { sessionUserId: "user_1", admission: { principal: "customer" as const, userId: "user_1", customerId: "c", generation: 2 }, customer: { ...live, userId: "user_1" } };
  assert.throws(() => actorFromAdmission({ ...base, sessionUserId: null }), /SESSION_EXPIRED/);
  assert.throws(() => actorFromAdmission({ ...base, admission: null }), /SESSION_EXPIRED/);
  assert.throws(() => actorFromAdmission({ ...base, sessionUserId: "user_2" }), /SESSION_EXPIRED/);
  assert.throws(() => actorFromAdmission({ ...base, admission: { ...base.admission, revokedAt: 1 } }), /SESSION_EXPIRED/);
  assert.throws(() => actorFromAdmission({ ...base, customer: { ...base.customer, generation: 3 } }), /SESSION_EXPIRED/);
  assert.throws(() => actorFromAdmission({ ...base, customer: { ...base.customer, status: "disabled" } }), /SESSION_EXPIRED/);
  // A customer admission never yields staff, and a pending identity yields nothing.
  assert.throws(() => actorFromAdmission({ ...base, admission: { ...base.admission, principal: "staff" } }), /SESSION_EXPIRED/);
  assert.throws(() => actorFromAdmission({ ...base, admission: { principal: "pending", userId: "user_1", generation: 0 } }), /IDENTITY_PENDING/);
});

test("a Google flow admits a known principal only after its last transition", () => {
  assert.equal(googleFlowAdmissible(11, { status: "active", validAfter: 10 }), true);
  assert.equal(googleFlowAdmissible(10, { status: "active", validAfter: 10 }), false);
  assert.equal(googleFlowAdmissible(11, { status: "disabled", validAfter: 10 }), false);
});

test("Owner administration requires the Owner role, not only staff", () => {
  assert.doesNotThrow(() => assertOwnerActor({ role: "staff", staffRole: "owner" }));
  assert.throws(() => assertOwnerActor(staff), /OWNER_ONLY/);
  assert.throws(() => assertOwnerActor(alice), /STAFF_ONLY/);
});

test("staff read and write every ticket, including staff-created ones without owners", () => {
  for (const ticket of [staffTicket, aliceTicket, bobTicket]) {
    assert.equal(canReadTicket(staff, ticket), true);
    assert.equal(canWriteTicket(staff, ticket), true);
  }
  assert.equal(canUseStaffControls(staff), true);
  assert.doesNotThrow(() => assertStaffActor(staff));
});

test("customers reach only their own tickets", () => {
  assert.equal(ownsTicket(alice, aliceTicket), true);
  assert.equal(ownsTicket(alice, bobTicket), false);
  assert.equal(canReadTicket(alice, aliceTicket), true);
  assert.equal(canWriteTicket(alice, aliceTicket), true);

  assert.equal(canReadTicket(alice, bobTicket), false);
  assert.equal(canWriteTicket(alice, bobTicket), false);
  assert.equal(canReadTicket(bob, aliceTicket), false);
});

test("staff-created Tickets without an owner stay invisible to customers", () => {
  assert.equal(ownsTicket(alice, staffTicket), false);
  assert.equal(canReadTicket(alice, staffTicket), false);
  assert.equal(canWriteTicket(alice, staffTicket), false);
});

test("mutating another customer's ticket is reported as missing, not forbidden", () => {
  assert.throws(() => assertCanWriteTicket(alice, bobTicket), /TICKET_UNAVAILABLE/);
  assert.throws(() => assertCanWriteTicket(alice, staffTicket), /TICKET_UNAVAILABLE/);
  assert.doesNotThrow(() => assertCanWriteTicket(alice, aliceTicket));
});

test("staff controls are closed to customers", () => {
  assert.equal(canUseStaffControls(alice), false);
  assert.throws(() => assertStaffActor(alice), /STAFF_ONLY/);
  assert.throws(() => assertCustomerActor(staff), /CUSTOMER_ONLY/);
  assert.equal(assertCustomerActor(alice), "customer_alice");
});

test("ownership and actor columns are derived from the actor alone", () => {
  assert.deepEqual(newTicketOwnership(alice), {
    ownerCustomerId: "customer_alice",
    origin: "customer",
  });
  assert.deepEqual(newTicketOwnership(staff), { origin: "staff" });
  assert.deepEqual(actorFields(alice), { actorRole: "customer", actorCustomerId: "customer_alice" });
  assert.deepEqual(actorFields(staff), { actorRole: "staff", actorStaffId: "staff_1" });
  assert.deepEqual(actorFields({ role: "staff" }), { actorRole: "staff" });
});

/**
 * Integration-style check: the same rule table the Convex handlers call, applied
 * to every action a customer might attempt on someone else's ticket.
 */
test("no customer path grants access to a ticket they do not own", () => {
  assert.equal(canReadTicket(alice, bobTicket), false);
  const attempts: Array<() => unknown> = [
    () => assertCanWriteTicket(alice, bobTicket),
    () => assertStaffActor(alice),
  ];
  for (const attempt of attempts) assert.throws(attempt);
});

test("staff use every active Project; customers only ones they were added to", () => {
  const customer = admitted("customer", "c1");
  const active = {};
  const archived = { archivedAt: 1 };
  assert.equal(canUseProject(staff, active, false), true);
  assert.equal(canUseProject(customer, active, true), true);
  assert.equal(canUseProject(customer, active, false), false);
  assert.equal(canUseProject(staff, archived, false), false);
  assert.equal(canUseProject(customer, archived, true), false);
});
