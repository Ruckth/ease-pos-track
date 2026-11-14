import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import schema from "../../convex/schema";
import { modules } from "./modules";
import type { FunctionArgs, FunctionReturnType } from "convex/server";

beforeEach(() => {
  vi.stubEnv("LOCAL_FIXTURES_ENABLED", "true");
  vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3212");
});
afterEach(() => vi.unstubAllEnvs());

async function fixture(large = false) {
  const t = convexTest(schema, modules);
  const seed = await t.mutation(internal.seed.install, { passwordAlgorithm: "fixture", passwordSalt: "fixture", passwordHash: "fixture", passwordIterations: 1 });
  if (large) for (const project of seed.projects) for (let start = 0; start < 150; start += 25) {
    await t.mutation(internal.seed.largeBatch, { projectId: project.id, sessions: seed.sessions, start });
  }
  const args = { token: seed.sessions[0], projectId: seed.projects[0].id, lifecycle: "active" as const, paginationOpts: { numItems: 7, cursor: null as string | null } };
  const page = async (overrides: Partial<FunctionArgs<typeof api.tickets.pageTickets>> & { search?: string } = {}) => {
    const { search, ...rest } = overrides;
    if (search !== undefined) {
      const { paginationOpts: _opts, ...scope } = { ...args, ...rest };
      const result = await t.query(api.tickets.searchTickets, { ...scope, search });
      return { page: result.matches, isDone: !result.hasMore, continueCursor: "", pageStatus: null, splitCursor: null };
    }
    return t.query(api.tickets.pageTickets, { ...args, ...rest });
  };
  return { t, seed, args, page, staff: seed.sessions[0], alice: seed.sessions[1], bob: seed.sessions[2] };
}

test("customer pages enforce current Project membership, ownership and lifecycle before returning summaries", async () => {
  const { t, seed, page, alice, bob } = await fixture();
  const own = await page({ token: alice });
  expect(own.page.map(row => row._id)).toEqual([seed.tickets[1]]);
  expect((await page({ token: bob })).page.map(row => row._id)).toEqual([seed.tickets[2]]);
  await expect(page({ token: alice, projectId: seed.projects[1].id })).rejects.toThrow("PROJECT_NOT_FOUND");
  await t.mutation(api.tickets.archiveTicket, { token: alice, id: seed.tickets[1], expectedVersion: 0 });
  expect((await page({ token: alice })).page).toEqual([]);
  expect((await page({ token: alice, lifecycle: "archived" })).page.map(row => row._id)).toEqual([seed.tickets[1]]);
  // Detail selection remains available by ID outside any loaded page.
  expect(await t.query(api.tickets.getTicket, { token: alice, id: seed.tickets[1] })).toMatchObject({ lifecycle: "archived" });
  await t.run(async ctx => {
    for (const row of await ctx.db.query("projectMembers").collect()) await ctx.db.delete(row._id);
  });
  await expect(page({ token: alice, lifecycle: "archived" })).rejects.toThrow("PROJECT_NOT_FOUND");
});

test("page size is bounded and the summary projection excludes heavy and private fields", async () => {
  const { t, page, seed } = await fixture();
  await t.run(ctx => ctx.db.patch(seed.tickets[0], {
    description: "x".repeat(10_000), searchText: "x".repeat(10_000),
    media: [{ key: "fake-private-key", name: "fixture.png", url: "https://fixture.invalid/image.png", size: 1, type: "image/png" }],
    annotations: Array.from({ length: 25 }, (_, index) => ({ id: `${index}`, label: index, kind: "point" as const, mediaIndex: 0, x: 0, y: 0, text: "y".repeat(2000), createdAt: 1 })),
  }));
  for (const numItems of [0, -1, 51, 1.5]) await expect(page({ paginationOpts: { numItems, cursor: null } })).rejects.toThrow("INVALID_INPUT");
  const result = await page({ paginationOpts: { numItems: 50, cursor: null } });
  const row = result.page.find(row => row._id === seed.tickets[0])!;
  expect(row).toMatchObject({ excerpt: "x".repeat(200), mediaCount: 1, annotationCount: 25 });
  expect(Object.keys(row).sort()).toEqual(["_id", "annotationCount", "createdAt", "excerpt", "lifecycle", "mediaCount", "projectId", "projectKey", "status", "ticketNumber", "title", "updatedAt", "version"].sort());
  expect(JSON.stringify(row).length).toBeLessThan(800);
  expect(JSON.stringify(result)).not.toMatch(/ownerCustomerId|actorCustomerId|sessionId|fake-private-key|fixture.invalid|annotations|searchText/);
});

test("all five lanes paginate in descending Ticket order without duplicates and use independent totals", async () => {
  const { t, args, page, seed } = await fixture(true);
  const totals = await t.query(api.tickets.laneTotals, { token: args.token, projectId: args.projectId });
  const all: string[] = [];
  for (const status of ["new", "acknowledged", "in_progress", "waiting", "done"] as const) {
    let cursor: string | null = null;
    const rows = [];
    for (;;) {
      const result = await page({ status, paginationOpts: { numItems: 7, cursor } });
      expect(result.page.length).toBeLessThanOrEqual(7);
      expect(result.page.every(row => row.projectId === args.projectId && row.status === status && row.lifecycle === "active")).toBe(true);
      rows.push(...result.page);
      if (result.isDone) break;
      cursor = result.continueCursor;
    }
    expect(rows.map(row => row.ticketNumber)).toEqual(rows.map(row => row.ticketNumber).sort((a, b) => b - a));
    expect(rows.length).toBe(totals[status]);
    all.push(...rows.map(row => row._id));
  }
  expect(all).toHaveLength(153);
  expect(new Set(all).size).toBe(153);
  expect((await page({ projectId: seed.projects[1].id })).page.every(row => row.projectKey === "APP")).toBe(true);
  const first = await page({ paginationOpts: { numItems: 50, cursor: null } });
  const second = await page({ paginationOpts: { numItems: 50, cursor: first.continueCursor } });
  const widened = await page({ paginationOpts: { numItems: 7, cursor: null, endCursor: second.continueCursor } });
  expect(widened.page.length).toBeLessThanOrEqual(50);
  expect(widened.pageStatus).toBe("SplitRequired");
  // A small loaded page does not reduce workflow totals.
  expect(Object.values(totals).reduce((a, b) => a + b, 0)).toBe(153);
}, 30_000);

test("indexed reference and token/prefix search preserve Project, owner, lane and lifecycle scope", async () => {
  const { t, seed, page, alice } = await fixture(true);
  expect((await page({ search: "---" })).page).toEqual([]);
  await expect(page({ search: "word ".repeat(17) })).rejects.toThrow("INVALID_INPUT");
  const reference = await page({ search: "pos-0002" });
  expect(reference.page.map(row => row._id)).toEqual([seed.tickets[1]]);
  expect((await page({ search: "APP-0001" })).page).toEqual([]);
  expect((await page({ token: alice, search: "POS-0003" })).page).toEqual([]);
  const bounded = await page({ search: "printer" });
  expect(bounded.page).toHaveLength(50);
  expect(bounded.isDone).toBe(false);
  const matches = await page({ search: "quar" });
  expect(matches.page).toHaveLength(3);
  expect(matches.page.every(row => row.projectKey === "POS")).toBe(true);
  expect((await page({ search: "uartz" })).page).toEqual([]);
  expect((await page({ search: "quartz", status: "done" })).page).toEqual([]);
  const customerMatches = await page({ token: alice, search: "quartz" });
  expect(customerMatches.page).toHaveLength(1);
  expect(customerMatches.page[0].title).toBe("Printer calibration");
  await t.mutation(api.tickets.archiveTicket, { token: alice, id: customerMatches.page[0]._id, expectedVersion: customerMatches.page[0].version });
  expect((await page({ token: alice, search: "quartz" })).page).toEqual([]);
  expect((await page({ token: alice, search: "quartz", lifecycle: "archived" })).page).toHaveLength(1);
}, 30_000);

test("status result versions and rejected stale moves preserve lane membership and totals atomically", async () => {
  const { t, seed, page, args } = await fixture();
  const id = seed.tickets[0];
  const result = await t.mutation(api.tickets.updateTicketStatus, { token: args.token, id, status: "done", expectedVersion: 0 });
  expect(result.version).toBe(1);
  await expect(t.mutation(api.tickets.updateTicketStatus, { token: args.token, id, status: "waiting", expectedVersion: 0 })).rejects.toThrow("VERSION_CONFLICT");
  expect((await page({ status: "done" })).page.map(row => row._id)).toEqual([id]);
  expect((await page({ status: "waiting" })).page).toEqual([]);
  expect(await t.query(api.tickets.laneTotals, { token: args.token, projectId: args.projectId })).toEqual({ new: 2, done: 1 });
});

test("reference-shaped text falls back to scoped search when no exact visible Ticket exists", async () => {
  const { t, seed, page, alice, bob, staff } = await fixture();
  await t.mutation(api.tickets.editTicket, { token: alice, id: seed.tickets[1], expectedVersion: 0,
    title: "HP-1020 printer", description: "POS-0003 APP-0001" });
  for (const search of ["HP-1020", "POS-0003", "APP-0001"]) {
    expect((await page({ token: alice, search })).page.map(row => row._id)).toEqual([seed.tickets[1]]);
    expect((await page({ token: bob, search: "HP-1020" })).page).toEqual([]);
  }
  // A visible exact reference still takes priority over text matches.
  expect((await page({ search: "POS-0003" })).page.map(row => row._id)).toEqual([seed.tickets[2]]);
  await t.mutation(api.tickets.updateTicketStatus, { token: staff, id: seed.tickets[1], expectedVersion: 1, status: "done" });
  expect((await page({ search: "POS-0003", status: "done" })).page.map(row => row._id)).toEqual([seed.tickets[1]]);
  await t.mutation(api.tickets.archiveTicket, { token: alice, id: seed.tickets[1], expectedVersion: 2 });
  expect((await page({ token: alice, search: "POS-0003", lifecycle: "archived" })).page.map(row => row._id)).toEqual([seed.tickets[1]]);
});

test("summary excerpts truncate by code point without splitting an emoji at the boundary", async () => {
  const { t, seed, page } = await fixture();
  await t.run(ctx => ctx.db.patch(seed.tickets[0], { description: "x".repeat(199) + "😀tail" }));
  const summary = (await page()).page.find(row => row._id === seed.tickets[0])!;
  expect(summary.excerpt).toBe("x".repeat(199) + "😀");
  expect(Array.from(summary.excerpt)).toHaveLength(200);
});

test("detail projection excludes ownership and internal purge/search fields", async () => {
  const { t, seed, alice } = await fixture();
  await t.run(ctx => ctx.db.patch(seed.tickets[1], { purgeBlocked: true }));
  const detail = await t.query(api.tickets.getTicket, { token: alice, id: seed.tickets[1] });
  expect(detail).toMatchObject({ description: "Deterministic local text-only example", media: [], annotations: [] });
  for (const field of ["ownerCustomerId", "purgeBlocked", "searchText"]) expect(detail).not.toHaveProperty(field);
});

test("staff detail pages are bounded, scoped and preserve full CLI content without per-Ticket queries", async () => {
  const { t, args, alice, seed } = await fixture(true);
  await expect(t.query(api.tickets.pageTicketDetails, { ...args, token: alice })).rejects.toThrow("STAFF_ONLY");
  for (const numItems of [0, 51, 1.5]) {
    await expect(t.query(api.tickets.pageTicketDetails, { ...args, paginationOpts: { numItems, cursor: null } })).rejects.toThrow("INVALID_INPUT");
  }
  await t.run(ctx => ctx.db.patch(seed.tickets[0], { description: "x".repeat(10_000) }));
  const rows = [];
  let cursor: string | null = null;
  for (;;) {
    const result: FunctionReturnType<typeof api.tickets.pageTicketDetails> = await t.query(api.tickets.pageTicketDetails, { ...args, paginationOpts: { numItems: 50, cursor } });
    expect(result.page.length).toBeLessThanOrEqual(50);
    expect(result.page.every(row => row.projectId === args.projectId && row.lifecycle === "active")).toBe(true);
    rows.push(...result.page);
    if (result.isDone) break;
    cursor = result.continueCursor;
  }
  expect(rows).toHaveLength(153);
  expect(new Set(rows.map(row => row._id)).size).toBe(153);
  expect(rows.find(row => row._id === seed.tickets[0])?.description).toBe("x".repeat(10_000));
  for (const row of rows) for (const field of ["ownerCustomerId", "purgeBlocked", "searchText"]) expect(row).not.toHaveProperty(field);
}, 30_000);
