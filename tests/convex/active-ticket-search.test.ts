import { identityTest } from "./identity-harness";
import { afterEach, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import schema from "../../convex/schema";
import { modules } from "./modules";

afterEach(() => vi.unstubAllEnvs());

test("active search finds and ranks eligible Tickets before applying the result limit", async () => {
  vi.stubEnv("LOCAL_FIXTURES_ENABLED", "true");
  vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3212");
  const t = identityTest(modules);
  const seed = await t.mutation(internal.seed.install, {});
  const scope = { token: seed.sessions[0], projectId: seed.projects[0].id, lifecycle: "active" as const };
  const search = "lanefixture";
  const row = {
    projectId: scope.projectId, projectKey: seed.projects[0].key, title: search, description: "",
    searchText: search, media: [], annotations: [], version: 0, lifecycle: "active" as const,
    origin: "staff" as const, createdAt: 1, updatedAt: 1,
  };
  await t.run(async ctx => {
    for (let n = 100; n < 151; n++) await ctx.db.insert("tickets", { ...row, ticketNumber: n, status: "done" });
    await ctx.db.insert("tickets", { ...row, ticketNumber: 151, status: "waiting" });
  });

  const all = await t.query(api.tickets.searchTickets, { ...scope, search });
  expect(all.matches).toHaveLength(50);
  expect(all.matches.every(ticket => ticket.status === "done")).toBe(true);
  expect(all.hasMore).toBe(true);

  const active = () => t.query(api.tickets.searchTickets, { ...scope, search, activeOnly: true });
  const first = await active();
  expect(first.matches.map(ticket => ticket.ticketNumber)).toEqual([151]);
  expect(first.hasMore).toBe(false);
  const reference = await t.query(api.tickets.searchTickets, { ...scope, search: "POS-0151", activeOnly: true });
  expect(reference.matches.map(ticket => ticket.ticketNumber)).toEqual([151]);
  expect((await t.query(api.tickets.searchTickets, { ...scope, search: "POS-0100", activeOnly: true })).matches).toEqual([]);

  // Fifty matches across lanes fit exactly. The fifty-first sets hasMore even
  // when no single lane has fifty-one rows.
  await t.run(async ctx => {
    for (let n = 152; n <= 200; n++) {
      await ctx.db.insert("tickets", { ...row, ticketNumber: n, status: n % 2 === 0 ? "new" : "in_progress" });
    }
  });
  const exact = await active();
  expect(exact.matches).toHaveLength(50);
  expect(exact.hasMore).toBe(false);
  expect(exact.matches.slice(0, 3).map(ticket => ticket.status)).toEqual(["new", "in_progress", "waiting"]);
  await t.run(ctx => ctx.db.insert("tickets", { ...row, ticketNumber: 201, status: "acknowledged" }));
  const overflow = await active();
  expect(overflow.matches).toHaveLength(50);
  expect(overflow.hasMore).toBe(true);
  expect(overflow.matches.slice(0, 4).map(ticket => ticket.status)).toEqual(["new", "acknowledged", "in_progress", "waiting"]);
  expect((await active()).matches).toEqual(overflow.matches);
});
