import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import schema from "../../convex/schema";
import { modules } from "./modules";

afterEach(() => vi.unstubAllEnvs());

test("failed staff logins commit counters, lock at five attempts and issue no sessions", async () => {
  vi.stubEnv("APP_PASSWORD", "Test-only-staff-password1!");
  const t = convexTest(schema, modules);
  const clientId = "staff-rate-limit-client";
  for (let attempt = 1; attempt <= 5; attempt++) {
    await expect(t.action(api.auth.login, { password: "wrong", clientId })).rejects.toThrow("INCORRECT_PASSWORD");
    expect(await t.run(ctx => ctx.db.query("loginAttempts").withIndex("by_client_id", q => q.eq("clientId", clientId)).unique()))
      .toMatchObject({ attempts: attempt });
  }
  await expect(t.action(api.auth.login, { password: "wrong", clientId })).rejects.toThrow("AUTH_RATE_LIMITED");
  await expect(t.action(api.auth.login, { password: "Test-only-staff-password1!", clientId })).rejects.toThrow("AUTH_RATE_LIMITED");
  expect(await t.run(ctx => ctx.db.query("sessions").collect())).toEqual([]);
  await t.run(async ctx => {
    const attempt = await ctx.db.query("loginAttempts").withIndex("by_client_id", q => q.eq("clientId", clientId)).unique();
    await ctx.db.patch(attempt!._id, { lockedUntil: Date.now() - 1 });
  });
  const session = await t.action(api.auth.login, { password: "Test-only-staff-password1!", clientId });
  expect(await t.query(api.auth.currentSession, { token: session.token })).toMatchObject({ role: "staff" });
  expect(await t.run(ctx => ctx.db.query("loginAttempts").withIndex("by_client_id", q => q.eq("clientId", clientId)).unique())).toBeNull();
});

test("staff global failure counter limits attempts across different client identities", async () => {
  vi.stubEnv("APP_PASSWORD", "Test-only-staff-password1!");
  const t = convexTest(schema, modules);
  for (let attempt = 0; attempt < 50; attempt++) {
    await expect(t.action(api.auth.login, { password: "wrong", clientId: `staff-global-client-${attempt}` })).rejects.toThrow("INCORRECT_PASSWORD");
  }
  expect(await t.run(ctx => ctx.db.query("loginAttempts").withIndex("by_client_id", q => q.eq("clientId", "__global__")).unique())).toMatchObject({ attempts: 50 });
  await expect(t.action(api.auth.login, { password: "Test-only-staff-password1!", clientId: "staff-global-new-client" })).rejects.toThrow("AUTH_RATE_LIMITED");
  expect(await t.run(ctx => ctx.db.query("sessions").collect())).toEqual([]);
});

test("duplicate registration failures commit before rejection and respect the client lockout", async () => {
  vi.stubEnv("CUSTOMER_PASSWORD_PEPPER", "test-only-pepper");
  const t = convexTest(schema, modules);
  await t.run(ctx => ctx.db.insert("customers", {
    email: "existing@example.test", passwordAlgorithm: "fixture", passwordSalt: "fixture", passwordHash: "fixture", passwordIterations: 1,
    createdAt: Date.now(), updatedAt: Date.now(),
  }));
  const clientId = "registration-rate-limit-client";
  for (let attempt = 1; attempt <= 5; attempt++) {
    await expect(t.action(api.customers.register, { email: "existing@example.test", password: "Test-only-customer-password1!", clientId })).rejects.toThrow("EMAIL_ALREADY_REGISTERED");
    expect(await t.run(ctx => ctx.db.query("loginAttempts").withIndex("by_client_id", q => q.eq("clientId", `customer:${clientId}`)).unique())).toMatchObject({ attempts: attempt });
  }
  await expect(t.action(api.customers.register, { email: "new@example.test", password: "Test-only-customer-password1!", clientId })).rejects.toThrow("AUTH_RATE_LIMITED");
  expect(await t.run(ctx => ctx.db.query("customers").collect())).toHaveLength(1);
  expect(await t.run(ctx => ctx.db.query("sessions").collect())).toEqual([]);
  const registered = await t.action(api.customers.register, { email: "new@example.test", password: "Test-only-customer-password1!", clientId: "registration-other-client" });
  expect(await t.query(api.auth.currentSession, { token: registered.token })).toMatchObject({ role: "customer", email: "new@example.test" });
});

test("a registration race also commits its duplicate failure at finalization", async () => {
  const t = convexTest(schema, modules);
  const clientId = "registration-race-client";
  expect(await t.mutation(internal.customers.startRegistration, { email: "race@example.test", clientId })).toEqual({ error: null });
  const input = { email: "race@example.test", clientId, passwordAlgorithm: "fixture", passwordSalt: "fixture", passwordHash: "fixture", passwordIterations: 1 };
  const winner = await t.mutation(internal.customers.finishRegistration, input);
  expect(winner).toHaveProperty("token");
  expect(await t.mutation(internal.customers.finishRegistration, input)).toEqual({ error: "EMAIL_ALREADY_REGISTERED" });
  expect(await t.run(ctx => ctx.db.query("loginAttempts").withIndex("by_client_id", q => q.eq("clientId", `customer:${clientId}`)).unique())).toMatchObject({ attempts: 1 });
  expect(await t.run(ctx => ctx.db.query("customers").collect())).toHaveLength(1);
  expect(await t.run(ctx => ctx.db.query("sessions").collect())).toHaveLength(1);
});
