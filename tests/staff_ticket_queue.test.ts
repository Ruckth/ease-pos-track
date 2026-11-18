import assert from "node:assert/strict";
import test from "node:test";
import { mergeQueueLanes, queueNeighbors, stableQueue, staffTicketActions } from "../src/lib/staff-ticket-queue";

test("urgency ranking applies to the loaded subset and stays stable until refreshed", () => {
  const row = (_id: string, urgencyScore?: number, updatedAt = 0) => ({ _id, urgencyScore, updatedAt });
  const ordered = stableQueue([row("unscored"), row("old", 40), row("urgent", 90), row("recent", 40, 1)], []);
  const original = ordered.map(item => item._id);
  assert.deepEqual(original, ["urgent", "recent", "old", "unscored"]);
  const changed = [row("unscored", 100), row("urgent", 20), row("extra", 65), row("other", 83)];
  assert.deepEqual(stableQueue(changed, original).map(item => item._id), ["urgent", "unscored", "other", "extra"]);
  assert.deepEqual(stableQueue(changed, []).map(item => item._id), ["unscored", "other", "extra", "urgent"]);
});

test("serial review retains neighboring Tickets when the current row leaves the filter", () => {
  assert.deepEqual(queueNeighbors("b", ["a", "d", "new"], ["a", "b", "c", "d"]), { previous: "a", next: "d" });
  assert.deepEqual(queueNeighbors("b", ["a", "b", "c"], []), { previous: "a", next: "c" });
  assert.deepEqual(queueNeighbors("d", ["a", "d", "new"], ["a", "b", "c", "d"]), { previous: "a", next: "new" });
  assert.deepEqual(queueNeighbors("external", ["a"], []), {});
});

test("common status actions resolve in-progress work directly and resume waiting work", () => {
  assert.equal(staffTicketActions.in_progress.status, "done");
  assert.equal(staffTicketActions.waiting.status, "in_progress");
});

test("overlapping reactive pages expose one copy of each Ticket at its latest version", () => {
  const older = { _id: "one", status: "new", version: 1 };
  const newer = { ...older, status: "acknowledged", version: 2 };
  assert.deepEqual(mergeQueueLanes([older, newer, older]), [newer]);
});
