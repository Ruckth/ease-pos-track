import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import { identityTest } from "./identity-harness";
import { modules } from "./modules";

beforeEach(() => {
  vi.stubEnv("LOCAL_FIXTURES_ENABLED", "true");
  vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3212");
});
afterEach(() => vi.unstubAllEnvs());

test("customer groups filter before pagination, with owner and Project scope during and after backfill", async () => {
  const t = identityTest(modules);
  const seed = await t.mutation(internal.seed.install, {});
  const [staff, alice, bob] = seed.sessions;
  const projectId = seed.projects[0].id;
  const otherProjectId = seed.projects[1].id;
  const waitingId = await t.run(async ({ db }) => {
    const original = (await db.get(seed.tickets[1]))!;
    const { _id, _creationTime, ...row } = original;
    const waiting = await db.insert("tickets", { ...row, customerQueueGroup: undefined, status: "waiting", ticketNumber: 900 });
    const active = ["new", "acknowledged", "in_progress"] as const;
    for (let i = 0; i < 21; i++) {
      await db.insert("tickets", { ...row, customerQueueGroup: "active", status: active[i % active.length], ticketNumber: 901 + i });
    }
    await db.insert("tickets", { ...row, customerQueueGroup: "waiting", status: "waiting", projectId: otherProjectId, projectKey: seed.projects[1].key, ticketNumber: 950 });
    return waiting;
  });
  const ready = () => t.query(api.tickets.customerQueueIndexReady, { token: alice, projectId });
  expect(await ready()).toBe(false);
  const initial = { token: alice, projectId, lifecycle: "active" as const, paginationOpts: { numItems: 20, cursor: null as string | null } };
  const all = await t.query(api.tickets.pageTickets, initial);
  expect(all.page.some(row => row._id === waitingId)).toBe(false);
  expect((await t.query(api.tickets.pageTickets, { ...initial, customerGroup: "waiting", legacyCustomerGroup: true })).page.map(row => row._id)).toEqual([waitingId]);

  const migrate = (cursor?: string) => t.mutation(internal.customer_queue_migration.backfill, { cursor });
  for (let result = await migrate(); !result.isDone;) result = await migrate(result.continueCursor);
  expect(await ready()).toBe(true);
  expect((await t.query(api.tickets.pageTickets, { ...initial, customerGroup: "waiting" })).page.map(row => row._id)).toEqual([waitingId]);
  expect((await t.query(api.tickets.pageTickets, { ...initial, token: bob, customerGroup: "waiting" })).page.map(row => row._id)).not.toContain(waitingId);

  const active = { ...initial, customerGroup: "active" as const };
  const first = await t.query(api.tickets.pageTickets, active);
  const second = await t.query(api.tickets.pageTickets, { ...active, paginationOpts: { numItems: 20, cursor: first.continueCursor } });
  const rows = [...first.page, ...second.page];
  expect(rows.map(row => row.ticketNumber)).toEqual(rows.map(row => row.ticketNumber).sort((a, b) => b - a));
  expect(new Set(rows.map(row => row._id)).size).toBe(rows.length);
  expect(new Set(first.page.map(row => row.status))).toEqual(new Set(["new", "acknowledged", "in_progress"]));

  await t.mutation(api.tickets.updateTicketStatus, { token: staff, id: waitingId, status: "in_progress", expectedVersion: 0 });
  expect((await t.query(api.tickets.pageTickets, { ...initial, customerGroup: "waiting" })).page).toEqual([]);
});

test("archive reconciliation exposes only authorized lifecycle and version for archived Tickets", async () => {
  const t = identityTest(modules);
  const seed = await t.mutation(internal.seed.install, {});
  const [, alice, bob] = seed.sessions;
  const scope = { id: seed.tickets[1], projectId: seed.projects[0].id, token: alice };
  const read = (args = scope) => t.query(api.tickets.customerArchiveState, args);
  expect(await read()).toMatchObject({ lifecycle: "active", version: 0, title: expect.any(String) });
  await t.mutation(api.tickets.archiveTicket, { token: alice, id: scope.id, expectedVersion: 0 });
  expect(await read()).toEqual({ lifecycle: "archived", version: 1 });
  expect(await read({ ...scope, token: bob })).toBeNull();
  expect(await read({ ...scope, projectId: seed.projects[1].id })).toBeNull();
  await t.run(async ({ db }) => {
    for (const member of await db.query("projectMembers").collect()) await db.delete(member._id);
  });
  expect(await read()).toBeNull();
});

test("answering a customer request checks the waiting version after replay and rechecks live scope", async () => {
  const t = identityTest(modules);
  const seed = await t.mutation(internal.seed.install, {});
  const [staff, alice, bob] = seed.sessions;
  const id = seed.tickets[1];
  const ask = await t.mutation(api.conversations.send, { token: staff, id, body: "Which printer?", requestId: "queue-ask", expectedVersion: 0 });
  const answer = { token: alice, id, body: "Printer 2", requestId: "queue-answer", expectedVersion: 1, inReplyTo: ask, answeringRequest: true, answerRequest: ask };
  await expect(t.mutation(api.conversations.send, { ...answer, token: bob })).rejects.toThrow("TICKET_UNAVAILABLE");
  await expect(t.mutation(api.conversations.send, { ...answer, expectedVersion: 0 })).rejects.toThrow("VERSION_CONFLICT");
  await expect(t.mutation(api.conversations.send, { ...answer, answerRequest: undefined })).rejects.toThrow("VERSION_CONFLICT");
  const message = await t.mutation(api.conversations.send, answer);
  await expect(t.mutation(api.conversations.send, { ...answer, answeringRequest: undefined, answerRequest: undefined })).rejects.toThrow("REQUEST_ID_CONFLICT");
  await expect(t.mutation(api.conversations.send, { ...answer, expectedVersion: 0 })).rejects.toThrow("REQUEST_ID_CONFLICT");
  expect((await t.query(api.tickets.getTicket, { token: alice, id }))?.latestReply).toMatchObject({ answeredCustomerRequest: true, awaitingCustomer: false });
  await t.mutation(api.tickets.updateTicketStatus, { token: staff, id, status: "in_progress", expectedVersion: 1 });
  expect(await t.mutation(api.conversations.send, answer)).toBe(message);
  await expect(t.mutation(api.conversations.send, { ...answer, requestId: "queue-stale-answer" })).rejects.toThrow("VERSION_CONFLICT");
  const read = (token: string) => t.query(api.conversations.page, { token, id, paginationOpts: { numItems: 10, cursor: null } });
  expect((await read(alice)).page.map(row => row.body)).toEqual(["Printer 2", "Which printer?"]);
  expect(await read(alice)).toEqual(await read(staff));
  await t.run(({ db }) => db.patch(seed.projects[0].id, { archivedAt: Date.now() }));
  await expect(t.mutation(api.conversations.send, answer)).rejects.toThrow("TICKET_UNAVAILABLE");
  await t.run(async ({ db }) => {
    await db.patch(seed.projects[0].id, { archivedAt: undefined });
    for (const membership of await db.query("projectMembers").collect()) await db.delete(membership._id);
  });
  await expect(t.mutation(api.conversations.send, answer)).rejects.toThrow("TICKET_UNAVAILABLE");
});

test("a manual Waiting move requires one versioned answer without a staff question", async () => {
  const t = identityTest(modules);
  const seed = await t.mutation(internal.seed.install, {});
  const [staff, alice] = seed.sessions;
  const id = seed.tickets[1];
  await t.mutation(api.tickets.updateTicketStatus, { token: staff, id, status: "waiting", expectedVersion: 0 });
  const reply = { token: alice, id, body: "Here is more context", expectedVersion: 1, requestId: "manual-answer" };
  await expect(t.mutation(api.conversations.send, { ...reply, expectedVersion: undefined })).rejects.toThrow("VERSION_CONFLICT");
  const explicit = { ...reply, answeringRequest: true, answerRequest: null };
  const answered = await t.mutation(api.conversations.send, explicit);
  expect(await t.mutation(api.conversations.send, explicit)).toBe(answered);
  expect((await t.query(api.tickets.getTicket, { token: alice, id }))?.latestReply).toMatchObject({ answeredCustomerRequest: true });
  await t.mutation(api.conversations.send, { ...reply, requestId: "generic-followup", expectedVersion: 0 });
});

test("old Waiting clients replay unmarked messages and submit matching-version implicit answers", async () => {
  const t = identityTest(modules);
  const seed = await t.mutation(internal.seed.install, {});
  const [staff, alice] = seed.sessions;
  const id = seed.tickets[1];
  const legacyPost = { token: alice, id, body: "Already entered", requestId: "unmarked-message" };
  const post = await t.mutation(api.conversations.send, legacyPost);
  const ask = await t.mutation(api.conversations.send, { token: staff, id, body: "Which drawer?", requestId: "legacy-ask", expectedVersion: 0 });
  expect(await t.mutation(api.conversations.send, legacyPost)).toBe(post);
  const legacyAnswer = { token: alice, id, body: "Drawer 2", requestId: "legacy-answer", inReplyTo: ask };
  await expect(t.mutation(api.conversations.send, legacyAnswer)).rejects.toThrow("VERSION_CONFLICT");
  await expect(t.mutation(api.conversations.send, { ...legacyAnswer, expectedVersion: 0 })).rejects.toThrow("VERSION_CONFLICT");
  const accepted = await t.mutation(api.conversations.send, { ...legacyAnswer, expectedVersion: 1 });
  expect((await t.query(api.tickets.getTicket, { token: alice, id }))?.latestReply).toMatchObject({ answeredCustomerRequest: true, awaitingCustomer: false });
  const nextAsk = await t.mutation(api.conversations.send, { token: staff, id, body: "Which register?", requestId: "newer-ask", expectedVersion: 1 });
  expect(await t.mutation(api.conversations.send, { ...legacyAnswer, expectedVersion: 1 })).toBe(accepted);
  expect(await t.query(api.conversations.openRequest, { token: alice, id })).toMatchObject({ _id: nextAsk });
});

test("a newer question supersedes an earlier question or manual answer without changing Ticket version", async () => {
  const t = identityTest(modules);
  const seed = await t.mutation(internal.seed.install, {});
  const [staff, alice] = seed.sessions;
  const id = seed.tickets[1];
  await t.mutation(api.tickets.updateTicketStatus, { token: staff, id, status: "waiting", expectedVersion: 0 });
  const ask = (requestId: string, body: string) => t.mutation(api.conversations.send, { token: staff, id, body, requestId, expectedVersion: 1 });
  const a = await ask("question-a", "What outlet?");
  const b = await ask("question-b", "What serial number?");
  const answer = { token: alice, id, body: "Serial 123", requestId: "bound-to-b", expectedVersion: 1, answeringRequest: true };
  for (const request of [null, a]) {
    await expect(t.mutation(api.conversations.send, { ...answer, answerRequest: request })).rejects.toThrow("VERSION_CONFLICT");
  }
  await expect(t.mutation(api.conversations.send, { token: alice, id, body: "A-1", requestId: "legacy-quoted-a", expectedVersion: 1, inReplyTo: a })).rejects.toThrow("VERSION_CONFLICT");
  expect(await t.query(api.conversations.openRequest, { token: alice, id })).toMatchObject({ _id: b });
  const matching = { ...answer, answerRequest: b, inReplyTo: a };
  const recorded = await t.mutation(api.conversations.send, matching);
  await ask("question-c", "When was it installed?");
  expect(await t.mutation(api.conversations.send, matching)).toBe(recorded);
  await expect(t.mutation(api.conversations.send, { ...matching, answerRequest: a })).rejects.toThrow("REQUEST_ID_CONFLICT");
});
