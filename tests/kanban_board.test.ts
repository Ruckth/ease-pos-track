import assert from "node:assert/strict";
import test from "node:test";
import {
  BOARD_COLUMNS,
  countCards,
  emptyColumns,
  findCardStatus,
  isBoardStatus,
  normalizeColumns,
  reconcileColumns,
  settlePendingMoves,
  statusChangeFromDrag,
  withoutPendingMove,
} from "../src/lib/kanban-board";
import type { FeedbackStatus } from "../src/lib/types";

type Card = { _id: string; status: FeedbackStatus };

const card = (id: string, status: FeedbackStatus): Card => ({ _id: id, status });

test("the board has exactly the five workflow columns", () => {
  assert.deepEqual(BOARD_COLUMNS, ["new", "acknowledged", "in_progress", "waiting", "done"]);
  assert.equal(isBoardStatus("acknowledged"), true);
  assert.equal(isBoardStatus("waiting"), true);
  assert.equal(isBoardStatus("archived"), false);
  assert.deepEqual(Object.keys(emptyColumns()), BOARD_COLUMNS);
});

test("server tickets are grouped by status", () => {
  const columns = reconcileColumns([card("a", "new"), card("b", "done"), card("c", "new")], emptyColumns<Card>());
  assert.deepEqual(columns.new.map((item) => item._id), ["a", "c"]);
  assert.deepEqual(columns.done.map((item) => item._id), ["b"]);
  assert.equal(countCards(columns), 3);
  assert.equal(findCardStatus(columns, "b"), "done");
  assert.equal(findCardStatus(columns, "missing"), undefined);
});

test("a pending move keeps the card in its dropped column until the server agrees", () => {
  const server = [card("a", "new")];
  const dropped = reconcileColumns(server, emptyColumns<Card>(), { a: "in_progress" });
  assert.deepEqual(dropped.new, []);
  assert.deepEqual(dropped.in_progress.map((item) => item._id), ["a"]);

  // Server catches up: the pending entry is settled and the card stays put.
  const confirmed = [card("a", "in_progress")];
  const pending = settlePendingMoves(confirmed, { a: "in_progress" });
  assert.deepEqual(pending, {});
  const after = reconcileColumns(confirmed, dropped, pending);
  assert.deepEqual(after.in_progress.map((item) => item._id), ["a"]);
});

test("dropping a pending move snaps the card back to the server column", () => {
  const server = [card("a", "new")];
  const dropped = reconcileColumns(server, emptyColumns<Card>(), { a: "done" });
  const rolledBack = reconcileColumns(server, dropped, withoutPendingMove({ a: "done" }, "a"));
  assert.deepEqual(rolledBack.done, []);
  assert.deepEqual(rolledBack.new.map((item) => item._id), ["a"]);
});

test("pending moves for vanished tickets are discarded", () => {
  assert.deepEqual(settlePendingMoves([card("a", "new")], { b: "done" }), {});
  assert.deepEqual(settlePendingMoves([card("a", "new")], { a: "done" }), { a: "done" });
});

test("a live update keeps existing card order and puts new arrivals on top", () => {
  const previous = reconcileColumns(
    [card("first", "new"), card("second", "new"), card("third", "new")],
    emptyColumns<Card>(),
  );
  // Local drag reorders inside the column.
  const reordered = {
    ...previous,
    new: [previous.new[2], previous.new[0], previous.new[1]],
  };
  const next = reconcileColumns(
    [card("fresh", "new"), card("first", "new"), card("second", "new"), card("third", "new")],
    reordered,
  );
  assert.deepEqual(next.new.map((item) => item._id), ["fresh", "third", "first", "second"]);
});

test("a ticket moved by someone else follows the server", () => {
  const previous = reconcileColumns([card("a", "new"), card("b", "new")], emptyColumns<Card>());
  const next = reconcileColumns([card("a", "waiting"), card("b", "new")], previous);
  assert.deepEqual(next.new.map((item) => item._id), ["b"]);
  assert.deepEqual(next.waiting.map((item) => item._id), ["a"]);
});

test("tickets with an unknown status are left off the board", () => {
  const columns = reconcileColumns(
    [{ _id: "weird", status: "archived" as unknown as FeedbackStatus }],
    emptyColumns<Card>(),
  );
  assert.equal(countCards(columns), 0);
});

test("only cross-column drags become status changes", () => {
  assert.equal(statusChangeFromDrag({ activeContainer: "new", overContainer: "done" }), "done");
  assert.equal(statusChangeFromDrag({ activeContainer: "new", overContainer: "new" }), null);
  assert.equal(statusChangeFromDrag({ activeContainer: "new", overContainer: "nonsense" }), null);
});

test("column records from the primitive are narrowed to the fixed columns", () => {
  const narrowed = normalizeColumns<Card>({ new: [card("a", "new")], mystery: [card("z", "new")] });
  assert.deepEqual(Object.keys(narrowed), BOARD_COLUMNS);
  assert.deepEqual(narrowed.new.map((item) => item._id), ["a"]);
  assert.deepEqual(narrowed.done, []);
});
