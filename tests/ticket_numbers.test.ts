import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeProjectKey,
  parseTicketReference,
  suggestProjectKey,
  validateProjectName,
} from "../convex/ticket_numbers";
import { formatTicketNumber, nextFeedbackStatus } from "../src/lib/feedback-ui";
import { pickProject, readProjectParam, withProjectParam } from "../src/lib/projects";

test("formats Ticket references with their Project key, legacy Tickets as TKT", () => {
  assert.equal(formatTicketNumber(1), "TKT-0001");
  assert.equal(formatTicketNumber(10_001), "TKT-10001");
  assert.equal(formatTicketNumber(undefined), "TKT—");
  assert.equal(formatTicketNumber(12, "POS"), "POS-0012");
  assert.equal(formatTicketNumber(12, undefined), "TKT-0012");
});

test("parses Ticket references in any case and rejects malformed ones", () => {
  assert.deepEqual(parseTicketReference("POS-0012"), { projectKey: "POS", ticketNumber: 12 });
  assert.deepEqual(parseTicketReference(" pos-0012 "), { projectKey: "POS", ticketNumber: 12 });
  assert.deepEqual(parseTicketReference("TKT-10001"), { projectKey: "TKT", ticketNumber: 10_001 });
  for (const bad of ["7", "POS-12", "P-0012", "1POS-0012", "POS-0000", "TOOLONGKEYX-0001", "POS_0012"]) {
    assert.equal(parseTicketReference(bad), null, bad);
  }
});

test("Project keys and names are validated with stable codes", () => {
  assert.equal(normalizeProjectKey(" pos "), "POS");
  assert.equal(normalizeProjectKey("A1"), "A1");
  for (const bad of ["", "P", "1POS", "PO S", "ABCDEFGHIJK", "PÖS"]) {
    assert.throws(() => normalizeProjectKey(bad), /INVALID_PROJECT_KEY/, bad);
  }
  assert.equal(validateProjectName("  Ease POS "), "Ease POS");
  assert.throws(() => validateProjectName("  "), /REQUIRED_PROJECT_NAME/);
  assert.throws(() => validateProjectName("x".repeat(81)), /PROJECT_NAME_TOO_LONG/);
});

test("suggests a key from a Project name", () => {
  assert.equal(suggestProjectKey("Ease POS Tracking"), "EPT");
  assert.equal(suggestProjectKey("pos"), "POS");
  assert.equal(suggestProjectKey("Warehouse"), "WARE");
  assert.equal(suggestProjectKey("ร้านกาแฟ"), "");
});

test("the URL's Project wins, otherwise the first available Project", () => {
  const projects = [{ key: "APP" }, { key: "POS" }];
  assert.equal(pickProject(projects, "POS")?.key, "POS");
  assert.equal(pickProject(projects, "pos")?.key, "POS");
  assert.equal(pickProject(projects, "GONE")?.key, "APP");
  assert.equal(pickProject(projects, null)?.key, "APP");
  assert.equal(pickProject([], "POS"), null);
  assert.equal(readProjectParam("?project=POS&x=1"), "POS");
  assert.equal(withProjectParam("https://app.example.com/staff?x=1#top", "POS"), "/staff?x=1&project=POS#top");
});

test("advances status without wrapping Done", () => {
  assert.equal(nextFeedbackStatus("new"), "acknowledged");
  assert.equal(nextFeedbackStatus("acknowledged"), "in_progress");
  assert.equal(nextFeedbackStatus("waiting"), "done");
  assert.equal(nextFeedbackStatus("done"), null);
});
