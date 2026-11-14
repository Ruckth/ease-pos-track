import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_URGENCY_SCORE,
  MIN_URGENCY_SCORE,
  validateUrgencyScore,
} from "../convex/ticket_state";
import { urgencyBand } from "../src/lib/urgency-score";

test("urgency scores are optional whole numbers from 1 to 100", () => {
  assert.equal(validateUrgencyScore(undefined), undefined);
  assert.equal(validateUrgencyScore(MIN_URGENCY_SCORE), 1);
  assert.equal(validateUrgencyScore(MAX_URGENCY_SCORE), 100);
  assert.throws(() => validateUrgencyScore(0), /INVALID_URGENCY_SCORE/);
  assert.throws(() => validateUrgencyScore(101), /INVALID_URGENCY_SCORE/);
  assert.throws(() => validateUrgencyScore(50.5), /INVALID_URGENCY_SCORE/);
  assert.throws(() => validateUrgencyScore(Number.NaN), /INVALID_URGENCY_SCORE/);
});

test("every urgency boundary maps to its intended color band", () => {
  assert.equal(urgencyBand(undefined), "unscored");
  assert.equal(urgencyBand(1), "low");
  assert.equal(urgencyBand(25), "low");
  assert.equal(urgencyBand(26), "medium");
  assert.equal(urgencyBand(50), "medium");
  assert.equal(urgencyBand(51), "high");
  assert.equal(urgencyBand(75), "high");
  assert.equal(urgencyBand(76), "critical");
  assert.equal(urgencyBand(100), "critical");
});
