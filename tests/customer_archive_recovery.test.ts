import assert from "node:assert/strict";
import test from "node:test";
import { archiveFailureDisposition, archiveReadDisposition } from "../src/features/tickets/customer-archive-recovery";

test("unknown and unclassified structured archive failures require a read before another write", () => {
  for (const code of ["UNKNOWN_OUTCOME", "INTERNAL_ERROR", "UNRECOGNIZED"]) {
    assert.equal(archiveFailureDisposition({ data: { code } }), "unknown");
  }
  assert.equal(archiveFailureDisposition(new Error("Disconnected")), "unknown");
  assert.equal(archiveFailureDisposition({ data: { code: "VERSION_CONFLICT" } }), "conflict");
  assert.equal(archiveFailureDisposition({ data: { code: "TICKET_UNAVAILABLE" } }), "unavailable");
  assert.equal(archiveFailureDisposition({ data: { code: "INVALID_INPUT" } }), "rejected");
});

test("a later archive establishes current lifecycle, leaving the submission outcome unknown", () => {
  assert.equal(archiveReadDisposition({ lifecycle: "archived", version: 6 }, 3), "archived");
  assert.equal(archiveReadDisposition({ lifecycle: "active", version: 4 }, 3), "review");
  assert.equal(archiveReadDisposition({ lifecycle: "active", version: 3 }, 3), "retry");
  assert.equal(archiveReadDisposition({ lifecycle: "active", version: 2 }, 3), "unresolved");
  assert.equal(archiveReadDisposition(null, 3), "unresolved");
});
