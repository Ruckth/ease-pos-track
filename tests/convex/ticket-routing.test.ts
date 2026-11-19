import { expect, test, vi } from "vitest";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { config, NOW, routingFixture, setupRoutingTestClock, STAFF, TOKEN } from "./ticket-routing-fixture";

setupRoutingTestClock();

type Fixture = Awaited<ReturnType<typeof routingFixture>>;
const label = (fixture: Fixture, ticketId: Id<"tickets">, symptom = "blank", token = TOKEN.primary) =>
  fixture.t.mutation(api.ticket_routing.classify, { token, ticketId, expectedVersion: 0,
    value: { product: "printer", symptom, restricted: false } });
const accept = (fixture: Fixture, suggestionId: Id<"ticketRoutingSuggestions">, token = TOKEN.owner) =>
  fixture.t.mutation(api.ticket_routing.reviewSuggestion, { token, suggestionId, decision: "accept" });

test("named staff can assign, reassign, hold and unassign; customer projections remain private", async () => {
  const f = await routingFixture();
  const ticketId = await f.create("Customer Ticket", TOKEN.customer, { product: "printer", symptom: "blank", restricted: true });
  const { t, projectId } = f;
  const args = { token: TOKEN.primary, ticketId, area: "hardware", assignee: STAFF.primary, held: false, expectedVersion: 0 };
  await expect(t.mutation(api.ticket_routing.assign, { ...args, token: TOKEN.pending })).rejects.toThrow("IDENTITY_PENDING");
  await expect(t.mutation(api.ticket_routing.assign, { ...args, token: TOKEN.customer })).rejects.toThrow("STAFF_ONLY");
  await expect(f.save({}, TOKEN.primary)).rejects.toThrow("OWNER_REQUIRED");
  const original = await t.query(api.ticket_routing.getAssignment, { token: TOKEN.primary, ticketId });
  expect(original?.classification).toEqual({ product: "printer", symptom: "blank", restricted: true, reviewed: false });
  await t.mutation(api.ticket_routing.assign, args);

  const mine = { token: TOKEN.primary, projectId, lifecycle: "active" as const, paginationOpts: { cursor: null, numItems: 10 } };
  expect((await t.query(api.tickets.pageTickets, { ...mine, assignmentFilter: "mine" })).page.map(item => item._id)).toEqual([ticketId]);
  expect((await t.query(api.tickets.pageTickets, { ...mine, assignmentFilter: "unassigned" })).page).toEqual([]);
  expect((await t.query(api.tickets.searchTickets, { token: TOKEN.primary, projectId, lifecycle: "active",
    assignmentFilter: "mine", search: "Customer" })).matches).toHaveLength(1);
  await expect(t.query(api.tickets.pageTickets, { ...mine, token: TOKEN.customer, assignmentFilter: "mine" })).rejects.toThrow("NAMED_STAFF_REQUIRED");
  const customer = await t.query(api.tickets.getWorkspaceTicket, { token: TOKEN.customer, projectId, ticket: ticketId });
  expect(customer?.status).toBe("new");
  for (const field of ["assignment", "assigneeStaffId", "routingClassification"]) expect(customer).not.toHaveProperty(field);
  const activity = await t.query(api.tickets.listTicketActivity, { token: TOKEN.customer, id: ticketId });
  expect(activity.map(row => row.action)).toEqual(["created"]);
  await expect(t.query(api.ticket_routing.getAssignment, { token: TOKEN.customer, ticketId })).rejects.toThrow("STAFF_ONLY");
  expect(await t.query(api.ticket_routing.getVocabulary, { token: TOKEN.customer, projectId })).not.toHaveProperty("areas");
  await t.run(async ({ db }) => {
    const membership = await db.query("projectMembers").withIndex("by_project", q => q.eq("projectId", projectId)).first();
    await db.delete(membership!._id);
  });
  expect(await t.query(api.ticket_routing.getVocabulary, { token: TOKEN.customer, projectId })).toBeNull();

  await expect(t.mutation(api.ticket_routing.setAvailability, {
    token: TOKEN.primary, projectId, staffId: STAFF.backup, available: false, reason: "shift",
  })).rejects.toThrow("OWNER_REQUIRED");
  await expect(t.mutation(api.ticket_routing.setAvailability, {
    token: TOKEN.owner, projectId, staffId: STAFF.primary, available: false,
  })).rejects.toThrow("ROUTING_REASON_REQUIRED");
  await t.mutation(api.ticket_routing.setAvailability, {
    token: TOKEN.owner, projectId, staffId: STAFF.primary, available: true, awayUntil: NOW + 1000, reason: "Shift handoff",
  });
  expect((await t.query(api.ticket_routing.getAssignment, { token: TOKEN.owner, ticketId }))?.needsReview).toBe(true);
  vi.setSystemTime(NOW + 1000);
  expect((await t.query(api.ticket_routing.getAssignment, { token: TOKEN.owner, ticketId }))?.needsReview).toBe(false);
  await t.mutation(api.ticket_routing.assign, { ...args, expectedVersion: 1, assignee: STAFF.backup, held: true });
  await t.mutation(api.ticket_routing.assign, { ...args, expectedVersion: 2, assignee: undefined, held: true });
  expect((await t.query(api.tickets.pageTickets, { ...mine, assignmentFilter: "unassigned" })).page).toHaveLength(1);
  const result = await f.snapshot();
  expect(result.tickets[0]).toMatchObject({ version: 3, assignment: { area: "hardware", held: true, source: "manual", staffId: STAFF.primary, version: 3 } });
  expect(result.events.map(event => event.after.assignee)).toEqual([STAFF.primary, STAFF.backup, undefined]);
  const settings = await f.settings();
  expect(settings?.policy).toMatchObject({ intake: [STAFF.primary], backup: STAFF.backup, ruleRevision: 1, policyGeneration: 2 });
  expect(await t.run(({ db }) => db.query("ticketRoutingAudit").collect())).toEqual(expect.arrayContaining([
    expect.objectContaining({ operation: "availability_changed", target: STAFF.primary, staffId: STAFF.owner, reason: "Shift handoff" }),
  ]));
});

test("rule request identities stay bound to the original revision, including abstentions", async () => {
  const f = await routingFixture();
  const ticketId = await f.create();
  const abstainingTicket = await f.create();
  const first = await label(f, ticketId);
  const absent = await label(f, abstainingTicket, "other");
  expect(absent.status).toBe("manual");
  const args = { token: TOKEN.primary, ticketId, expectedVersion: 1, requestId: "rule-request-A" };
  const absentArgs = { ...args, ticketId: abstainingTicket, requestId: "absent-A" };
  const submission = await f.t.mutation(api.ticket_routing.checkRule, args);
  expect(submission).toMatchObject({ id: first.id, status: "pending" });
  expect(await f.t.mutation(api.ticket_routing.checkRule, absentArgs)).toMatchObject({ status: "manual" });
  expect((await f.snapshot()).tickets.every(ticket => !ticket.assignment && ticket.version === 1)).toBe(true);
  expect((await f.snapshot()).events).toHaveLength(0);

  const changed = await f.save({ rules: [{ ...config.rules[0], area: "ops" }, { ...config.rules[0], symptom: "other" }] });
  expect(changed).toEqual({ policyGeneration: 2, ruleRevision: 2 });
  expect(await f.t.mutation(api.ticket_routing.checkRule, args)).toMatchObject({ id: first.id, status: "stale" });
  expect(await f.t.mutation(api.ticket_routing.checkRule, absentArgs)).toMatchObject({ status: "stale" });
  await expect(f.t.mutation(api.ticket_routing.checkRule, { ...args, expectedVersion: 2 })).rejects.toThrow("REQUEST_ID_CONFLICT");
  const [a, b] = await Promise.all(["B", "B-equivalent"].map(requestId => f.t.mutation(api.ticket_routing.checkRule, { ...args, requestId })));
  expect(a).toEqual(b);
  expect(a).toMatchObject({ status: "pending", area: "ops" });
  expect(a.id).not.toBe(first.id);
  expect(await accept(f, first.id!)).toEqual({ status: "stale" });
  const reviewers = await Promise.all([TOKEN.owner, TOKEN.backup].map(token => accept(f, a.id!, token)));
  expect(reviewers[0]).toEqual(reviewers[1]);
  expect(reviewers[0].status).toBe("accepted");
  const result = await f.snapshot();
  expect(result.suggestions).toHaveLength(2);
  expect(result.events).toHaveLength(1);
  expect(result.tickets.find(row => row._id === ticketId)).toMatchObject({ version: 2, assigneeStaffId: STAFF.owner });
});

test("human holds, dismissal, revoked access, roster drift and expiry leave the Ticket under human control", async () => {
  const f = await routingFixture();
  const heldId = await f.create();
  const held = await label(f, heldId);
  await f.t.mutation(api.ticket_routing.assign, { token: TOKEN.backup, ticketId: heldId, expectedVersion: 1, held: true });
  expect(await accept(f, held.id!)).toEqual({ status: "stale" });
  const raced = await label(f, await f.create("Raced Ticket"));
  const results = await Promise.all([accept(f, raced.id!),
    f.t.mutation(api.ticket_routing.reviewSuggestion, { token: TOKEN.primary, suggestionId: raced.id!, decision: "dismiss" })]);
  expect(results[0].status).toBe(results[1].status);

  const expired = await label(f, await f.create("Expires"));
  const expiresAt = await f.t.run(async ({ db }) => (await db.get(expired.id!))!.expiresAt);
  vi.setSystemTime(expiresAt + 1000);
  const events = (await f.snapshot()).events.length;
  expect(await accept(f, expired.id!)).toEqual({ status: "stale" });
  const drifted = await label(f, await f.create("Roster drift"));
  await f.t.mutation(api.ticket_routing.setAvailability, { token: TOKEN.primary, projectId: f.projectId, available: false });
  expect(await accept(f, drifted.id!)).toEqual({ status: "stale" });
  const fallback = await label(f, await f.create("Fallback"));
  await f.t.run(async ({ db }) => {
    // A disabled named account loses its session and its routing eligibility at once.
    const staff = (await db.get(STAFF.primary as Id<"staff">))!;
    await db.patch(staff._id, { status: "disabled", generation: staff.generation + 1 });
  });
  await expect(accept(f, fallback.id!, TOKEN.primary)).rejects.toThrow("SESSION_EXPIRED");
  expect((await f.snapshot()).events).toHaveLength(events);
  expect(await accept(f, fallback.id!, TOKEN.backup)).toMatchObject({ status: "accepted" });
  expect((await f.snapshot()).events.at(-1)?.after.assignee).toBe(STAFF.backup);

  const revoked = await label(f, await f.create("Archived Project"), "blank", TOKEN.owner);
  await f.t.run(({ db }) => db.patch(f.projectId, { archivedAt: Date.now() }));
  await expect(accept(f, revoked.id!)).rejects.toThrow("PROJECT_NOT_FOUND");
});

test("concurrent rule editing and acceptance cannot route stale proposals or disable manual controls", async () => {
  const f = await routingFixture();
  const ticketId = await f.create();
  const suggestion = await label(f, ticketId);
  const flags = await Promise.allSettled([
    f.save({ rules: [{ ...config.rules[0], area: "ops" }] }),
    f.t.mutation(api.ticket_routing.checkRule, { token: TOKEN.backup, ticketId, expectedVersion: 1, requestId: "during-edit" }),
    accept(f, suggestion.id!),
  ]);
  expect(flags[0].status).toBe("fulfilled");
  const result = await f.snapshot();
  expect(result.events.length).toBeLessThanOrEqual(1);
  if (!result.events.length) {
    const current = await f.t.mutation(api.ticket_routing.checkRule, { token: TOKEN.backup, ticketId, expectedVersion: 1, requestId: "after-edit" });
    expect(current).toMatchObject({ area: "ops", status: "pending" });
  }
  const after = result.tickets[0];
  await f.t.mutation(api.ticket_routing.assign, { token: TOKEN.owner, ticketId, expectedVersion: after.version, area: "ops", assignee: STAFF.backup, held: true });
  expect((await f.snapshot()).tickets[0].assignment).toMatchObject({ assignee: STAFF.backup, held: true, source: "manual" });
});

test("intake, assignment and assignment retry share one authorized inbox transaction", async () => {
  const f = await routingFixture();
  await f.save();
  const ticketId = await f.create("New Ticket", TOKEN.customer);
  const { t, projectId } = f;
  const page = (token: string) => t.query(api.staff_inbox.page, { token, projectId, paginationOpts: { numItems: 10, cursor: null } });
  expect((await page(TOKEN.primary)).page).toMatchObject([{ category: "intake", ticketId }]);
  expect((await page(TOKEN.backup)).page).toMatchObject([{ category: "intake", ticketId }]);
  const args = { token: TOKEN.owner, ticketId, area: "hardware", assignee: STAFF.primary, held: false, expectedVersion: 0 };
  await t.mutation(api.ticket_routing.assign, args);
  await expect(t.mutation(api.ticket_routing.assign, args)).rejects.toThrow("VERSION_CONFLICT");
  const { page: entries } = await page(TOKEN.primary);
  expect(entries.map(item => item.category)).toEqual(["assignment", "intake"]);
  expect(await t.mutation(api.staff_inbox.markRead, { token: TOKEN.backup, id: entries[0].id })).toBe(false);
  await expect(page(TOKEN.customer)).rejects.toThrow("STAFF_ONLY");
  expect((await t.query(api.inbox.page, { token: TOKEN.customer, projectId,
    paginationOpts: { numItems: 10, cursor: null } })).page).toEqual([]);
  // Keeping the same assignee while changing their manual hold generates no new assignment notice.
  await t.mutation(api.ticket_routing.assign, { ...args, expectedVersion: 1, held: true });
  expect((await page(TOKEN.primary)).page).toHaveLength(2);
});
