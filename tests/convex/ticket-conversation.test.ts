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

test("asking is atomic and replayable; the thread stays open to both sides without customer workflow changes", async () => {
  const { t, staff, alice, id, question, page } = await fixture();
  const inReplyTo = await t.mutation(api.conversations.send, question);
  expect(await t.mutation(api.conversations.send, question)).toBe(inReplyTo);
  await expect(t.mutation(api.conversations.send, { ...question, body: "different" })).rejects.toThrow("REQUEST_ID_CONFLICT");
  await expect(t.mutation(api.conversations.send, { ...question, requestReply: false })).rejects.toThrow("REQUEST_ID_CONFLICT");
  expect(await t.mutation(api.conversations.send, { ...question, requestReply: true })).toBe(inReplyTo);
  await expect(t.mutation(api.conversations.send, { ...question, token: alice })).rejects.toThrow("REQUEST_ID_CONFLICT");
  const waiting = await t.query(api.tickets.getTicket, { token: alice, id });
  expect(waiting).toMatchObject({ status: "waiting", version: 1 });
  // Legacy customer clients still send a version and the latest question; a stale version is harmless for a plain post.
  const reply = { token: alice, id, expectedVersion: 0, body: "During checkout", requestId: "reply-1", inReplyTo };
  const replyId = await t.mutation(api.conversations.send, reply);
  expect(await t.mutation(api.conversations.send, reply)).toBe(replyId);
  const followUp = await t.mutation(api.conversations.send, { token: alice, id, expectedVersion: 1, body: "Also on refunds", requestId: "reply-2" });
  const staffNote = await t.mutation(api.conversations.send, { token: staff, id, expectedVersion: 1, body: "Thanks", requestId: "note-1", requestReply: false, inReplyTo: replyId });
  const rows = (await page(staff)).page;
  expect(rows.map(row => row.body)).toEqual(["Thanks", "Also on refunds", reply.body, question.body]);
  expect(rows[0]).toMatchObject({ _id: staffNote, role: "staff", requestReply: false, inReplyTo: replyId, quote: { id: replyId, role: "customer", body: reply.body }, media: [] });
  expect(rows[1]).toMatchObject({ _id: followUp, role: "customer", media: [] });
  expect(rows[1]).not.toHaveProperty("requestReply");
  expect(rows[3]).toMatchObject({ requestReply: true });
  expect(await page(alice)).toEqual(await page(staff));
  expect(JSON.stringify(await page(alice))).not.toMatch(/SessionId|customerId|requestId|uploadIntent|staffId/);
  expect((await t.query(api.tickets.getTicket, { token: staff, id }))?.status).toBe("waiting");
});

test("requestReply moves to Waiting atomically for staff only and resolved Tickets close the thread", async () => {
  const { t, staff, alice, id, question } = await fixture();
  const status = async () => (await t.query(api.tickets.getTicket, { token: staff, id }))!;
  await t.mutation(api.conversations.send, { ...question, requestReply: false, requestId: "plain" });
  expect(await status()).toMatchObject({ version: 0 });
  await expect(t.mutation(api.conversations.send, { token: alice, id, body: "x", requestId: "c1", expectedVersion: 0, requestReply: true })).rejects.toThrow("STAFF_ONLY");
  expect(await t.mutation(api.conversations.send, { token: alice, id, body: "x", requestId: "c2", expectedVersion: 0, requestReply: false })).toBeTruthy();
  await expect(t.mutation(api.conversations.send, { ...question, requestReply: true, expectedVersion: 3, requestId: "stale" })).rejects.toThrow("VERSION_CONFLICT");
  await t.mutation(api.conversations.send, { ...question, requestReply: true, requestId: "ask" });
  expect(await status()).toMatchObject({ status: "waiting", version: 1 });
  // Already waiting: guarded, but no extra status event.
  await t.mutation(api.conversations.send, { ...question, requestReply: true, expectedVersion: 1, requestId: "ask-again" });
  expect(await status()).toMatchObject({ status: "waiting", version: 1 });
  await t.mutation(api.tickets.updateTicketStatus, { token: staff, id, status: "done", expectedVersion: 1 });
  for (const token of [staff, alice]) {
    await expect(t.mutation(api.conversations.send, { token, id, body: "late", requestId: `late-${token}`, expectedVersion: 2, requestReply: false })).rejects.toThrow("TICKET_RESOLVED");
  }
  // A committed message still replays after resolution.
  expect(await t.mutation(api.conversations.send, { ...question, requestReply: false, requestId: "plain" })).toBeTruthy();
});

test("links are normalized HTTPS or same-Ticket published pages attached by staff", async () => {
  const { t, seed, staff, alice, id, question, page } = await fixture();
  const first = await t.mutation(api.conversations.send, { ...question, requestReply: false });
  const sessionId = await t.run(async ctx => (await ctx.db.get(first))!.authorSessionId);
  const projectId = await t.run(async ctx => (await ctx.db.get(id))!.projectId);
  const insertPage = (ticketId: typeof id, state: "published" | "staging" | "revoked", shareKey?: string) => t.run(ctx => ctx.db.insert("ticketPages", {
    ticketId, projectId, requestId: crypto.randomUUID(), actorRole: "staff", sessionId, inputDigest: "d", entryPath: "reports/index.html",
    manifest: [], files: [], discarded: [], totalBytes: 0, state, ...(shareKey ? { shareKey } : {}), expiresAt: Date.now() + 1e6, createdAt: Date.now(), updatedAt: Date.now(),
  }));
  const own = await insertPage(id, "published", "share-own");
  const staged = await insertPage(id, "staging");
  const foreign = await insertPage(seed.tickets[0], "published", "share-foreign");
  const send = (token: string, requestId: string, link: { kind: "external"; url: string } | { kind: "page"; pageId: typeof own }, body = "") =>
    t.mutation(api.conversations.send, { token, id, body, requestId, expectedVersion: 0, requestReply: false, link });

  for (const url of ["http://example.com", "https://user:pw@example.com", "https://exa mple.com", "https://example.com/\u0007", "javascript:alert(1)", "https://", "https://example.com/" + "a".repeat(2100)]) {
    await expect(send(staff, `bad-${url.length}-${url.slice(0, 12)}`, { kind: "external", url })).rejects.toThrow("INVALID_LINK");
  }
  const external = await send(alice, "ext", { kind: "external", url: "  https://Example.COM/a?b=1#c  " });
  expect(await send(alice, "ext", { kind: "external", url: "https://example.com/a?b=1#c" })).toBe(external);
  await expect(send(alice, "ext", { kind: "external", url: "https://example.com/other" })).rejects.toThrow("REQUEST_ID_CONFLICT");
  await expect(send(alice, "cust-page", { kind: "page", pageId: own })).rejects.toThrow("STAFF_ONLY");
  for (const pageId of [staged, foreign]) await expect(send(staff, `page-${pageId}`, { kind: "page", pageId })).rejects.toThrow("PAGE_UNAVAILABLE");
  const pageMessage = await send(staff, "page", { kind: "page", pageId: own }, "Report");
  const otherTicketMessage = await t.run(ctx => ctx.db.insert("ticketMessages", {
    ticketId: seed.tickets[0], role: "staff", authorSessionId: sessionId, body: "other", requestId: "other",
  }));
  await expect(t.mutation(api.conversations.send, { token: alice, id, body: "q", requestId: "cross", expectedVersion: 0, inReplyTo: otherTicketMessage })).rejects.toThrow("INVALID_INPUT");
  const quoting = await t.mutation(api.conversations.send, { token: alice, id, body: "About this report", requestId: "quote", expectedVersion: 0, inReplyTo: pageMessage });

  const rows = async () => Object.fromEntries((await page(alice)).page.map(row => [row._id, row]));
  const pageLink = { kind: "page", pageId: own, title: "reports/index.html", url: "http://127.0.0.1:3213/p/share-own/reports/index.html" };
  vi.stubEnv("CONVEX_SITE_URL", "http://127.0.0.1:3213");
  let view = await rows();
  expect(view[external].link).toEqual({ kind: "external", url: "https://example.com/a?b=1#c" });
  expect(view[pageMessage].link).toEqual(pageLink);
  expect(view[quoting].quote).toEqual({ id: pageMessage, role: "staff", body: "Report", link: pageLink });
  expect(JSON.stringify(view)).not.toContain("share-foreign");
  await t.mutation(api.pages.revokeTicketPage, { token: staff, pageId: own });
  view = await rows();
  expect(view[pageMessage].link).toEqual({ kind: "page", pageId: own, title: "reports/index.html" });
  expect(view[quoting].quote?.link).toEqual({ kind: "page", pageId: own, title: "reports/index.html" });
});

test("message media joins the Ticket ledger atomically, enforces intent ownership and replays", async () => {
  const { t, staff, alice, bob, id, page } = await fixture();
  vi.stubEnv("UPLOAD_CALLBACK_SECRET", "fake-callback-secret");
  const media = [{ key: "fake-msg-1", name: "shot.png", size: 1, type: "image/png", url: "https://fixture.invalid/shot.png" }];
  const intent = await t.mutation(api.uploads.createUploadIntent, { token: alice, idempotencyKey: "message-media-request", files: media.map(({ name, size, type }) => ({ name, size, type })) });
  for (const file of media) await t.mutation(api.uploads.recordUploadedFile, { intentId: intent.intentId, secret: intent.secret, file, callbackToken: "fake-callback-secret" });
  const args = { token: alice, id, body: "", requestId: "media-1", expectedVersion: 0, media, uploadIntentId: intent.intentId, uploadIntentSecret: intent.secret };
  await expect(t.mutation(api.conversations.send, { ...args, token: staff })).rejects.toThrow("UPLOAD_INTENT_NOT_FOUND");
  await expect(t.mutation(api.conversations.send, { ...args, token: bob })).rejects.toThrow("TICKET_UNAVAILABLE");
  await expect(t.mutation(api.conversations.send, { ...args, uploadIntentSecret: undefined })).rejects.toThrow("UPLOAD_INTENT_INVALID");
  await expect(t.mutation(api.conversations.send, { ...args, expectedVersion: 5 })).rejects.toThrow("VERSION_CONFLICT");
  const messageId = await t.mutation(api.conversations.send, args);
  const ticket = (await t.query(api.tickets.getTicket, { token: staff, id }))!;
  expect(ticket).toMatchObject({ version: 1 });
  expect(await t.run(async ctx => (await ctx.db.get(id))!.media.map(item => item.key))).toContain("fake-msg-1");
  const asset = await t.run(ctx => ctx.db.query("mediaAssets").withIndex("by_key", q => q.eq("key", "fake-msg-1")).unique());
  expect(asset).toMatchObject({ lifecycle: "attached", ticketId: id });
  expect(await t.mutation(api.conversations.send, args)).toBe(messageId);
  await expect(t.mutation(api.conversations.send, { ...args, media: [{ ...media[0], key: "fake-other" }] })).rejects.toThrow("REQUEST_ID_CONFLICT");
  await expect(t.mutation(api.conversations.send, { ...args, uploadIntentSecret: "wrong" })).rejects.toThrow("UPLOAD_INTENT_NOT_FOUND");
  expect((await page(staff)).page[0]).toMatchObject({ _id: messageId, media });
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

test("staff-created Tickets expose the conversation only to staff and their mapped customer", async () => {
  const { t, seed, id, staff, alice, bob, question, page } = await fixture();
  await t.run(ctx => ctx.db.patch(id, { origin: "staff", createdVia: "line" }));
  const get = (token: string, ticketId = id) => t.query(api.tickets.getTicket, { token, id: ticketId });
  expect(await get(alice)).toMatchObject({ hasCustomerOwner: true, origin: "staff" });
  expect(await get(staff, seed.tickets[0])).toMatchObject({ hasCustomerOwner: false });
  expect(await get(bob)).toBeNull();
  await t.mutation(api.conversations.send, question);
  expect((await page(alice)).page).toHaveLength(1);
  expect((await page(bob)).page).toHaveLength(0);
});
