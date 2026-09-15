import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTagIds, normalizeTagName } from "../convex/tag_rules";
import { createTicketTag, listTicketTags, setTicketTags } from "../convex/feedback";

// Exercise the actual mutation handlers with a minimal in-memory database.
// Convex itself provides transactional retries/serializability in deployment.
function fixture(role: "staff" | "customer" = "staff") {
  const rows = new Map<string, any>([
    ["session", { _id: "session", token: "secret", role, customerId: "customer", expiresAt: Date.now() + 60_000 }],
    ["ticket", { _id: "ticket", title: "Printer", description: "", media: [], status: "new", version: 0, ownerCustomerId: "customer" }],
  ]);
  let next = 0;
  const db = {
    get: async (id: string) => rows.get(id) ?? null,
    patch: async (id: string, patch: any) => rows.set(id, { ...rows.get(id), ...patch }),
    insert: async (table: string, value: any) => { const id = `${table}-${++next}`; rows.set(id, { ...value, _id: id, table }); return id; },
    query: (table: string) => {
      let filter = (_row: any) => true;
      const query = {
        withIndex: (_name: string, match?: any) => { match?.({ eq: (key: string, value: any) => { filter = (row: any) => row[key] === value; } }); return query; },
        collect: async () => Array.from(rows.values()).filter((row) => (row.table === table || (table === "sessions" && row._id === "session")) && filter(row)),
        unique: async () => (await query.collect())[0] ?? null,
      };
      return query;
    },
  };
  const call = (fn: any, args: any) => fn._handler({ db }, { token: "secret", ...args });
  return { rows, call };
}

test("tag names normalize Unicode, spacing and case while retaining Thai", () => {
  assert.deepEqual(normalizeTagName("  ＰＯＳ   Support "), { name: "POS Support", normalizedName: "pos support" });
  assert.equal(normalizeTagName(" เครื่องพิมพ์ ").name, "เครื่องพิมพ์");
  for (const name of [" ", "x".repeat(33), "a\u200bb", "a\u0000b"]) assert.throws(() => normalizeTagName(name), /INVALID_TAG_NAME/);
  assert.deepEqual(normalizeTagIds(["b", "a", "b"]), ["a", "b"]);
  assert.throws(() => normalizeTagIds(Array(21).fill("a")), /TOO_MANY_TAGS/);
});

test("tag creation rejects normalized duplicate names and returns public fields only", async () => {
  const { call } = fixture();
  const id = await call(createTicketTag, { name: " POS ", color: "blue" });
  await assert.rejects(call(createTicketTag, { name: "pos", color: "red" }), /TAG_ALREADY_EXISTS/);
  assert.deepEqual(await call(listTicketTags, {}), [{ _id: id, name: "POS", color: "blue" }]);
});

test("customers cannot list, create, or assign tags even on their own Ticket", async () => {
  const { call } = fixture("customer");
  for (const [fn, args] of [[listTicketTags, {}], [createTicketTag, { name: "POS", color: "blue" }], [setTicketTags, { id: "ticket", tagIds: [], expectedVersion: 0 }]]) {
    await assert.rejects(call(fn, args), /STAFF_ONLY/);
  }
});

test("assigning/removing tags records snapshots and rejects stale edits without losing tags", async () => {
  const { call, rows } = fixture();
  const a = await call(createTicketTag, { name: "POS", color: "blue" });
  const b = await call(createTicketTag, { name: "Printer", color: "red" });
  const result = await call(setTicketTags, { id: "ticket", tagIds: [b, a, a], expectedVersion: 0 });
  assert.equal(result.version, 1);
  assert.deepEqual(rows.get("ticket").tagIds, [a, b]);
  assert.equal(rows.get(result.eventId).before.tagIds, undefined);
  assert.deepEqual(rows.get(result.eventId).after.tagIds, [a, b]);
  assert.equal(rows.get(result.eventId).sessionId, "session");
  await assert.rejects(call(setTicketTags, { id: "ticket", tagIds: [], expectedVersion: 0 }), /VERSION_CONFLICT/);
  assert.deepEqual(rows.get("ticket").tagIds, [a, b]);
  assert.deepEqual(await call(setTicketTags, { id: "ticket", tagIds: [b, a], expectedVersion: 1 }), { eventId: null, version: 1 });
  const removed = await call(setTicketTags, { id: "ticket", tagIds: [], expectedVersion: 1 });
  assert.deepEqual(rows.get(removed.eventId).before.tagIds, [a, b]);
  assert.deepEqual(rows.get(removed.eventId).after.tagIds, []);
});

test("missing tags, archived Tickets and expired sessions cannot be assigned", async () => {
  const { call, rows } = fixture();
  await assert.rejects(call(setTicketTags, { id: "ticket", tagIds: ["missing"], expectedVersion: 0 }), /TAG_NOT_FOUND/);
  rows.get("ticket").deletedAt = 10;
  await assert.rejects(call(setTicketTags, { id: "ticket", tagIds: [], expectedVersion: 0 }), /FEEDBACK_NOT_FOUND/);
  rows.get("session").expiresAt = 0;
  await assert.rejects(call(listTicketTags, {}), /SESSION_EXPIRED/);
});
