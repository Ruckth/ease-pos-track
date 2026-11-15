import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import schema from "../../convex/schema";
import { MAX_TAG_CATALOGUE } from "../../shared/tag-rules";
import { modules } from "./modules";

beforeEach(() => { vi.stubEnv("LOCAL_FIXTURES_ENABLED", "true"); vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3212"); });
afterEach(() => vi.unstubAllEnvs());

async function fixture() {
  const t = convexTest(schema, modules);
  const seed = await t.mutation(internal.seed.install, {
    passwordAlgorithm: "fixture", passwordSalt: "fixture", passwordHash: "fixture", passwordIterations: 1,
  });
  const [staff, alice] = seed.sessions;
  const { ticket } = await t.mutation(api.tickets.createTextTicket, {
    token: staff, projectKey: seed.projects[0].key, requestId: "tags-ticket", title: "Printer", description: "",
  });
  return { t, staff, alice, ticket };
}

test("tag creation rejects normalized duplicate names and lists public fields in name order", async () => {
  const { t, staff } = await fixture();
  const pos = await t.mutation(api.tickets.createTicketTag, { token: staff, name: " POS ", color: "blue" });
  await expect(t.mutation(api.tickets.createTicketTag, { token: staff, name: "pos", color: "red" })).rejects.toThrow("TAG_ALREADY_EXISTS");
  await expect(t.mutation(api.tickets.createTicketTag, { token: staff, name: "a​b", color: "red" })).rejects.toThrow("INVALID_TAG_NAME");
  const alpha = await t.mutation(api.tickets.createTicketTag, { token: staff, name: "Alpha", color: "green" });
  expect(await t.query(api.tickets.listTicketTags, { token: staff })).toEqual([
    { _id: alpha, name: "Alpha", color: "green" }, { _id: pos, name: "POS", color: "blue" },
  ]);
});

test("the tag catalogue is bounded so it always fits one read", async () => {
  const { t, staff } = await fixture();
  await t.run(async (ctx) => {
    const session = (await ctx.db.query("sessions").first())!._id;
    for (let i = 0; i < MAX_TAG_CATALOGUE; i++) {
      await ctx.db.insert("ticketTags", { name: `Tag ${i}`, normalizedName: `tag ${i}`, color: "slate", createdBy: session, createdAt: i });
    }
  });
  await expect(t.mutation(api.tickets.createTicketTag, { token: staff, name: "One more", color: "red" })).rejects.toThrow("TAG_LIMIT_REACHED");
});

test("customers cannot list, create or assign tags", async () => {
  const { t, alice, ticket } = await fixture();
  await expect(t.query(api.tickets.listTicketTags, { token: alice })).rejects.toThrow("STAFF_ONLY");
  await expect(t.mutation(api.tickets.createTicketTag, { token: alice, name: "POS", color: "blue" })).rejects.toThrow("STAFF_ONLY");
  await expect(t.mutation(api.tickets.setTicketTags, { token: alice, id: ticket._id, tagIds: [], expectedVersion: ticket.version })).rejects.toThrow("STAFF_ONLY");
});

test("assigning and removing tags records audit snapshots and rejects stale edits without losing tags", async () => {
  const { t, staff, ticket } = await fixture();
  const a = await t.mutation(api.tickets.createTicketTag, { token: staff, name: "POS", color: "blue" });
  const b = await t.mutation(api.tickets.createTicketTag, { token: staff, name: "Printer", color: "red" });
  const v0 = ticket.version;
  const added = await t.mutation(api.tickets.setTicketTags, { token: staff, id: ticket._id, tagIds: [b, a, a], expectedVersion: v0 });
  expect(added.version).toBe(v0 + 1);
  const sorted = [a, b].sort();
  expect((await t.query(api.tickets.getTicket, { token: staff, id: ticket._id }))?.tagIds).toEqual(sorted);
  const event = await t.run(ctx => ctx.db.get(added.eventId as Id<"ticketEvents">));
  expect(event).toMatchObject({ action: "tags_changed", actorRole: "staff", after: { tagIds: sorted } });
  expect(event?.before?.tagIds).toBeUndefined();
  await expect(t.mutation(api.tickets.setTicketTags, { token: staff, id: ticket._id, tagIds: [], expectedVersion: v0 })).rejects.toThrow("VERSION_CONFLICT");
  expect(await t.mutation(api.tickets.setTicketTags, { token: staff, id: ticket._id, tagIds: [b, a], expectedVersion: v0 + 1 })).toEqual({ eventId: null, version: v0 + 1 });
  const removed = await t.mutation(api.tickets.setTicketTags, { token: staff, id: ticket._id, tagIds: [], expectedVersion: v0 + 1 });
  const removal = await t.run(ctx => ctx.db.get(removed.eventId as Id<"ticketEvents">));
  expect(removal?.before?.tagIds).toEqual(sorted);
  expect(removal?.after?.tagIds).toEqual([]);
  const page = await t.query(api.tickets.pageTickets, { token: staff, projectId: ticket.projectId, lifecycle: "active", paginationOpts: { numItems: 10, cursor: null } });
  expect(page.page.find(row => row._id === ticket._id)?.tagIds).toEqual([]);
});

test("missing tags, too many tags and archived Tickets cannot be assigned", async () => {
  const { t, staff, ticket } = await fixture();
  const tag = await t.mutation(api.tickets.createTicketTag, { token: staff, name: "POS", color: "blue" });
  await t.run(ctx => ctx.db.delete(tag));
  await expect(t.mutation(api.tickets.setTicketTags, { token: staff, id: ticket._id, tagIds: [tag], expectedVersion: ticket.version })).rejects.toThrow("TAG_NOT_FOUND");
  await expect(t.mutation(api.tickets.setTicketTags, { token: staff, id: ticket._id, tagIds: Array(21).fill(tag), expectedVersion: ticket.version })).rejects.toThrow("TOO_MANY_TAGS");
  const archived = await t.mutation(api.tickets.archiveTicket, { token: staff, id: ticket._id, expectedVersion: ticket.version });
  await expect(t.mutation(api.tickets.setTicketTags, { token: staff, id: ticket._id, tagIds: [], expectedVersion: archived.version })).rejects.toThrow("TICKET_UNAVAILABLE");
});
