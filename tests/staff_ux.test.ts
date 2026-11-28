import assert from "node:assert/strict";
import test from "node:test";
import { ARCHIVE_PURGE_AFTER_MS, isArrivalOpened, markArrivalOpened, openAndDone, purgeEligibility, resetArrivalTracking, sortLane, takeUnannouncedArrivals, type BoardTicket } from "../src/lib/kanban-board";
import { formatRelativeTime } from "../src/lib/relative-time";
import { parseUrgencyDraft, urgencyBand } from "../src/lib/urgency-score";
import { projectKeyExample } from "../shared/ticket-numbers";
import { clearSavedSearches, loadSavedSearches, removeSavedSearch, saveSearch } from "../src/features/tickets/saved-searches";
import { stateTotals } from "../src/features/operations/health-totals";
import { ARCHIVE_RETENTION_MS } from "../convex/domain/media_jobs";

const row = (id: string, ticketNumber: number, urgencyScore?: number): BoardTicket & { urgencyScore?: number } =>
  ({ _id: id, projectId: "POS", status: "new", version: 1, ticketNumber, lifecycle: "active", urgencyScore });

test("UX-005 urgency sort: highest first, unscored last, lower Ticket number breaks ties; Newest keeps order", () => {
  const rows = [row("43", 43, 80), row("42", 42, 80), row("u", 50), row("low", 10, 5)];
  assert.deepEqual(sortLane(rows, "urgency").map(r => r._id), ["42", "43", "low", "u"]);
  assert.equal(sortLane(rows, "newest"), rows);
});

test("UX-025 open and done totals reconcile to the lane sum", () => {
  const totals = { new: 1, acknowledged: 1, in_progress: 0, waiting: 1, done: 200 };
  assert.deepEqual(openAndDone(totals), { open: 3, done: 200 });
  assert.deepEqual(openAndDone({}), { open: 0, done: 0 });
});

test("UX-015/029 bands at boundaries and urgency drafts", () => {
  assert.deepEqual([25, 26, 50, 51, 75, 76].map(urgencyBand), ["low", "medium", "medium", "high", "high", "critical"]);
  assert.equal(urgencyBand(undefined), "unscored");
  assert.deepEqual(parseUrgencyDraft(" "), { valid: true, score: undefined });
  assert.deepEqual(parseUrgencyDraft("76"), { valid: true, score: 76 });
  for (const bad of ["0", "101", "2.5", "-3", "1e2", "abc"]) assert.deepEqual(parseUrgencyDraft(bad), { valid: false }, bad);
});

test("UX-022 purge eligibility uses the 30-day archive rule and never guesses a missing date", () => {
  assert.equal(ARCHIVE_PURGE_AFTER_MS, ARCHIVE_RETENTION_MS);
  const now = Date.UTC(2026, 10, 28);
  assert.deepEqual(purgeEligibility(undefined, now), { state: "unknown" });
  assert.deepEqual(purgeEligibility(now - ARCHIVE_PURGE_AFTER_MS, now), { state: "eligible" });
  assert.deepEqual(purgeEligibility(now - 1000, now), { state: "future", from: now - 1000 + ARCHIVE_PURGE_AFTER_MS });
});

test("UX-008 arrivals: opened markers clear per Project and each arrival is announced once", () => {
  resetArrivalTracking();
  assert.equal(takeUnannouncedArrivals("P1", ["a", "b"]), 2);
  assert.equal(takeUnannouncedArrivals("P1", ["a", "b", "c"]), 1);
  assert.equal(takeUnannouncedArrivals("P2", ["a"]), 1);
  markArrivalOpened("P1", "a");
  assert.equal(isArrivalOpened("P1", "a"), true);
  assert.equal(isArrivalOpened("P2", "a"), false);
});

test("UX-012 relative update time in both languages", () => {
  const now = Date.UTC(2026, 10, 28, 12);
  assert.equal(formatRelativeTime(now - 3 * 3_600_000, now, "en"), "3 hours ago");
  assert.equal(formatRelativeTime(now - 10_000, now, "en"), "now");
  assert.match(formatRelativeTime(now - 5 * 86_400_000, now, "th"), /5 วัน/);
});

test("UX-041 Project key example only for valid normalized keys", () => {
  assert.equal(projectKeyExample(" pos "), "POS-0001");
  assert.equal(projectKeyExample("A1B2C3D4E5"), "A1B2C3D4E5-0001");
  for (const bad of ["P", "1POS", "PO-S", "ABCDEFGHIJK", "", "ÄBC"]) assert.equal(projectKeyExample(bad), null, bad);
});

test("UX-043/044 state totals reconcile across kinds", () => {
  const totals = stateTotals({ "cancellation:failed": 2, "ticket_purge:failed": 1, "intent_expiry:pending": 4, "rejected_upload:completed": 7 });
  assert.deepEqual(totals, { pending: 4, running: 0, completed: 7, failed: 3, superseded: 0 });
});

function memoryStore() {
  const map = new Map<string, string>();
  return { get length() { return map.size; }, key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); }, removeItem: (k: string) => { map.delete(k); } };
}

test("UX-144 saved searches are scoped to staff and Project and cleared on sign-out", () => {
  const store = memoryStore();
  saveSearch("staff-a", "P1", { name: "Printer", query: "printer jam", archived: true }, store);
  assert.deepEqual(loadSavedSearches("staff-a", "P1", store), [{ name: "Printer", query: "printer jam", archived: true }]);
  assert.deepEqual(loadSavedSearches("staff-b", "P1", store), []);
  assert.deepEqual(loadSavedSearches("staff-a", "P2", store), []);
  saveSearch("staff-a", "P1", { name: "Printer", query: "printer", archived: false }, store);
  assert.equal(loadSavedSearches("staff-a", "P1", store).length, 1);
  assert.deepEqual(removeSavedSearch("staff-a", "P1", "Printer", store), []);
  saveSearch("staff-a", "P1", { name: "  ", query: "x", archived: false }, store);
  assert.deepEqual(loadSavedSearches("staff-a", "P1", store), []);
  saveSearch("staff-a", "P1", { name: "One", query: "x", archived: false }, store);
  store.setItem("unrelated", "keep");
  clearSavedSearches(store);
  assert.deepEqual(loadSavedSearches("staff-a", "P1", store), []);
  assert.equal(store.getItem("unrelated"), "keep");
  store.setItem("staff-saved-searches:staff-a:P1", "{broken");
  assert.deepEqual(loadSavedSearches("staff-a", "P1", store), []);
});
