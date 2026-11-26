import assert from "node:assert/strict";
import test from "node:test";
import type { Id } from "../convex/_generated/dataModel";
import type { TicketSummary } from "../shared/ticket-contracts";
import { customerQueue, customerQueueCounts, customerSearchScope } from "../src/features/tickets/customer-queue";

function row(id: string, status: TicketSummary["status"], createdAt: number, title = id): TicketSummary {
  return { _id: id as Id<"tickets">, projectId: "project" as Id<"projects">, projectKey: "POS", ticketNumber: createdAt,
    title, excerpt: "Printer context", status, lifecycle: "active", version: 0, mediaCount: 0, annotationCount: 0,
    createdAt, updatedAt: createdAt, tagIds: [], tags: [], urgencyScore: undefined, archivedAt: undefined };
}

test("customer Active includes Waiting and keeps it first even after a newer Ticket arrives", () => {
  const rows = [row("newest", "new", 50), row("waiting", "waiting", 1), row("working", "in_progress", 5), row("done", "done", 100)];
  assert.deepEqual(customerQueue(rows, "active").map(item => item._id), ["waiting", "newest", "working"]);
  assert.deepEqual(customerQueueCounts(rows), { all: 4, active: 3, waiting: 1, done: 1 });
  assert.equal(rows[0]._id, "newest", "ordering must not mutate subscription data");
});

test("customer queue status filters and counts operate on loaded rows", () => {
  const rows = [row("waiting", "waiting", 7), row("done", "done", 8)];
  assert.deepEqual(customerQueue(rows, "waiting").map(item => item._id), ["waiting"]);
  assert.deepEqual(customerQueue(rows, "done").map(item => item._id), ["done"]);
  assert.deepEqual(customerQueue(rows, "all").map(item => item._id), ["waiting", "done"]);
  assert.equal(customerQueueCounts([]).all, 0);
});

test("customer search sends the current status scope to the server", () => {
  assert.deepEqual(customerSearchScope("active"), { status: undefined, activeOnly: true });
  assert.deepEqual(customerSearchScope("waiting"), { status: "waiting", activeOnly: undefined });
  assert.deepEqual(customerSearchScope("done"), { status: "done", activeOnly: undefined });
  assert.deepEqual(customerSearchScope("all"), { status: undefined, activeOnly: undefined });
});
