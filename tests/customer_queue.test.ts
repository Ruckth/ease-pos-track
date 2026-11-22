import assert from "node:assert/strict";
import test from "node:test";
import type { Id } from "../convex/_generated/dataModel";
import type { TicketSummary } from "../shared/ticket-contracts";
import { customerQueue, customerQueueCounts } from "../src/features/tickets/customer-queue";

function row(id: string, status: TicketSummary["status"], createdAt: number, title = id): TicketSummary {
  return { _id: id as Id<"tickets">, projectId: "project" as Id<"projects">, projectKey: "POS", ticketNumber: createdAt,
    title, excerpt: "Printer context", status, lifecycle: "active", version: 0, mediaCount: 0, annotationCount: 0,
    createdAt, updatedAt: createdAt, tagIds: [], tags: [], urgencyScore: undefined, archivedAt: undefined };
}

test("customer Active includes Waiting and keeps it first even after a newer Ticket arrives", () => {
  const rows = [row("newest", "new", 50), row("waiting", "waiting", 1), row("working", "in_progress", 5), row("done", "done", 100)];
  assert.deepEqual(customerQueue(rows, "active", "").map(item => item._id), ["waiting", "newest", "working"]);
  assert.deepEqual(customerQueueCounts(rows), { all: 4, active: 3, waiting: 1, done: 1 });
  assert.equal(rows[0]._id, "newest", "ordering must not mutate subscription data");
});

test("customer search and status filters operate only on loaded rows and include Ticket references", () => {
  const rows = [row("waiting", "waiting", 7, "Printer unavailable"), row("done", "done", 8, "Printer repaired")];
  assert.deepEqual(customerQueue(rows, "waiting", " printer ").map(item => item._id), ["waiting"]);
  assert.deepEqual(customerQueue(rows, "all", "POS-0008").map(item => item._id), ["done"]);
  assert.equal(customerQueue(rows, "active", "not loaded").length, 0);
  assert.equal(customerQueueCounts([]).all, 0);
});
