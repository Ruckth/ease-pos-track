import { identityTest } from "./identity-harness";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import schema from "../../convex/schema";
import { modules } from "./modules";

beforeEach(() => {
  vi.stubEnv("LOCAL_FIXTURES_ENABLED", "true");
  vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3212");
  vi.stubEnv("APP_PASSWORD", "LocalStaff123!");
  vi.stubEnv("CUSTOMER_PASSWORD_PEPPER", "local-only-fixture-pepper");
  vi.stubEnv("UPLOAD_CALLBACK_SECRET", "local-only-callback-fixture");
  vi.stubEnv("MEDIA_CLEANUP_ENABLED", "false");
});
afterEach(() => vi.unstubAllEnvs());

const orders = [
  ["run", "media", "largeSeed"], ["run", "largeSeed", "media"],
  ["media", "run", "largeSeed"], ["media", "largeSeed", "run"],
  ["largeSeed", "run", "media"], ["largeSeed", "media", "run"],
] as const;

test.each(orders.map(order => [order.join(", "), order] as const))(
  "backend/media smokes repeat around large seeds on fresh and reused data in order %s",
  async (_name, order) => {
    const t = identityTest(modules);
    for (const smoke of [...order, ...order]) {
      // convex-test does not simulate relevance ranking. reads runs against the
      // real local backend; reproduce its persistent large-seed effects here.
      if (smoke === "largeSeed") await t.action(internal.seed.run, { largeDataset: true });
      else expect(await t.action(internal.local_smoke[smoke], (smoke === "run" ? { skipGoogle: true } : {}) as never)).toMatchObject({ ok: true });
    }
  }, 120_000,
);

test("backend/media smokes tolerate large seeds, existing APP membership and more than one search page of unrelated matches", async () => {
  const t = identityTest(modules);
  const seed = await t.action(internal.seed.run, { largeDataset: true });
  for (let index = 0; index < 55; index++) {
    await t.mutation(api.tickets.createTextTicket, {
      token: seed.sessions[0], projectKey: "POS", requestId: `noise-${index}`,
      title: "quartz", description: "Unrelated existing Ticket",
    });
  }
  const search = await t.query(api.tickets.searchTickets, {
    token: seed.sessions[0], projectId: seed.projects[0].id, lifecycle: "active", search: "quar",
  });
  expect(search.matches).toHaveLength(50);
  expect(search.hasMore).toBe(true);
  for (const smoke of [...orders[0], ...orders[0]]) {
    if (smoke === "largeSeed") await t.action(internal.seed.run, { largeDataset: true });
    else expect(await t.action(internal.local_smoke[smoke], (smoke === "run" ? { skipGoogle: true } : {}) as never)).toMatchObject({ ok: true });
  }
}, 120_000);
