import assert from "node:assert/strict";
import test from "node:test";
import {
  actorFields,
  actorFromSession,
  assertCanWriteTicket,
  assertCustomerActor,
  assertStaffActor,
  canReadTicket,
  canUseProject,
  canUseStaffControls,
  canWriteTicket,
  newTicketOwnership,
  ownsTicket,
} from "../convex/authz";

const staff = actorFromSession({ role: "staff" });
const alice = actorFromSession({ role: "customer", customerId: "customer_alice" });
const bob = actorFromSession({ role: "customer", customerId: "customer_bob" });

const staffTicket = {};
const aliceTicket = { ownerCustomerId: "customer_alice" };
const bobTicket = { ownerCustomerId: "customer_bob" };

test("a session requires an explicit role and a customer identity", () => {
  assert.throws(() => actorFromSession({}), /SESSION_EXPIRED/);
  assert.deepEqual(actorFromSession({ role: "staff" }), { role: "staff" });
  assert.deepEqual(actorFromSession({ role: "customer", customerId: "customer_alice" }), {
    role: "customer",
    customerId: "customer_alice",
  });
  // A customer session missing its customer link is unusable, never staff.
  assert.throws(() => actorFromSession({ role: "customer" }), /SESSION_EXPIRED/);
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
  assert.deepEqual(actorFields(staff), { actorRole: "staff" });
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
  const staff = actorFromSession({ role: "staff" });
  const customer = actorFromSession({ role: "customer", customerId: "c1" });
  const active = {};
  const archived = { archivedAt: 1 };
  assert.equal(canUseProject(staff, active, false), true);
  assert.equal(canUseProject(customer, active, true), true);
  assert.equal(canUseProject(customer, active, false), false);
  assert.equal(canUseProject(staff, archived, false), false);
  assert.equal(canUseProject(customer, archived, true), false);
});
