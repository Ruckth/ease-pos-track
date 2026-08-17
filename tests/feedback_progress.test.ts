import assert from "node:assert/strict";
import test from "node:test";
import { STATUS_ORDER, feedbackProgress } from "../src/lib/feedback-ui";
import { translate } from "../src/lib/i18n";

test("progress maps each workflow status to a step and a percentage", () => {
  assert.deepEqual(feedbackProgress("new"), { step: 1, total: 5, percent: 0 });
  assert.deepEqual(feedbackProgress("acknowledged"), { step: 2, total: 5, percent: 25 });
  assert.deepEqual(feedbackProgress("in_progress"), { step: 3, total: 5, percent: 50 });
  assert.deepEqual(feedbackProgress("waiting"), { step: 4, total: 5, percent: 75 });
  assert.deepEqual(feedbackProgress("done"), { step: 5, total: 5, percent: 100 });
});

test("progress rises with the workflow and only Done reaches full", () => {
  const percents = STATUS_ORDER.map((status) => feedbackProgress(status).percent);
  assert.deepEqual([...percents].sort((left, right) => left - right), percents);
  assert.equal(percents.filter((percent) => percent === 100).length, 1);
  assert.equal(feedbackProgress(STATUS_ORDER[0]).percent, 0);
});

test("an unrecognised status falls back to the first step, like statusMeta", () => {
  assert.deepEqual(feedbackProgress("archived" as never), { step: 1, total: 5, percent: 0 });
});

test("the progress bar labels interpolate every value in both languages", () => {
  const values = { ticket: "TKT-0007", step: 2, total: 5, percent: 25 };
  const english = translate("en", "ticketProgress", values);
  assert.equal(english, "TKT-0007 progress: step 2 of 5, 25% complete");
  const thai = translate("th", "ticketProgress", values);
  for (const part of ["TKT-0007", "2", "5", "25"]) {
    assert.match(thai, new RegExp(part), `Thai progress label is missing ${part}`);
  }
  assert.equal(translate("en", "ticketStep", { step: 2, total: 5 }), "Step 2/5");
  assert.match(translate("th", "ticketStep", { step: 2, total: 5 }), /2\/5/);
});
