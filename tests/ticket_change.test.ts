import assert from "node:assert/strict";
import test from "node:test";
import { ticketState, planTicketChange } from "../convex/domain/tickets";
import type { Doc } from "../convex/_generated/dataModel";

/** A ticket row as the mutations see it, narrowed to what the planner reads. */
function ticket(overrides: Partial<Doc<"tickets">> = {}) {
  return {
    _id: "ticket-1",
    _creationTime: 1,
    projectId: "project-1",
    projectKey: "POS",
    origin: "staff",
    lifecycle: "active",
    searchText: "Reader is dead",
    annotations: [],
    title: "Reader is dead",
    description: "Lane 3 will not read chips",
    status: "new",
    ticketNumber: 7,
    media: [],
    version: 3,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  } as Doc<"tickets">;
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
    annotationCount: 0,
    lifecycle: "active",
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

  assert.deepEqual(plan.before, ticketState(doc));
  assert.equal(plan.before.status, "new");
  assert.equal(plan.before.version, 3);
});

test("archiving carries archivedAt into both the patch and the audit trail", () => {
  const doc = ticket();

  const plan = planTicketChange({
    doc,
    expectedVersion: 3,
    changes: { archivedAt: 500, lifecycle: "archived" },
    now: 500,
  });

  assert.equal(plan.patch.archivedAt, 500);
  assert.equal(plan.after.archivedAt, 500);
  assert.equal(plan.after.lifecycle, "archived");
  assert.equal(plan.before.archivedAt, undefined);
});

test("leaves the ticket and the changes it was given untouched", () => {
  const doc = ticket();
  const changes: { status: Doc<"tickets">["status"] } = { status: "done" };
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

test("restore deliberately removes archivedAt in the patch and its audit snapshot", () => {
  const plan = planTicketChange({ doc: ticket({ lifecycle: "archived", archivedAt: 100 }), expectedVersion: 3,
    changes: { lifecycle: "active", archivedAt: undefined }, now: 500 });
  assert.equal(Object.prototype.hasOwnProperty.call(plan.patch, "archivedAt"), true);
  assert.equal(plan.patch.archivedAt, undefined);
  assert.equal(plan.before.archivedAt, 100);
  assert.equal(Object.prototype.hasOwnProperty.call(plan.after, "archivedAt"), false);
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

test("urgency changes stay versioned and visible in the audit snapshot", () => {
  const doc = ticket({ urgencyScore: 24 });

  const plan = planTicketChange({
    doc,
    expectedVersion: 3,
    changes: { urgencyScore: 88 },
    now: 500,
  });

  assert.equal(plan.patch.urgencyScore, 88);
  assert.equal(plan.before.urgencyScore, 24);
  assert.equal(plan.after.urgencyScore, 88);
  assert.equal(plan.version, 4);
});

test("clearing urgency returns a Ticket to the unscored state", () => {
  const doc = ticket({ urgencyScore: 60 });

  const plan = planTicketChange({
    doc,
    expectedVersion: 3,
    changes: { urgencyScore: undefined },
    now: 500,
  });

  assert.equal(plan.patch.urgencyScore, undefined);
  assert.equal(plan.before.urgencyScore, 60);
  assert.equal(plan.after.urgencyScore, undefined);
});
