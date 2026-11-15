import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "../../convex/_generated/api";
import schema from "../../convex/schema";
import { modules } from "./modules";

test("Project creation rejects missing, expired and customer sessions; staff can create", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const now = Date.now();
    const customerId = await ctx.db.insert("customers", {
      email: "customer@example.test",
      passwordAlgorithm: "fixture",
      passwordSalt: "fixture",
      passwordHash: "fixture",
      passwordIterations: 1,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("sessions", {
      token: "customer", role: "customer", customerId,
      createdAt: now, expiresAt: now + 60_000,
    });
    await ctx.db.insert("sessions", {
      token: "staff", role: "staff", createdAt: now, expiresAt: now + 60_000,
    });
    await ctx.db.insert("sessions", {
      token: "expired", role: "staff", createdAt: now - 60_000, expiresAt: now - 1,
    });
  });

  const input = { name: "Test Project", key: "TEST" };
  for (const token of ["missing", "expired"]) {
    await expect(t.mutation(api.projects.createProject, { ...input, token }))
      .rejects.toThrow("SESSION_EXPIRED");
  }
  await expect(t.mutation(api.projects.createProject, { ...input, token: "customer" }))
    .rejects.toThrow("STAFF_ONLY");
  expect(await t.run((ctx) => ctx.db.query("projects").collect())).toEqual([]);

  const project = await t.mutation(api.projects.createProject, { ...input, token: "staff" });
  expect(project).toMatchObject(input);
  expect(await t.run((ctx) => ctx.db.query("projects").collect()))
    .toMatchObject([{ _id: project._id, ...input }]);
});
