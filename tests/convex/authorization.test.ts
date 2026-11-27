import { expect, test } from "vitest";
import { api } from "../../convex/_generated/api";
import { fixtures, identityTest } from "./identity-harness";

test("Project creation rejects missing, revoked, customer and plain staff sessions; the Owner can create", async () => {
  const t = identityTest();
  const owner = await t.mutation(fixtures.staff, { email: "owner@example.test", role: "owner" });
  const staff = await t.mutation(fixtures.staff, { email: "staff@example.test", role: "staff" });
  const customer = await t.mutation(fixtures.customer, { username: "customer" });
  const revoked = await t.mutation(fixtures.session, { staffId: owner.staffId });
  await t.run(async (ctx) => {
    const row = (await ctx.db.query("sessionAdmissions").withIndex("by_auth_session", q => q.eq("authSessionId", revoked)).unique())!;
    await ctx.db.patch(row._id, { revokedAt: Date.now() });
  });

  const input = { name: "Test Project", key: "TEST" };
  await expect(t.mutation(api.projects.createProject, input)).rejects.toThrow("SESSION_EXPIRED");
  for (const token of ["missing", revoked]) {
    await expect(t.mutation(api.projects.createProject, { ...input, token })).rejects.toThrow("SESSION_EXPIRED");
  }
  await expect(t.mutation(api.projects.createProject, { ...input, token: customer.session })).rejects.toThrow("STAFF_ONLY");
  await expect(t.mutation(api.projects.createProject, { ...input, token: staff.session })).rejects.toThrow("OWNER_ONLY");
  expect(await t.run((ctx) => ctx.db.query("projects").collect())).toEqual([]);

  // A raw token argument is not part of any protected registration.
  await expect(t.raw.withIdentity({ subject: owner.session }).mutation(api.projects.createProject, { ...input, token: owner.session } as never))
    .rejects.toThrow(/extra field|token/i);

  const project = await t.mutation(api.projects.createProject, { ...input, token: owner.session });
  expect(project).toMatchObject(input);
  expect(await t.run((ctx) => ctx.db.query("projects").collect())).toMatchObject([{ _id: project._id, ...input }]);
});
