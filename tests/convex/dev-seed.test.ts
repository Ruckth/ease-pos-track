import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import schema from "../../convex/schema";
import { modules } from "./modules";
import { seedDevelopment } from "../../scripts/dev-reset/seed";

afterEach(() => vi.unstubAllEnvs());
test("cutover seed uses registered commands with exact numbering, totals, memberships, roles and revoked sessions", async () => {
  const staff = "Test-only-random-length-staff-password1!";
  const customer = "Test-only-random-length-customer-password1!";
  vi.stubEnv("APP_PASSWORD", staff);
  vi.stubEnv("CUSTOMER_PASSWORD_PEPPER", "test-only-pepper");
  vi.stubEnv("MEDIA_CLEANUP_ENABLED", "false");
  const t = convexTest(schema, modules);
  const client: Parameters<typeof seedDevelopment>[0] = {
    query: (ref, ...args) => t.query(ref, ...args as never),
    mutation: (ref, ...args) => t.mutation(ref, ...args as never),
    action: (ref, ...args) => t.action(ref, ...args as never),
  };
  expect(await seedDevelopment(client, { staff, customer })).toMatchObject({ ok: true });
  await t.run(async ctx => {
    expect(await ctx.db.query("projects").collect()).toHaveLength(2);
    expect(await ctx.db.query("customers").collect()).toHaveLength(2);
    expect(await ctx.db.query("projectMembers").collect()).toHaveLength(4);
    const tickets = await ctx.db.query("tickets").collect();
    expect(tickets).toHaveLength(6);
    expect(tickets.filter(row => row.origin === "customer")).toHaveLength(4);
    expect(tickets.every(row => row.lifecycle === "active")).toBe(true);
    expect((await ctx.db.query("ticketCounters").collect()).map(row => row.nextNumber)).toEqual([4, 4]);
    expect(await ctx.db.query("ticketRequests").collect()).toHaveLength(6);
    expect(await ctx.db.query("ticketEvents").collect()).toHaveLength(18);
    expect(await ctx.db.query("sessions").collect()).toHaveLength(0);
  });
  await expect(seedDevelopment(client, { staff, customer })).rejects.toThrow("seed requires empty Projects");
}, 30_000);
