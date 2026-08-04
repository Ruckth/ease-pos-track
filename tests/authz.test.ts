import assert from "node:assert/strict";
import test from "node:test";
import {
  actorFields,
  actorFromSession,
  assertCanWriteFeedback,
  assertCustomerActor,
  assertStaffActor,
  canReadFeedback,
  canUseStaffControls,
  canWriteFeedback,
  newFeedbackOwnership,
  ownsFeedback,
} from "../convex/authz";

const staff = actorFromSession({});
const alice = actorFromSession({ role: "customer", customerId: "customer_alice" });
const bob = actorFromSession({ role: "customer", customerId: "customer_bob" });

const legacyTicket = {};
const aliceTicket = { ownerCustomerId: "customer_alice" };
const bobTicket = { ownerCustomerId: "customer_bob" };

test("a session without a role is staff, and staff is not a customer", () => {
  assert.deepEqual(actorFromSession({}), { role: "staff" });
  assert.deepEqual(actorFromSession({ role: "staff" }), { role: "staff" });
  assert.deepEqual(actorFromSession({ role: "customer", customerId: "customer_alice" }), {
    role: "customer",
    customerId: "customer_alice",
  });
  // A customer session missing its customer link is unusable, never staff.
  assert.throws(() => actorFromSession({ role: "customer" }), /SESSION_EXPIRED/);
});

test("staff read and write every ticket, including legacy ones without owners", () => {
  for (const ticket of [legacyTicket, aliceTicket, bobTicket]) {
    assert.equal(canReadFeedback(staff, ticket), true);
    assert.equal(canWriteFeedback(staff, ticket), true);
  }
  assert.equal(canUseStaffControls(staff), true);
  assert.doesNotThrow(() => assertStaffActor(staff));
});

test("customers reach only their own tickets", () => {
  assert.equal(ownsFeedback(alice, aliceTicket), true);
  assert.equal(ownsFeedback(alice, bobTicket), false);
  assert.equal(canReadFeedback(alice, aliceTicket), true);
  assert.equal(canWriteFeedback(alice, aliceTicket), true);

  assert.equal(canReadFeedback(alice, bobTicket), false);
  assert.equal(canWriteFeedback(alice, bobTicket), false);
  assert.equal(canReadFeedback(bob, aliceTicket), false);
});

test("legacy tickets without an owner stay invisible to customers", () => {
  assert.equal(ownsFeedback(alice, legacyTicket), false);
  assert.equal(canReadFeedback(alice, legacyTicket), false);
  assert.equal(canWriteFeedback(alice, legacyTicket), false);
});

test("mutating another customer's ticket is reported as missing, not forbidden", () => {
  assert.throws(() => assertCanWriteFeedback(alice, bobTicket), /FEEDBACK_NOT_FOUND/);
  assert.throws(() => assertCanWriteFeedback(alice, legacyTicket), /FEEDBACK_NOT_FOUND/);
  assert.doesNotThrow(() => assertCanWriteFeedback(alice, aliceTicket));
});

test("staff controls are closed to customers", () => {
  assert.equal(canUseStaffControls(alice), false);
  assert.throws(() => assertStaffActor(alice), /STAFF_ONLY/);
  assert.throws(() => assertCustomerActor(staff), /CUSTOMER_ONLY/);
  assert.equal(assertCustomerActor(alice), "customer_alice");
});

test("ownership and actor columns are derived from the actor alone", () => {
  assert.deepEqual(newFeedbackOwnership(alice), {
    ownerCustomerId: "customer_alice",
    origin: "customer",
  });
  assert.deepEqual(newFeedbackOwnership(staff), { origin: "staff" });
  assert.deepEqual(actorFields(alice), { actorRole: "customer", actorCustomerId: "customer_alice" });
  assert.deepEqual(actorFields(staff), { actorRole: "staff" });
});

/**
 * Integration-style check: the same rule table the Convex handlers call, applied
 * to every action a customer might attempt on someone else's ticket.
 */
test("no customer path grants access to a ticket they do not own", () => {
  assert.equal(canReadFeedback(alice, bobTicket), false);
  const attempts: Array<() => unknown> = [
    () => assertCanWriteFeedback(alice, bobTicket),
    () => assertStaffActor(alice),
  ];
  for (const attempt of attempts) assert.throws(attempt);
});
