import assert from "node:assert/strict";
import test from "node:test";
import { ticketDraftIssue } from "../src/features/tickets/composer-validation";

test("one form submits a topic without a description, attachment, pin or review step", () => {
  assert.equal(ticketDraftIssue({ title: "Receipt is blank", description: "" }), null);
  assert.equal(ticketDraftIssue({ title: "   ", description: "Details without topic" }), "REQUIRED_TITLE");
});

test("the single form preserves the existing normalized text limits", () => {
  assert.equal(ticketDraftIssue({ title: ` ${"x".repeat(100)} `, description: "y".repeat(10_000) }), null);
  assert.equal(ticketDraftIssue({ title: "x".repeat(101), description: "" }), "TITLE_TOO_LONG");
  assert.equal(ticketDraftIssue({ title: "Title", description: "y".repeat(10_001) }), "DESCRIPTION_TOO_LONG");
});
