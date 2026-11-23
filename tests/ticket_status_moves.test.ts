import assert from "node:assert/strict";
import test from "node:test";
import type { Id } from "../convex/_generated/dataModel";
import { TicketOperationFailure } from "../src/features/tickets/operations";
import { TicketStatusMoves, type MoveSource } from "../src/features/tickets/status-moves";
import type { TicketStatus } from "../src/lib/types";

const source: MoveSource = {
  _id: "example" as Id<"tickets">, projectId: "project" as Id<"projects">,
  projectKey: "POS", ticketNumber: 42, version: 2,
};
const shouldNotRun = () => { throw new Error("Unexpected call"); };

test("uncertain status writes reconcile a later edit and block duplicates until the authorized read succeeds", async () => {
  const tracker = new TicketStatusMoves();
  const phases: string[] = [];
  tracker.subscribe(() => phases.push(tracker.snapshot().get(source._id)?.phase ?? "settled"));
  let writes = 0, reads = 0;
  const deps = {
    write: async () => { writes++; throw new TicketOperationFailure(new Error("Connection lost")); },
    read: async (project: Id<"projects">, id: Id<"tickets">): Promise<TicketStatus | null> => {
      reads++;
      assert.equal(project, source.projectId); assert.equal(id, source._id);
      if (reads === 1) throw new Error("Offline");
      return "waiting"; // A different staff member edited the same Ticket.
    },
  };
  const first = tracker.move(source, "acknowledged", deps);
  const duplicate = tracker.move(source, "acknowledged", deps);
  assert.deepEqual(await Promise.all([first, duplicate]), [null, null]);
  await tracker.move(source, "acknowledged", deps);
  assert.equal(tracker.snapshot().get(source._id)?.phase, "retry");
  await Promise.all([tracker.retry(source._id, deps), tracker.retry(source._id, deps)]);
  assert.equal(writes, 1); assert.equal(reads, 2);
  assert.deepEqual(tracker.takeOutcomes(source.projectId), [{ item: source, status: "waiting" }]);
  assert.deepEqual(phases, ["moving", "checking", "retry", "checking", "settled"]);
});

test("a version conflict reads the newest status once and handles an unavailable Ticket neutrally", async () => {
  const tracker = new TicketStatusMoves();
  const deps = {
    write: async () => { throw new TicketOperationFailure({ data: { code: "VERSION_CONFLICT" } }); },
    read: async () => null,
  };
  assert.equal(await tracker.move(source, "in_progress", deps), null);
  assert.deepEqual(tracker.takeOutcomes(source.projectId), [{ item: source, status: null }]);
  assert.equal(tracker.snapshot().size, 0);
});

test("a known rejection and a successful move do not issue reconciliation reads", async () => {
  const tracker = new TicketStatusMoves();
  const rejected = new TicketOperationFailure({ data: { code: "PROJECT_NOT_FOUND" } });
  const deps = {
    write: async () => { throw rejected; },
    read: shouldNotRun,
  };
  assert.equal(await tracker.move(source, "done", deps), null);
  assert.deepEqual(tracker.takeOutcomes(source.projectId), [{ item: source, error: rejected }]);
  assert.equal(await tracker.move(source, "done", { ...deps, write: async () => ({ version: 3 }) }), 3);
});

test("deferred outcomes stay with the owning Project and deliver only its latest result once", async () => {
  const tracker = new TicketStatusMoves();
  const other = { ...source, _id: "other" as Id<"tickets">, projectId: "other-project" as Id<"projects">, projectKey: "APP" };
  const uncertain = async () => { throw new Error("Lost response"); };
  await tracker.move(source, "acknowledged", { write: uncertain, read: async () => "acknowledged" });
  await tracker.move(source, "waiting", { write: uncertain, read: async () => "waiting" });
  await tracker.move(other, "done", { write: uncertain, read: async () => "done" });
  assert.deepEqual(tracker.takeOutcomes(undefined), []);
  assert.deepEqual(tracker.takeOutcomes(other.projectId), [{ item: other, status: "done" }]);
  assert.deepEqual(tracker.takeOutcomes(other.projectId), []);
  assert.deepEqual(tracker.takeOutcomes(source.projectId), [{ item: source, status: "waiting" }]);
  assert.deepEqual(tracker.takeOutcomes(source.projectId), []);
});
