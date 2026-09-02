import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSameTicketRequest,
  isSameTicketRequest,
  normalizeRequestId,
  MAX_REQUEST_ID_LENGTH,
} from "../convex/ticket_requests";

test("request ids are trimmed, bounded and free of control characters", () => {
  assert.equal(normalizeRequestId("  req-1  "), "req-1");
  assert.equal(normalizeRequestId("x".repeat(MAX_REQUEST_ID_LENGTH)).length, MAX_REQUEST_ID_LENGTH);
  assert.throws(() => normalizeRequestId("   "), /REQUIRED_REQUEST_ID/);
  assert.throws(() => normalizeRequestId("x".repeat(MAX_REQUEST_ID_LENGTH + 1)), /REQUEST_ID_TOO_LONG/);
  assert.throws(() => normalizeRequestId("req\n1"), /INVALID_REQUEST_ID/);
});

test("retrying a request id with identical content is the same request", () => {
  const stored = { title: "Printer jams", description: "On long receipts" };

  assert.equal(isSameTicketRequest(stored, { ...stored }), true);
  assert.doesNotThrow(() => assertSameTicketRequest(stored, { ...stored }));
});

test("reusing a request id for different content fails instead of duplicating", () => {
  const stored = { title: "Printer jams", description: "On long receipts" };

  assert.equal(isSameTicketRequest(stored, { ...stored, title: "Printer offline" }), false);
  assert.throws(() => assertSameTicketRequest(stored, { ...stored, title: "Printer offline" }), /REQUEST_ID_CONFLICT/);
  assert.throws(() => assertSameTicketRequest(stored, { ...stored, description: "Different" }), /REQUEST_ID_CONFLICT/);
});
