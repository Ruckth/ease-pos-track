import { identityTest } from "./identity-harness";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import schema from "../../convex/schema";
import { modules } from "./modules";
import { pageTicketDetails, pageTickets, searchTickets } from "../../convex/domain/reads";
import { requireActor } from "../../convex/session_auth";

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

test("each Ticket page or search reads a shared tag once and preserves each Ticket's tag order", async () => {
  const { t, staff, seed } = await fixture();
  const create = (name: string) => t.mutation(api.tickets.createTicketTag, { token: staff, name, color: "red" });
  const [first, second, missing] = await Promise.all([create("First"), create("Second"), create("Missing")]);
  const tags = [[first, missing, second], [second, first, missing], []];
  await t.run(async ({ db }) => {
    await db.delete(missing);
    for (const [index, id] of seed.tickets.slice(0, 3).entries()) {
      await db.patch(id, { tagIds: tags[index], searchText: "tagprobe" });
    }
  });
  const scope = { projectId: seed.projects[0].id, lifecycle: "active" as const };
  const paginated = { ...scope, paginationOpts: { cursor: null, numItems: 20 } };
  const target = t.raw.withIdentity({ subject: staff });
  for (const read of [
    async (ctx: Parameters<typeof pageTickets.handler>[0]) => (await pageTickets.handler(ctx, paginated)).page,
    async (ctx: Parameters<typeof pageTickets.handler>[0]) => (await pageTicketDetails.handler(ctx, paginated)).page,
    async (ctx: Parameters<typeof pageTickets.handler>[0]) => (await searchTickets.handler(ctx, { ...scope, search: "tagprobe" })).matches,
  ]) {
    await target.run(async ctx => {
      const access = await requireActor(ctx);
      const get = vi.spyOn(ctx.db, "get");
      const rows = await read({ ...ctx, ...access });
      const tagReads = get.mock.calls.flat().filter(value => value === first || value === second || value === missing);
      expect(tagReads.sort()).toEqual([first, second, missing].sort());
      for (const [index, id] of seed.tickets.slice(0, 3).entries()) {
        const row = rows.find(row => row._id === id);
        expect(row?.tagIds).toEqual(tags[index]);
        expect(row?.tags.map(tag => tag._id)).toEqual(tags[index].filter(tag => tag !== missing));
      }
    });
  }
});
