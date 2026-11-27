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

test("the outstanding question and its answer survive later staff updates", async () => {
  const { t, staff, alice, bob, id, question, page } = await fixture();
  const request = await t.mutation(api.conversations.send, question);
  await t.run(ctx => ctx.db.patch(request, { requestReply: undefined }));
  for (let index = 0; index < 12; index++) {
    await t.mutation(api.conversations.send, { ...question, body: "Staff update", requestId: `update-${index}`, requestReply: false });
  }
  expect((await page(alice)).page.every(row => row._id !== request)).toBe(true);
  expect(await t.query(api.conversations.openRequest, { token: alice, id })).toEqual({ _id: request, body: question.body });
  expect(await t.query(api.conversations.openRequest, { token: bob, id })).toBeNull();
  await t.mutation(api.conversations.send, { ...question, token: alice, body: "At checkout", requestId: "answer", inReplyTo: request });
  await t.mutation(api.conversations.send, { ...question, body: "Thanks", requestId: "thanks", requestReply: false });
  expect(await t.query(api.conversations.openRequest, { token: alice, id })).toBeNull();
  expect(await t.query(api.tickets.getTicket, { token: alice, id })).toMatchObject({
    status: "waiting", latestReply: { role: "staff", awaitingCustomer: false, answeredCustomerRequest: true },
  });
  const next = await t.mutation(api.conversations.send, { ...question, expectedVersion: 1, requestId: "next-question" });
  expect(await t.query(api.conversations.openRequest, { token: alice, id })).toMatchObject({ _id: next });
  expect((await t.query(api.tickets.getTicket, { token: alice, id }))?.latestReply?.answeredCustomerRequest).toBeUndefined();
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

test("evidence quotes reference same-Ticket active files, notes and video moments with replay and safe unavailability", async () => {
  const { t, seed, id, staff, alice, bob, page } = await fixture();
  const foreignId = seed.tickets[2]; // Bob's Ticket
  const photo = { key: "fake-ev-photo", name: "checkout-receipt.jpg", size: 1200, type: "image/jpeg", url: "https://fixture.invalid/receipt.jpg" };
  const video = { key: "fake-ev-video", name: "till-print.mp4", size: 6800, type: "video/mp4", url: "https://fixture.invalid/print.mp4" };
  const foreignFile = { key: "fake-ev-foreign", name: "bob-only.png", size: 500, type: "image/png", url: "https://fixture.invalid/bob.png" };

  await t.run(async ctx => {
    await ctx.db.patch(id, { media: [photo, video] });
    await ctx.db.patch(foreignId, { media: [foreignFile] });
  });
  const pointNote = await t.mutation(api.annotations.addAnnotation, {
    token: alice, id, expectedVersion: 0, mediaIndex: 0, kind: "point", x: 0.77, y: 0.44, text: "MEMBER -100 printed twice",
  });
  const videoMoment = await t.mutation(api.annotations.addAnnotation, {
    token: alice, id, expectedVersion: pointNote.version, mediaIndex: 1, kind: "time", x: 0.5, y: 0.5, time: 11, text: "Printer pauses here",
  });
  const foreignNote = await t.mutation(api.annotations.addAnnotation, {
    token: bob, id: foreignId, expectedVersion: 0, mediaIndex: 0, kind: "point", x: 0.2, y: 0.2, text: "Bob private note",
  });

  // Malformed or empty-body evidence messages are rejected.
  await expect(t.mutation(api.conversations.send, {
    token: alice, id, body: "   ", requestId: "ev-empty", expectedVersion: videoMoment.version,
    evidence: { kind: "media", mediaKey: photo.key },
  })).rejects.toThrow("INVALID_INPUT");
  await expect(t.mutation(api.conversations.send, {
    token: alice, id, body: "Bad key", requestId: "ev-bad-shape", expectedVersion: videoMoment.version,
    evidence: { kind: "media", mediaKey: " padded " },
  })).rejects.toThrow("INVALID_INPUT");

  // Cross-Ticket files, cross-Ticket notes and unauthorized actors are rejected.
  await expect(t.mutation(api.conversations.send, {
    token: alice, id, body: "Wrong file", requestId: "ev-foreign-file", expectedVersion: videoMoment.version,
    evidence: { kind: "media", mediaKey: foreignFile.key },
  })).rejects.toThrow("MEDIA_UNAVAILABLE");
  await expect(t.mutation(api.conversations.send, {
    token: alice, id, body: "Wrong note", requestId: "ev-foreign-note", expectedVersion: videoMoment.version,
    evidence: { kind: "annotation", annotationId: foreignNote.annotationId },
  })).rejects.toThrow("COMMENT_NOT_FOUND");
  await expect(t.mutation(api.conversations.send, {
    token: bob, id, body: "Intruder", requestId: "ev-bob", expectedVersion: videoMoment.version,
    evidence: { kind: "media", mediaKey: photo.key },
  })).rejects.toThrow("TICKET_UNAVAILABLE");

  // Authorized exact-file, photo note and saved video moment quotes succeed and replay consistently.
  const fileArgs = {
    token: alice, id, body: "See the full receipt", requestId: "ev-file-1", expectedVersion: videoMoment.version,
    evidence: { kind: "media" as const, mediaKey: photo.key },
  };
  const fileMsg = await t.mutation(api.conversations.send, fileArgs);
  expect(await t.mutation(api.conversations.send, fileArgs)).toBe(fileMsg);
  await expect(t.mutation(api.conversations.send, { ...fileArgs, evidence: { kind: "media", mediaKey: video.key } }))
    .rejects.toThrow("REQUEST_ID_CONFLICT");
  await expect(t.mutation(api.conversations.send, { ...fileArgs, evidence: undefined }))
    .rejects.toThrow("REQUEST_ID_CONFLICT");

  const noteArgs = {
    token: staff, id, body: "I see the duplicate discount line", requestId: "ev-note-1", expectedVersion: videoMoment.version,
    requestReply: false, evidence: { kind: "annotation" as const, annotationId: pointNote.annotationId },
  };
  const noteMsg = await t.mutation(api.conversations.send, noteArgs);
  const momentMsg = await t.mutation(api.conversations.send, {
    token: staff, id, body: "That pause is the template bug", requestId: "ev-moment-1", expectedVersion: videoMoment.version,
    requestReply: false, evidence: { kind: "annotation", annotationId: videoMoment.annotationId },
  });

  const byId = async (token: string) => Object.fromEntries((await page(token)).page.map(row => [row._id, row]));
  let view = await byId(alice);
  expect(view[fileMsg].evidence).toEqual({
    kind: "media", available: true, mediaKey: photo.key, mediaName: photo.name, mediaType: photo.type,
  });
  expect(view[noteMsg].evidence).toEqual({
    kind: "annotation", available: true, annotationId: pointNote.annotationId, annotationKind: "point",
    label: 1, mediaKey: photo.key, mediaName: photo.name, mediaType: photo.type, text: "MEMBER -100 printed twice",
  });
  expect(view[momentMsg].evidence).toEqual({
    kind: "annotation", available: true, annotationId: videoMoment.annotationId, annotationKind: "time",
    label: 2, time: 11, mediaKey: video.key, mediaName: video.name, mediaType: video.type, text: "Printer pauses here",
  });
  expect(await byId(staff)).toEqual(view);

  // Soft-deleting the origin note blocks new references, preserves idempotent replay, and redacts hydrated text safely.
  const removed = await t.mutation(api.annotations.removeAnnotation, {
    token: alice, id, expectedVersion: videoMoment.version, annotationId: pointNote.annotationId,
  });
  await expect(t.mutation(api.conversations.send, {
    token: staff, id, body: "Late reference", requestId: "ev-note-deleted", expectedVersion: removed.version,
    requestReply: false, evidence: { kind: "annotation", annotationId: pointNote.annotationId },
  })).rejects.toThrow("COMMENT_NOT_FOUND");
  expect(await t.mutation(api.conversations.send, noteArgs)).toBe(noteMsg);

  view = await byId(alice);
  expect(view[noteMsg].evidence).toEqual({ kind: "annotation", available: false });
  expect(JSON.stringify(view[noteMsg])).not.toContain("MEMBER -100 printed twice");

  // Restoring the note restores live evidence hydration.
  await t.mutation(api.annotations.restoreAnnotation, {
    token: staff, id, expectedVersion: removed.version, annotationId: pointNote.annotationId,
  });
  view = await byId(alice);
  expect(view[noteMsg].evidence).toMatchObject({ kind: "annotation", available: true, annotationId: pointNote.annotationId });

  // Removing a file from the Ticket ledger renders both file and dependent note evidence safely unavailable.
  await t.run(ctx => ctx.db.patch(id, { media: [] }));
  view = await byId(alice);
  expect(view[fileMsg].evidence).toEqual({ kind: "media", available: false });
  expect(view[noteMsg].evidence).toEqual({ kind: "annotation", available: false });
  expect(JSON.stringify(view)).not.toMatch(/checkout-receipt\.jpg|fake-ev-photo|MEMBER -100 printed twice/);
});

test("Ticket purge retention deletes conversation messages containing evidence references", async () => {
  const { t, id, alice, staff } = await fixture();
  vi.stubEnv("UPLOAD_CALLBACK_SECRET", "fake-callback-secret");
  vi.stubEnv("MEDIA_CLEANUP_ENABLED", "true");
  const photo = { key: "fake-purge-ev", name: "purge-receipt.png", size: 1, type: "image/png", url: "https://fixture.invalid/purge.png" };
  const intent = await t.mutation(api.uploads.createUploadIntent, {
    token: alice, idempotencyKey: "purge-evidence-upload", files: [{ name: photo.name, size: photo.size, type: photo.type }],
  });
  await t.mutation(api.uploads.recordUploadedFile, {
    intentId: intent.intentId, secret: intent.secret, file: photo, callbackToken: "fake-callback-secret",
  });
  const attachMsg = await t.mutation(api.conversations.send, {
    token: alice, id, body: "Receipt attached", requestId: "purge-ev-1", expectedVersion: 0,
    media: [photo], uploadIntentId: intent.intentId, uploadIntentSecret: intent.secret,
  });
  const note = await t.mutation(api.annotations.addAnnotation, {
    token: alice, id, expectedVersion: 1, mediaIndex: 0, kind: "point", x: 0.3, y: 0.3, text: "Check line item",
  });
  const citeMsg = await t.mutation(api.conversations.send, {
    token: staff, id, body: "Checking this note", requestId: "purge-ev-2", expectedVersion: note.version,
    requestReply: false, evidence: { kind: "annotation", annotationId: note.annotationId },
  });
  await t.mutation(api.tickets.archiveTicket, { token: staff, id, expectedVersion: note.version });
  await t.run(ctx => ctx.db.patch(id, { archivedAt: Date.now() - 31 * 24 * 60 * 60 * 1000 }));
  expect(await t.mutation(internal.retention.claimPurges, {})).toBe(1);
  const job = await t.run(ctx => ctx.db.query("mediaJobs").withIndex("by_scope", q => q.eq("resourceScope", `ticket:${id}`)).unique());
  expect(job).toBeTruthy();
  const claimed = await t.mutation(internal.retention.claim, { jobId: job!._id });
  expect(claimed?.leaseId).toBeTruthy();
  const fence = { jobId: job!._id, attempt: claimed!.attempt, leaseId: claimed!.leaseId! };
  expect(await t.mutation(internal.retention.checkpoint, { ...fence, key: photo.key, outcome: "deleted" })).toBe(true);
  // Advance through delete_media -> delete_ticket -> delete_events -> complete.
  for (let step = 0; step < 4; step++) await t.mutation(internal.retention.advance, fence);
  expect(await t.run(ctx => ctx.db.get(attachMsg))).toBeNull();
  expect(await t.run(ctx => ctx.db.get(citeMsg))).toBeNull();
  expect(await t.run(ctx => ctx.db.get(id))).toBeNull();
});
