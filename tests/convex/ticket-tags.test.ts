import { identityTest } from "./identity-harness";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import schema from "../../convex/schema";
import { modules } from "./modules";

beforeEach(() => {
  vi.stubEnv("LOCAL_FIXTURES_ENABLED", "true");
  vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3212");
});
afterEach(() => vi.unstubAllEnvs());

async function fixture() {
  const t = identityTest(modules);
  const seed = await t.mutation(internal.seed.install, {});
  return { t, seed, staff: seed.sessions[0], customer: seed.sessions[1], id: seed.tickets[0] };
}

test("tag APIs require staff and normalize names with transactional duplicate protection", async () => {
  const { t, staff, customer, id } = await fixture();
  for (const token of ["missing", customer]) {
    const code = token === "missing" ? "SESSION_EXPIRED" : "STAFF_ONLY";
    await expect(t.query(api.tickets.listTicketTags, { token })).rejects.toThrow(code);
    await expect(t.mutation(api.tickets.createTicketTag, { token, name: "Bug", color: "red" })).rejects.toThrow(code);
    await expect(t.mutation(api.tickets.setTicketTags, { token, id, tagIds: [], expectedVersion: 0 })).rejects.toThrow(code);
  }
  const tag = await t.mutation(api.tickets.createTicketTag, { token: staff, name: "  Needs   QA ", color: "orange" });
  await expect(t.mutation(api.tickets.createTicketTag, { token: staff, name: "needs QA", color: "red" })).rejects.toThrow("TAG_ALREADY_EXISTS");
  expect(await t.query(api.tickets.listTicketTags, { token: staff })).toEqual([{ _id: tag, name: "Needs QA", color: "orange" }]);
});

test("tag writes preserve versions, reject stale or archived writes and snapshot audit atomically", async () => {
  const { t, staff, id } = await fixture();
  const tag = await t.mutation(api.tickets.createTicketTag, { token: staff, name: "Bug", color: "red" });
  const input = { token: staff, id, tagIds: [tag, tag], expectedVersion: 0 };
  const changed = await t.mutation(api.tickets.setTicketTags, input);
  expect(changed.version).toBe(1);
  expect(await t.run(ctx => ctx.db.get(changed.eventId!))).toMatchObject({ action: "tags_changed", before: { version: 0 }, after: { version: 1, tagIds: [tag] } });
  const before = await t.run(async ctx => ({ row: await ctx.db.get(id), events: await ctx.db.query("ticketEvents").collect() }));
  await expect(t.mutation(api.tickets.setTicketTags, { ...input, tagIds: [] })).rejects.toThrow("VERSION_CONFLICT");
  expect(await t.mutation(api.tickets.setTicketTags, { ...input, expectedVersion: 1 })).toEqual({ eventId: null, version: 1 });
  expect(await t.run(async ctx => ({ row: await ctx.db.get(id), events: await ctx.db.query("ticketEvents").collect() }))).toEqual(before);
  const removed = await t.mutation(api.tickets.setTicketTags, { ...input, tagIds: [], expectedVersion: 1 });
  expect(await t.run(ctx => ctx.db.get(removed.eventId!))).toMatchObject({ before: { tagIds: [tag] }, after: { tagIds: [] } });
  await t.mutation(api.tickets.archiveTicket, { token: staff, id, expectedVersion: 2 });
  await expect(t.mutation(api.tickets.setTicketTags, { ...input, expectedVersion: 3 })).rejects.toThrow("TICKET_UNAVAILABLE");
});

test("detail, paginated summaries and indexed search resolve reusable tag metadata", async () => {
  const { t, staff, seed, id } = await fixture();
  const tag = await t.mutation(api.tickets.createTicketTag, { token: staff, name: "Bug", color: "red" });
  await t.mutation(api.tickets.setTicketTags, { token: staff, id, tagIds: [tag], expectedVersion: 0 });
  const expected = { tagIds: [tag], tags: [{ _id: tag, name: "Bug", color: "red" }] };
  const detail = await t.query(api.tickets.getTicket, { token: staff, id });
  expect(detail).toMatchObject(expected);
  const page = await t.query(api.tickets.pageTickets, { token: staff, projectId: seed.projects[0].id, lifecycle: "active", paginationOpts: { cursor: null, numItems: 50 } });
  expect(page.page.find(row => row._id === id)).toMatchObject(expected);
  const search = await t.query(api.tickets.searchTickets, { token: staff, projectId: seed.projects[0].id, lifecycle: "active", search: "POS-0001" });
  expect(search.matches.find(row => row._id === id)).toMatchObject(expected);
});
