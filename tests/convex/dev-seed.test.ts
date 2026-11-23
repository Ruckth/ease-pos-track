import { afterEach, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import { fixtures, identityTest, type IdentityTest } from "./identity-harness";
import { modules } from "./modules";
import { seedDevelopment, type SeedClients } from "../../scripts/dev-reset/seed";
import { accessTokenSessionId } from "../../convex/identity_rules";

afterEach(() => vi.unstubAllEnvs());
const customer = "Test only random length customer passphrase";

function seedClients(t: IdentityTest, owner: string): SeedClients {
  const client = (token?: string): SeedClients["owner"] => ({
    query: ((ref: never, ...args: unknown[]) => t.query(ref, { ...(args[0] as object), ...(token ? { token } : {}) } as never)) as SeedClients["owner"]["query"],
    mutation: ((ref: never, ...args: unknown[]) => t.mutation(ref, { ...(args[0] as object), ...(token ? { token } : {}) } as never)) as SeedClients["owner"]["mutation"],
    action: ((ref: never, ...args: unknown[]) => t.action(ref, { ...(args[0] as object), ...(token ? { token } : {}) } as never)) as SeedClients["owner"]["action"],
  });
  return { owner: client(owner), anonymous: client(), signedIn: accessToken => client(accessTokenSessionId(accessToken)) };
}

test("cutover seed uses registered commands with exact numbering, totals, invitation memberships, roles and revoked sessions", async () => {
  vi.stubEnv("MEDIA_CLEANUP_ENABLED", "false");
  const t = identityTest(modules);
  const { session: owner } = await t.mutation(fixtures.staff, { email: "owner@dev.example", role: "owner" });
  const clients = seedClients(t, owner);
  expect(await seedDevelopment(clients, { customer })).toMatchObject({ ok: true });
  await t.run(async ctx => {
    expect(await ctx.db.query("projects").collect()).toHaveLength(2);
    expect(await ctx.db.query("customers").collect()).toHaveLength(2);
    expect(await ctx.db.query("projectMembers").collect()).toHaveLength(4);
    expect((await ctx.db.query("projectInvitations").collect()).every(invite => invite.status === "redeemed")).toBe(true);
    const tickets = await ctx.db.query("tickets").collect();
    expect(tickets).toHaveLength(6);
    expect(tickets.filter(row => row.origin === "customer")).toHaveLength(4);
    expect(tickets.every(row => row.lifecycle === "active")).toBe(true);
    expect((await ctx.db.query("ticketCounters").collect()).map(row => row.nextNumber)).toEqual([4, 4]);
    expect(await ctx.db.query("ticketRequests").collect()).toHaveLength(6);
    expect(await ctx.db.query("ticketEvents").collect()).toHaveLength(18);
  });
  await expect(seedDevelopment(clients, { customer })).rejects.toThrow("seed requires empty Projects");
}, 60_000);

test("rehearsal Owner after clearing: the loopback pending fixture is promoted by the real one-use bootstrap, then signs in fresh and seeds", async () => {
  vi.stubEnv("MEDIA_CLEANUP_ENABLED", "false");
  vi.stubEnv("LOCAL_FIXTURES_ENABLED", "true");
  vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3212");
  vi.stubEnv("OWNER_BOOTSTRAP_GOOGLE_SUBJECT", "local-fixture-owner");
  const t = identityTest(modules);
  // A cleared installation has no staff, so no Owner session can exist yet.
  expect(await t.mutation(api.auth.signInLocalFixture, { email: "owner@local.test" })).toMatchObject({ status: "error" });
  const pending = { googleSubject: "local-fixture-owner", email: "owner@local.test" };
  expect(await t.mutation(internal.seed.localPendingOwner, {})).toEqual(pending);
  expect(await t.mutation(internal.seed.localPendingOwner, {})).toEqual(pending);
  await expect(t.mutation(internal.identity.bootstrapOwner, { googleSubject: "local-fixture-staff" })).rejects.toThrow("BOOTSTRAP_NOT_AUTHORIZED");
  const { staffId } = await t.mutation(internal.identity.bootstrapOwner, { googleSubject: "local-fixture-owner" });
  await expect(t.mutation(internal.seed.localPendingOwner, {})).rejects.toThrow("BOOTSTRAP_ALREADY_USED");
  const signedIn = await t.mutation(api.auth.signInLocalFixture, { email: "owner@local.test" });
  if (signedIn.status !== "complete") throw new Error("expected a fresh Owner session");
  const owner = accessTokenSessionId(signedIn.tokens.accessToken);
  expect(await t.query(api.identity.viewer, { token: owner })).toMatchObject({ kind: "staff", role: "owner", staffId });
  expect(await seedDevelopment(seedClients(t, owner), { customer })).toMatchObject({ ok: true });
  await t.run(async ctx => {
    expect((await ctx.db.query("staff").collect()).map(row => [row.email, row.role])).toEqual([["owner@local.test", "owner"]]);
    expect((await ctx.db.query("identityAudit").collect()).some(row => row.action === "owner.bootstrapped")).toBe(true);
  });
}, 60_000);

test("the pending Owner fixture needs local fixtures on a loopback deployment", async () => {
  for (const [enabled, url] of [["", "http://127.0.0.1:3212"], ["true", "https://outstanding-viper-292.convex.cloud"]]) {
    vi.stubEnv("LOCAL_FIXTURES_ENABLED", enabled);
    vi.stubEnv("CONVEX_CLOUD_URL", url);
    const t = identityTest(modules);
    await expect(t.mutation(internal.seed.localPendingOwner, {})).rejects.toThrow("LOCAL_FIXTURES_DISABLED");
    expect(await t.run(async ctx => await ctx.db.query("users").collect())).toEqual([]);
  }
});
