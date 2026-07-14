import assert from "node:assert/strict";
import test from "node:test";
import { planTicketNumberBackfill } from "../convex/ticket_numbers";
import { formatTicketNumber, nextFeedbackStatus } from "../src/lib/feedback-ui";

test("backfills missing ticket numbers oldest-first without reusing gaps", () => {
  const result = planTicketNumberBackfill([
    { id: "newer", createdAt: 200 },
    { id: "existing", createdAt: 50, ticketNumber: 3 },
    { id: "older", createdAt: 100 },
  ], 5);

  assert.deepEqual(result.assignments, [
    { id: "older", ticketNumber: 5 },
    { id: "newer", ticketNumber: 6 },
  ]);
  assert.equal(result.nextNumber, 7);
});

test("formats ticket numbers and advances status without wrapping Done", () => {
  assert.equal(formatTicketNumber(1), "TKT-0001");
  assert.equal(formatTicketNumber(10_001), "TKT-10001");
  assert.equal(formatTicketNumber(undefined), "TKT—");
  assert.equal(nextFeedbackStatus("new"), "in_progress");
  assert.equal(nextFeedbackStatus("waiting"), "done");
  assert.equal(nextFeedbackStatus("done"), null);
});
