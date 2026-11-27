import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import { fixtures, identityTest } from "./identity-harness";
import { modules } from "./modules";

beforeEach(() => {
  vi.stubEnv("LOCAL_FIXTURES_ENABLED", "true");
  vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3212");
});
afterEach(() => vi.unstubAllEnvs());

async function setup() {
  const t = identityTest(modules);
  const seed = await t.mutation(internal.seed.install, {});
  const [staff, alice, bob] = seed.sessions;
  const id = seed.tickets[1], projectId = seed.projects[0].id;
  const page = async (token: string) => (await t.query(api.inbox.page, {
    token, projectId, paginationOpts: { numItems: 20, cursor: null },
  })).page;
  const change = (expectedVersion: number, status: "acknowledged" | "done") =>
    t.mutation(api.tickets.updateTicketStatus, { token: staff, id, expectedVersion, status });
  return { t, staff, alice, bob, id, projectId, page, change };
}

test("status updates stay with the owner and old entries cannot return after restore or rejoining", async () => {
  const { t, staff, alice, bob, id, projectId, page, change } = await setup();
  await change(0, "acknowledged");
  const [original] = await page(alice);
  expect(original).toMatchObject({ ticketId: id, status: "acknowledged", read: false });
  expect(await page(bob)).toEqual([]);
  expect(await t.mutation(api.inbox.markRead, { token: bob, id: original.id })).toBe(false);
  expect(await t.mutation(api.inbox.markRead, { token: alice, id: original.id })).toBe(true);
  expect((await page(alice))[0].read).toBe(true);
  await t.mutation(api.tickets.archiveTicket, { token: staff, id, expectedVersion: 1 });
  expect(await page(alice)).toEqual([]);
  await t.mutation(api.tickets.restoreTicket, { token: staff, id, expectedVersion: 2 });
  expect(await page(alice)).toMatchObject([{ restored: true, read: false }]);
  expect(await t.mutation(api.inbox.markRead, { token: alice, id: original.id })).toBe(false);
  const owner = await t.run(async ctx => (await ctx.db.get(id))!.ownerCustomerId!);
  await t.mutation(api.projects.removeProjectMember, { token: staff, customerId: owner, projectId });
  expect(await page(alice)).toEqual([]);
  await t.run(ctx => ctx.db.insert("projectMembers", { projectId, customerId: owner, createdAt: Date.now() }));
  expect(await page(alice)).toEqual([]);
  await change(3, "done");
  expect(await page(alice)).toMatchObject([{ status: "done" }]);
});

test("updates created during suspension stay out of the customer inbox", async () => {
  const { t, alice, id, change, page } = await setup();
  const owner = await t.run(async ctx => (await ctx.db.get(id))!.ownerCustomerId!);
  await t.run(ctx => ctx.db.patch(owner, { status: "disabled" }));
  await change(0, "acknowledged");
  await t.run(ctx => ctx.db.patch(owner, { status: "active" }));
  expect(await page(alice)).toEqual([]);
  await change(1, "done");
  expect(await page(alice)).toMatchObject([{ status: "done" }]);
});

test("inbox preferences apply at the status change and opting in never backfills", async () => {
  const { t, alice, projectId, page, change } = await setup();
  await t.mutation(api.inbox.setPreference, { token: alice, projectId, enabled: false });
  await change(0, "acknowledged");
  await t.mutation(api.inbox.setPreference, { token: alice, projectId, enabled: true });
  expect(await page(alice)).toEqual([]);
  await change(1, "done");
  expect(await page(alice)).toMatchObject([{ status: "done" }]);
});

test("the intake team receives one update with creation; replacing membership does not revive old items", async () => {
  const { t, alice, projectId } = await setup();
  const { visibleStaffInboxTicket } = await import("../../convex/domain/staff_inbox");
  const [primary, backup, other] = await Promise.all(["primary", "backup", "other"].map(async name =>
    (await t.mutation(fixtures.staff, { email: `${name}@fixture.test`, name, role: "staff" })).staffId));
  const membership = await t.run(async ({ db }) => {
    const first = await db.insert("projectIntakeStaff", { projectId, staffId: primary });
    await db.insert("projectIntakeStaff", { projectId, staffId: backup });
    await db.insert("staffInboxPreferences", { projectId, staffId: backup, intake: false, assignment: true });
    return first;
  });
  const intent = await t.mutation(api.uploads.createUploadIntent, { token: alice, idempotencyKey: "inbox-intake-create", files: [] });
  const args = { token: alice, projectId, uploadIntentId: intent.intentId, uploadIntentSecret: intent.secret, title: "Printer", description: "", media: [], annotations: [], requestId: "inbox-intake-create" };
  await t.mutation(api.tickets.createTicket, args);
  await t.mutation(api.tickets.createTicket, args);
  await t.run(async ctx => {
    const rows = await ctx.db.query("staffInbox").collect();
    expect(rows).toMatchObject([{ staffId: primary, category: "intake" }]);
    expect(await visibleStaffInboxTicket(ctx, rows[0], primary)).toBeTruthy();
    expect(await visibleStaffInboxTicket(ctx, rows[0], other)).toBeNull();
    await ctx.db.delete(membership);
    await ctx.db.insert("projectIntakeStaff", { projectId, staffId: primary });
    expect(await visibleStaffInboxTicket(ctx, rows[0], primary)).toBeNull();
  });
});

test("Project restore allows new updates and permanently suppresses prior inbox history", async () => {
  const { t, alice, id, projectId, page, change } = await setup();
  await change(0, "acknowledged");
  const [old] = await page(alice);
  await t.mutation(internal.projects.setArchived, { projectId, archived: true });
  expect(await t.query(api.tickets.getTicket, { token: alice, id })).toBeNull();
  expect(await page(alice)).toEqual([]);
  await t.mutation(internal.projects.setArchived, { projectId, archived: false });
  expect(await page(alice)).toEqual([]);
  expect(await t.mutation(api.inbox.markRead, { token: alice, id: old.id })).toBe(false);
  await change(1, "done");
  expect(await page(alice)).toMatchObject([{ status: "done" }]);
});
