import { expect, test } from "vitest";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { routingFixture, setupRoutingTestClock, STAFF, TOKEN } from "./ticket-routing-fixture";

setupRoutingTestClock();

const paginationOpts = { numItems: 20, cursor: null };

async function setup() {
  const f = await routingFixture();
  const { t, projectId } = f;
  const staffItems = async (token: string, category: "intake" | "assignment") =>
    (await t.query(api.staff_inbox.page, { token, projectId, paginationOpts })).page.filter(item => item.category === category);
  const assign = (ticketId: Id<"tickets">, expectedVersion: number, assignee: string | undefined, held = false) =>
    t.mutation(api.ticket_routing.assign, { token: TOKEN.owner, ticketId, area: "hardware", assignee, held, expectedVersion });
  const markStaff = (token: string, id: Id<"staffInbox">) => t.mutation(api.staff_inbox.markRead, { token, id });
  const setStaff = (category: "intake" | "assignment", enabled: boolean) =>
    t.mutation(api.staff_inbox.setPreference, { token: TOKEN.primary, projectId, category, enabled });
  return { ...f, staffItems, assign, markStaff, setStaff };
}

test("reassigning A to B and back to A shows only the item from A's current interval", async () => {
  const f = await setup();
  const ticketId = await f.create("Printer", TOKEN.customer);
  await f.assign(ticketId, 0, STAFF.primary);
  const [first] = await f.staffItems(TOKEN.primary, "assignment");
  expect(first).toMatchObject({ ticketId });
  await f.assign(ticketId, 1, STAFF.backup);
  expect(await f.staffItems(TOKEN.primary, "assignment")).toEqual([]);
  expect(await f.staffItems(TOKEN.backup, "assignment")).toHaveLength(1);

  await f.assign(ticketId, 2, STAFF.primary);
  const current = await f.staffItems(TOKEN.primary, "assignment");
  expect(current).toHaveLength(1);
  expect(current[0].id).not.toBe(first.id);
  expect(await f.markStaff(TOKEN.primary, first.id)).toBe(false);
  expect(await f.staffItems(TOKEN.backup, "assignment")).toEqual([]);

  // Keeping the same assignee (a hold change) continues the interval.
  await f.assign(ticketId, 3, STAFF.primary, true);
  expect((await f.staffItems(TOKEN.primary, "assignment")).map(item => item.id)).toEqual([current[0].id]);
  expect(await f.markStaff(TOKEN.primary, current[0].id)).toBe(true);
  // Unassigning ends it; a new assignment starts another.
  await f.assign(ticketId, 4, undefined);
  expect(await f.staffItems(TOKEN.primary, "assignment")).toEqual([]);
  expect((await f.t.run(ctx => ctx.db.get(ticketId)))?.assigneeEventId).toBeUndefined();
  await f.assign(ticketId, 5, STAFF.primary);
  expect((await f.staffItems(TOKEN.primary, "assignment")).map(item => item.id)).not.toContain(current[0].id);
});

test("current staff preferences gate list and mark read, and re-opting in never revives withdrawn items", async () => {
  const f = await setup();
  const ticketId = await f.create("First", TOKEN.customer);
  await f.assign(ticketId, 0, STAFF.primary);
  const [old] = await f.staffItems(TOKEN.primary, "intake");
  expect(old).toMatchObject({ title: "First" });
  await f.setStaff("intake", true);
  expect(await f.staffItems(TOKEN.primary, "intake")).toHaveLength(1);

  await f.setStaff("intake", false);
  expect(await f.staffItems(TOKEN.primary, "intake")).toEqual([]);
  expect(await f.markStaff(TOKEN.primary, old.id)).toBe(false);
  expect(await f.staffItems(TOKEN.primary, "assignment")).toHaveLength(1);
  await f.create("Hidden while withdrawn", TOKEN.customer);

  await f.setStaff("intake", true);
  expect(await f.t.query(api.staff_inbox.settings, { token: TOKEN.primary, projectId: f.projectId })).toEqual({ intake: true, assignment: true });
  expect(await f.staffItems(TOKEN.primary, "intake")).toEqual([]);
  expect(await f.markStaff(TOKEN.primary, old.id)).toBe(false);
  expect((await f.t.run(ctx => ctx.db.get(old.id)))?.readAt).toBeUndefined();
  await f.create("Second", TOKEN.customer);
  expect(await f.staffItems(TOKEN.primary, "intake")).toMatchObject([{ title: "Second" }]);
  expect(await f.t.run(({ db }) => db.query("staffInboxPreferences").collect()))
    .toMatchObject([{ staffId: STAFF.primary, intake: true, intakeGeneration: 2, assignment: true }]);
});

test("the customer status preference applies at display time and keeps withdrawn items hidden", async () => {
  const f = await setup();
  const ticketId = await f.create("Status", TOKEN.customer);
  const items = async () => (await f.t.query(api.inbox.page, { token: TOKEN.customer, projectId: f.projectId, paginationOpts })).page;
  const set = (enabled: boolean) => f.t.mutation(api.inbox.setPreference, { token: TOKEN.customer, projectId: f.projectId, enabled });
  const status = (expectedVersion: number, value: "acknowledged" | "done") =>
    f.t.mutation(api.tickets.updateTicketStatus, { token: TOKEN.owner, id: ticketId, expectedVersion, status: value });
  await status(0, "acknowledged");
  const [old] = await items();
  expect(old).toMatchObject({ status: "acknowledged" });
  await set(false);
  expect(await items()).toEqual([]);
  expect(await f.t.mutation(api.inbox.markRead, { token: TOKEN.customer, id: old.id })).toBe(false);
  await set(true);
  expect(await items()).toEqual([]);
  await status(1, "done");
  expect(await items()).toMatchObject([{ status: "done" }]);
});
