import assert from "node:assert/strict";
import test from "node:test";
import {
  canEnterStep,
  canSubmitDraft,
  clampStep,
  CUSTOMER_STEPS,
  highestReachableStep,
  isStepComplete,
  stepIssues,
  stepState,
  type CustomerTicketDraft,
} from "../src/lib/customer-ticket-steps";

const empty: CustomerTicketDraft = { title: "", description: "", mediaCount: 0, annotationCount: 0 };
const titled: CustomerTicketDraft = { ...empty, title: "Receipt is blank" };
const withMedia: CustomerTicketDraft = { ...titled, mediaCount: 2 };
const ready: CustomerTicketDraft = { ...withMedia, annotationCount: 1 };

test("the flow is exactly details, media and pins, review", () => {
  assert.deepEqual(CUSTOMER_STEPS.map((entry) => entry.step), [1, 2, 3]);
  assert.deepEqual(CUSTOMER_STEPS.map((entry) => entry.titleKey), ["stepDetails", "stepMedia", "stepReview"]);
});

test("step one needs a topic within the length limits", () => {
  assert.deepEqual(stepIssues(1, empty), ["REQUIRED_TITLE"]);
  assert.deepEqual(stepIssues(1, { ...empty, title: "   " }), ["REQUIRED_TITLE"]);
  assert.deepEqual(stepIssues(1, { ...empty, title: "x".repeat(101) }), ["TITLE_TOO_LONG"]);
  assert.deepEqual(stepIssues(1, { ...titled, description: "y".repeat(10_001) }), ["DESCRIPTION_TOO_LONG"]);
  assert.equal(isStepComplete(1, titled), true);
});

test("step two keeps photos, videos, and pins optional", () => {
  assert.deepEqual(stepIssues(2, titled), []);
  assert.deepEqual(stepIssues(2, withMedia), []);
  // Pins stay optional.
  assert.deepEqual(stepIssues(2, { ...withMedia, annotationCount: 0 }), []);
});

test("review has no gate of its own", () => {
  assert.deepEqual(stepIssues(3, empty), []);
  assert.equal(isStepComplete(3, empty), true);
});

test("later steps stay closed until the earlier ones are complete", () => {
  assert.equal(canEnterStep(1, empty), true);
  assert.equal(canEnterStep(2, empty), false);
  assert.equal(canEnterStep(3, empty), false);

  assert.equal(canEnterStep(2, titled), true);
  assert.equal(canEnterStep(3, titled), true);
  assert.equal(canEnterStep(3, withMedia), true);
});

test("the active step is clamped to what the draft has unlocked", () => {
  assert.equal(highestReachableStep(empty), 1);
  assert.equal(highestReachableStep(titled), 3);
  assert.equal(highestReachableStep(withMedia), 3);

  assert.equal(clampStep(3, empty), 1);
  assert.equal(clampStep(3, titled), 3);
  assert.equal(clampStep(3, withMedia), 3);
  assert.equal(clampStep(0, withMedia), 1);
  assert.equal(clampStep(9, ready), 3);
});

test("clearing the required details pulls the flow back", () => {
  // Removing optional media while reviewing keeps the review step open.
  assert.equal(clampStep(3, { ...withMedia, mediaCount: 0 }), 3);
  // On media, then the topic is cleared.
  assert.equal(clampStep(2, { ...withMedia, title: "" }), 1);
});

test("submission requires every gate to pass", () => {
  assert.equal(canSubmitDraft(empty), false);
  assert.equal(canSubmitDraft(titled), true);
  assert.equal(canSubmitDraft(withMedia), true);
  assert.equal(canSubmitDraft(ready), true);
});

test("step badges report completed, active, and pending", () => {
  assert.equal(stepState(1, 2, withMedia), "completed");
  assert.equal(stepState(2, 2, withMedia), "active");
  assert.equal(stepState(3, 2, withMedia), "inactive");
  // An earlier step that is no longer valid is not shown as completed.
  assert.equal(stepState(1, 2, { ...withMedia, title: "" }), "inactive");
});
