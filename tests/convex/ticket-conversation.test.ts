import { identityTest } from "./identity-harness";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import schema from "../../convex/schema";
import { modules } from "./modules";

beforeEach(() => {
  vi.stubEnv("LOCAL_FIXTURES_ENABLED", "true");
  vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3212");
});
afterEach(() => vi.unstubAllEnvs());

async function fixture() {
  const t = identityTest(modules);
  const seed = await t.mutation(internal.seed.install, {});
  const [staff, alice, bob] = seed.sessions;
  const id = seed.tickets[1];
  const question = { token: staff, id, body: "When does this happen?", expectedVersion: 0, requestId: "ask-1" };
  const page = (token: string) => t.query(api.conversations.page, { token, id, paginationOpts: { numItems: 10, cursor: null } });
  return { t, seed, staff, alice, bob, id, question, page };
}

test("asking is atomic, replayable and the owner can reply once without changing workflow status", async () => {
  const { t, staff, alice, id, question, page } = await fixture();
  const inReplyTo = await t.mutation(api.conversations.send, question);
  expect(await t.mutation(api.conversations.send, question)).toBe(inReplyTo);
  await expect(t.mutation(api.conversations.send, { ...question, body: "different" })).rejects.toThrow("REQUEST_ID_CONFLICT");
  const waiting = await t.query(api.tickets.getTicket, { token: alice, id });
  expect(waiting).toMatchObject({ status: "waiting", version: 1 });
  const reply = { token: alice, id, expectedVersion: 1, body: "During checkout", requestId: "reply-1", inReplyTo };
  await expect(t.mutation(api.conversations.send, { ...reply, expectedVersion: 0 })).rejects.toThrow("VERSION_CONFLICT");
  const replyId = await t.mutation(api.conversations.send, reply);
  expect(await t.mutation(api.conversations.send, reply)).toBe(replyId);
  await expect(t.mutation(api.conversations.send, { ...reply, requestId: "reply-2" })).rejects.toThrow("VERSION_CONFLICT");
  expect((await page(staff)).page.map(row => row.body)).toEqual([reply.body, question.body]);
  expect(await page(alice)).toEqual(await page(staff));
  expect(JSON.stringify(await page(alice))).not.toMatch(/SessionId|customerId|requestId/);
  expect((await t.query(api.tickets.getTicket, { token: staff, id }))?.status).toBe("waiting");
});

test("message access respects ownership, Project membership and archive status even on retries", async () => {
  const { t, seed, id, staff, alice, bob, question, page } = await fixture();
  await expect(t.mutation(api.conversations.send, { ...question, id: seed.tickets[0] })).rejects.toThrow("TICKET_UNAVAILABLE");
  await expect(t.mutation(api.conversations.send, { ...question, token: bob })).rejects.toThrow("TICKET_UNAVAILABLE");
  await expect(t.mutation(api.conversations.send, { ...question, body: "  " })).rejects.toThrow("INVALID_INPUT");
  expect((await page(staff)).page).toHaveLength(0);
  const inReplyTo = await t.mutation(api.conversations.send, question);
  await t.run(async ctx => {
    for (const row of await ctx.db.query("projectMembers").collect()) await ctx.db.delete(row._id);
  });
  await expect(t.mutation(api.conversations.send, { ...question, token: alice, requestId: "reply", inReplyTo })).rejects.toThrow("TICKET_UNAVAILABLE");
  expect((await page(alice)).page).toEqual([]);
  expect((await page(bob)).page).toEqual([]);
  await t.mutation(api.tickets.archiveTicket, { token: staff, id, expectedVersion: 1 });
  await expect(t.mutation(api.conversations.send, question)).rejects.toThrow("TICKET_UNAVAILABLE");
});

test("workspace links handle malformed, wrong-Project and inaccessible Ticket IDs", async () => {
  const { t, staff, bob, seed, id } = await fixture();
  const args = { token: staff, projectId: seed.projects[0].id, ticket: id as string };
  expect((await t.query(api.tickets.getWorkspaceTicket, args))?._id).toBe(id);
  for (const change of [{ ticket: "not-a-ticket" }, { ticket: seed.projects[0].id }, { projectId: seed.projects[1].id }, { token: bob }]) {
    expect(await t.query(api.tickets.getWorkspaceTicket, { ...args, ...change })).toBeNull();
  }
  await t.run(ctx => ctx.db.patch(args.projectId, { archivedAt: Date.now() }));
  expect(await t.query(api.tickets.getWorkspaceTicket, args)).toBeNull();
});
