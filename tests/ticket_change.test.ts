import assert from "node:assert/strict";
import test from "node:test";
import { feedbackState, planTicketChange } from "../convex/tickets";
import type { Doc } from "../convex/_generated/dataModel";

/** A ticket row as the mutations see it, narrowed to what the planner reads. */
function ticket(overrides: Partial<Doc<"feedback">> = {}) {
  return {
    _id: "feedback-1",
    _creationTime: 1,
    title: "Card reader is dead",
    description: "Lane 3 will not read chips",
    status: "new",
    ticketNumber: 7,
    media: [],
    version: 3,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  } as Doc<"feedback">;
}

test("bumps the version once and stamps the injected timestamp", () => {
  const doc = ticket();

  const plan = planTicketChange({
    doc,
    expectedVersion: 3,
    changes: { status: "in_progress" },
    now: 500,
  });

  assert.equal(plan.version, 4);
  assert.equal(plan.updatedAt, 500);
  assert.deepEqual(plan.patch, { status: "in_progress", version: 4, updatedAt: 500 });
  assert.equal(plan.after.version, 4);
});

test("treats a missing version as 0", () => {
  const doc = ticket({ version: undefined });

  const plan = planTicketChange({ doc, expectedVersion: 0, changes: { title: "New" }, now: 500 });

  assert.equal(plan.version, 1);
  assert.equal(plan.before.version, 0);
});

test("rejects a stale expected version before deriving anything", () => {
  const doc = ticket({ version: 4 });

  assert.throws(
    () => planTicketChange({ doc, expectedVersion: 3, changes: { status: "done" }, now: 500 }),
    /VERSION_CONFLICT/,
  );
});

test("the patch and the audit after state cannot disagree", () => {
  const doc = ticket();

  const plan = planTicketChange({
    doc,
    expectedVersion: 3,
    changes: { title: "Reader offline", description: "Lane 3 and lane 4", status: "acknowledged" },
    now: 500,
  });

  // Every changed field lands in both the row patch and the audit snapshot.
  assert.equal(plan.patch.title, plan.after.title);
  assert.equal(plan.patch.description, plan.after.description);
  assert.equal(plan.patch.status, plan.after.status);
  assert.equal(plan.patch.version, plan.after.version);
  assert.deepEqual(plan.after, {
    title: "Reader offline",
    description: "Lane 3 and lane 4",
    status: "acknowledged",
    version: 4,
    mediaCount: 0,
  });
});

test("before is the ticket as it was, not as it will be", () => {
  const doc = ticket();

  const plan = planTicketChange({
    doc,
    expectedVersion: 3,
    changes: { status: "done" },
    now: 500,
  });

  assert.deepEqual(plan.before, feedbackState(doc));
  assert.equal(plan.before.status, "new");
  assert.equal(plan.before.version, 3);
});

test("archiving carries deletedAt into both the patch and the audit trail", () => {
  const doc = ticket();

  const plan = planTicketChange({
    doc,
    expectedVersion: 3,
    changes: { deletedAt: 500 },
    now: 500,
  });

  assert.equal(plan.patch.deletedAt, 500);
  assert.equal(plan.after.deletedAt, 500);
  assert.equal(plan.before.deletedAt, undefined);
});

test("leaves the ticket and the changes it was given untouched", () => {
  const doc = ticket();
  const changes = { status: "done" as const };
  const snapshot = { ...doc };

  const plan = planTicketChange({ doc, expectedVersion: 3, changes, now: 500 });

  assert.deepEqual(doc, snapshot);
  assert.deepEqual(changes, { status: "done" });
  assert.notEqual(plan.patch, changes);
  // Mutating the plan cannot reach back into the ticket row.
  plan.patch.status = "waiting";
  assert.equal(doc.status, "new");
  assert.equal(plan.after.status, "done");
});

test("attaching media updates the row and records only media counts in the audit snapshot", () => {
  const doc = ticket();
  const media = [{
    key: "upload-key",
    name: "evidence.png",
    size: 1_024,
    type: "image/png",
    url: "https://cdn.example.com/evidence.png",
  }];

  const plan = planTicketChange({ doc, expectedVersion: 3, changes: { media }, now: 500 });

  assert.deepEqual(plan.patch.media, media);
  assert.equal(plan.before.mediaCount, 0);
  assert.equal(plan.after.mediaCount, 1);
});
