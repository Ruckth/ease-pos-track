import assert from "node:assert/strict";
import test from "node:test";
import { BOARD_COLUMNS, emptyColumns, reconcileColumns, settlePendingMoves, finishMove, observeMove, pendingMoveCount, highestTicketNumber, isNewArrival, statusChangeFromDrag, type BoardTicket, type PendingMoves } from "../src/lib/kanban-board";
const row = (id = "a", version = 0, status: BoardTicket["status"] = "new", ticketNumber = 10): BoardTicket => ({ _id: id, projectId: "POS", version, status, ticketNumber, lifecycle: "active" });
const pending = (): PendingMoves<BoardTicket> => ({ a: { operationId: "op-1", ticket: row(), target: "done" } });
const ids = (rows: BoardTicket[]) => rows.map(row => row._id);

test("five fixed lanes; only a cross-lane drop persists a status", () => {
  assert.deepEqual(Object.keys(emptyColumns()), BOARD_COLUMNS);
  assert.equal(statusChangeFromDrag({ activeContainer: "new", overContainer: "done" }), "done");
  assert.equal(statusChangeFromDrag({ activeContainer: "new", overContainer: "new" }), null);
  assert.equal(statusChangeFromDrag({ activeContainer: "new", overContainer: "unknown" }), null);
});

test("older pages append while live arrivals precede them in descending Ticket order", () => {
  const first = [row("a", 0, "new", 10), row("b", 0, "new", 9)];
  const next = reconcileColumns("POS", [...first, row("older", 0, "new", 3), row("live", 0, "new", 11)]);
  assert.deepEqual(ids(next.new), ["live", "a", "b", "older"]);
});

test("held response and intervening subscriptions never overwrite a newer version or duplicate a row", () => {
  const move = pending();
  // A subscription can beat the response, including a subsequent actor's edit.
  const rows = [row(), row("a", 2, "waiting")];
  assert.deepEqual(settlePendingMoves("POS", rows, move), move);
  const columns = reconcileColumns("POS", rows, move);
  assert.deepEqual(ids(columns.waiting), ["a"]);
  assert.deepEqual(columns.done, []);
  assert.deepEqual(columns.new, []);
  const accepted = finishMove(move, "a", "op-1", 1);
  assert.deepEqual(settlePendingMoves("POS", rows, accepted), {});
});

test("unloaded destination and page absence retain a move until a known result version is observed", () => {
  const move = pending();
  assert.deepEqual(ids(reconcileColumns("POS", [], move).done), ["a"]);
  const accepted = finishMove(move, "a", "op-1", 1);
  assert.deepEqual(settlePendingMoves("POS", [], accepted), accepted);
  assert.deepEqual(settlePendingMoves("POS", [row()], accepted), accepted);
  // Detail-by-ID can observe the committed version even outside loaded lanes.
  assert.deepEqual(settlePendingMoves("POS", [row("a", 1, "done")], accepted), {});
  assert.deepEqual(observeMove(accepted, "op-1", null), accepted);
  assert.deepEqual(observeMove(accepted, "op-1", row()), accepted);
  assert.deepEqual(observeMove(accepted, "op-2", row("a", 1, "done")), accepted);
  const observed = observeMove(accepted, "op-1", row("a", 1, "done"));
  assert.deepEqual(ids(reconcileColumns("POS", [], observed).done), ["a"]);
});

test("observed moves stay visible below destination pages without occupying the pending cap", () => {
  const accepted = finishMove(pending(), "a", "op-1", 1);
  const observed = observeMove(accepted, "op-1", row("a", 1, "done", 10));
  const pages = [row("newer", 0, "done", 100), row("old-source", 0, "new", 9), row()];
  assert.equal(pendingMoveCount(observed), 0);
  const manyObserved = Object.fromEntries(Array.from({ length: 12 }, (_, index) => {
    const ticket = row(`observed-${index}`, 1, "done", index + 1);
    return [ticket._id, { ...observed.a, ticket, observed: ticket }];
  }));
  assert.equal(pendingMoveCount(manyObserved), 0);
  assert.equal(reconcileColumns("POS", [], manyObserved).done.length, 12);
  assert.equal(pendingMoveCount({ ...observed, b: { ...pending().a, ticket: row("b") } }), 1);
  const retained = settlePendingMoves("POS", pages, observed);
  assert.deepEqual(ids(reconcileColumns("POS", pages, retained).done), ["newer", "a"]);
  assert.deepEqual(ids(reconcileColumns("POS", pages, retained).new), ["old-source"]);
  const olderPage = [...pages, row("older", 0, "done", 8)];
  // Page absence cannot override the detail observation, even with older rows.
  assert.deepEqual(settlePendingMoves("POS", olderPage, retained), retained);
  assert.deepEqual(settlePendingMoves("POS", [...olderPage, row("a", 1, "done", 10)], retained), {});
  assert.deepEqual(settlePendingMoves("APP", [], retained), {});
  assert.deepEqual(reconcileColumns("POS", [], {}).done, []); // remount clears retention
});

test("retained detail observations follow newer moves and archive without stale rollback", () => {
  const accepted = finishMove(pending(), "a", "op-1", 1);
  const observed = observeMove(accepted, "op-1", row("a", 2, "waiting"));
  assert.deepEqual(ids(reconcileColumns("POS", [row()], observed).waiting), ["a"]);
  const archived = observeMove(observed, "op-1", { ...row("a", 3, "waiting"), lifecycle: "archived" });
  assert.deepEqual(reconcileColumns("POS", [row()], archived), emptyColumns());
});

test("a rejected second move preserves its previously observed Ticket outside loaded pages", () => {
  const retained = row("a", 1, "done");
  const retry = { a: { operationId: "op-2", ticket: retained, target: "waiting" as const, retained } };
  assert.equal(pendingMoveCount(retry), 1);
  const rejected = finishMove(retry, "a", "op-2", null);
  assert.equal(pendingMoveCount(rejected), 0);
  assert.deepEqual(ids(reconcileColumns("POS", [], rejected).done), ["a"]);
  assert.deepEqual(observeMove(rejected, "op-1", row("a", 2, "waiting")), rejected);
});

test("settling duplicate observations uses the highest version regardless of delivery order", () => {
  const accepted = finishMove(pending(), "a", "op-1", 2);
  for (const rows of [[row("a", 2, "done"), row()], [row(), row("a", 2, "done")]]) {
    assert.deepEqual(settlePendingMoves("POS", rows, accepted), {});
  }
});

test("one board-wide arrival threshold excludes moves, empty-lane arrivals and older pages", () => {
  const initialHighest = highestTicketNumber([row("a", 0, "new", 100), row("b", 0, "done", 20)]);
  assert.equal(initialHighest, 100);
  assert.equal(isNewArrival(row("a", 1, "done", 100), initialHighest), false);
  assert.equal(isNewArrival(row("b", 1, "waiting", 20), initialHighest), false);
  assert.equal(isNewArrival(row("older", 0, "new", 10), initialHighest), false);
  assert.equal(isNewArrival(row("live", 0, "done", 101), initialHighest), true);
  assert.equal(highestTicketNumber([]), 0);
  assert.equal(isNewArrival(row("first", 0, "new", 1), 0), true);
});

test("rejected move removes only its overlay and never rolls back intervening state", () => {
  const rows = [row("a", 3, "in_progress")];
  const rejected = finishMove(pending(), "a", "op-1", null);
  assert.deepEqual(rejected, {});
  assert.deepEqual(ids(reconcileColumns("POS", rows, rejected).in_progress), ["a"]);
});

test("late responses cannot settle a replacement operation or leak across Project switching", () => {
  const replacement = { a: { ...pending().a, operationId: "op-2" } };
  assert.deepEqual(finishMove(replacement, "a", "op-1", null), replacement);
  assert.deepEqual(finishMove(replacement, "a", "op-1", 1), replacement);
  assert.deepEqual(settlePendingMoves("APP", [], pending()), {});
  assert.deepEqual(reconcileColumns("APP", [row()], pending()), emptyColumns());
  assert.deepEqual(finishMove({}, "a", "op-1", 1), {});
});

test("unrelated pagination, duplicate lane deliveries and newer archived observations stay authoritative", () => {
  const columns = reconcileColumns("POS", [row("b"), row("a", 1, "done"), row(), { ...row("c"), lifecycle: "archived" }], pending());
  assert.deepEqual(ids(columns.new), ["b"]);
  assert.deepEqual(ids(columns.done), ["a"]);
  assert.equal(Object.values(columns).flat().length, 2);
});
