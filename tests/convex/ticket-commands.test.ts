import { fixtures, identityTest, whoami } from "./identity-harness";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import schema from "../../convex/schema";
import { MEDIA_POLICY, ticketRequestFingerprintInput } from "../../shared/ticket-contracts";
import { modules } from "./modules";

beforeEach(() => {
  vi.stubEnv("LOCAL_FIXTURES_ENABLED", "true");
  vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3212");
  vi.stubEnv("UPLOAD_CALLBACK_SECRET", "fake-callback-secret");
});
afterEach(() => vi.unstubAllEnvs());

async function fixture() {
  const t = identityTest({ ...modules, "../../convex/receiptFixture.ts": () => import("./fixtures/receipts") });
  const seed = await t.mutation(internal.seed.install, {});
  const [staff, alice, bob] = seed.sessions;
  const create = { token: alice, projectKey: "POS", requestId: "original-create", title: "  Original Ticket  ", description: "  Original description  " };
  async function snapshot() {
    return await t.run(async ctx => ({
      tickets: await ctx.db.query("tickets").collect(), events: await ctx.db.query("ticketEvents").collect(),
      annotations: await ctx.db.query("annotationEvents").collect(), totals: await ctx.db.query("ticketTotals").collect(),
      counters: await ctx.db.query("ticketCounters").collect(), receipts: await ctx.db.query("ticketRequests").collect(),
    }));
  }
  async function mediaInput(requestId = "media-create-request", token = alice) {
    const media = [{ key: `fake-${requestId}`, name: "fixture.png", size: 1, type: "image/png", url: "https://fixture.invalid/image.png" }];
    const intent = await t.mutation(api.uploads.createUploadIntent, { token, idempotencyKey: requestId, files: media.map(({ name, size, type }) => ({ name, size, type })) });
    await t.mutation(api.uploads.recordUploadedFile, {
      intentId: intent.intentId, secret: intent.secret, file: media[0], callbackToken: "fake-callback-secret",
    });
    return { token, projectId: seed.projects[0].id, requestId, title: "Media Ticket", description: "", media, uploadIntentId: intent.intentId, uploadIntentSecret: intent.secret };
  }
  return { t, seed, staff, alice, bob, create, snapshot, mediaInput };
}

test("stale and unauthorized commands leave row, audit, totals, numbering and receipts unchanged", async () => {
  const { t, seed, staff, alice, bob, snapshot } = await fixture();
  const id = seed.tickets[1];
  const before = await snapshot();
  await expect(t.mutation(api.tickets.updateTicketStatus, { token: staff, id, expectedVersion: 9, status: "done" }))
    .rejects.toMatchObject({ data: { code: "VERSION_CONFLICT" } });
  await expect(t.mutation(api.tickets.editTicket, { token: bob, id, expectedVersion: 0, title: "Forbidden", description: "" }))
    .rejects.toMatchObject({ data: { code: "TICKET_UNAVAILABLE" } });
  await expect(t.mutation(api.tickets.updateTicketStatus, { token: alice, id, expectedVersion: 0, status: "done" }))
    .rejects.toMatchObject({ data: { code: "STAFF_ONLY" } });
  expect(await snapshot()).toEqual(before);
});

test("successful commands keep versioned audit, workflow totals and archive removal consistent", async () => {
  const { t, seed, staff, alice } = await fixture();
  const id = seed.tickets[1];
  const status = await t.mutation(api.tickets.updateTicketStatus, { token: staff, id, expectedVersion: 0, status: "done" });
  const state = await t.run(async ctx => ({ row: await ctx.db.get(id), event: await ctx.db.get(status.eventId!), totals: await ctx.db.query("ticketTotals").collect() }));
  expect(state.row).toMatchObject({ version: 1, status: "done" });
  expect(state.event).toMatchObject({ before: { version: 0, status: "new" }, after: { version: 1, status: "done" } });
  expect(state.totals.map(({ status, count }) => ({ status, count }))).toEqual([{ status: "new", count: 2 }, { status: "done", count: 1 }]);
  await t.mutation(api.tickets.archiveTicket, { token: alice, id, expectedVersion: 1 });
  expect(await t.run(ctx => ctx.db.query("ticketTotals").collect())).toMatchObject([{ count: 2 }, { count: 0 }]);
  const restored = await t.mutation(api.tickets.restoreTicket, { token: staff, id, expectedVersion: 2 });
  const row = await t.query(api.tickets.getTicket, { token: alice, id });
  expect(row).toMatchObject({ lifecycle: "active", version: 3, status: "done" });
  expect(row).not.toHaveProperty("archivedAt");
  const event = await t.run(ctx => ctx.db.get(restored.eventId));
  expect(event?.before?.archivedAt).toBeTypeOf("number");
  expect(event?.after).not.toHaveProperty("archivedAt");
  expect(await t.run(ctx => ctx.db.query("ticketTotals").collect())).toMatchObject([{ count: 2 }, { count: 1 }]);
});

test("create → edit → original retry uses an immutable SHA-256 receipt across sessions", async () => {
  const { t, create, alice, seed, snapshot } = await fixture();
  const first = await t.mutation(api.tickets.createTextTicket, create);
  const receipt = (await snapshot()).receipts.find(r => r.requestId === create.requestId)!;
  const actor = (await whoami(t, alice));
  const canonical = ticketRequestFingerprintInput({ ...create, actor: { role: "customer", customerId: actor.customerId! }, projectId: seed.projects[0].id });
  const expected = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  expect(receipt).toMatchObject({ operation: "ticket.create", digestVersion: 1, outcome: "committed", ticketId: first.ticket._id, version: 0 });
  expect(receipt.inputDigest).toBe(Array.from(new Uint8Array(expected), b => b.toString(16).padStart(2, "0")).join(""));
  expect(JSON.stringify(receipt)).not.toMatch(/Original|sessionId|token|title|description/);
  await t.mutation(api.tickets.editTicket, { token: alice, id: first.ticket._id, title: "Edited", description: "Changed", expectedVersion: 0 });
  const newAliceSession = await t.mutation(fixtures.session, { customerId: actor.customerId! });
  const before = await snapshot();
  const replay = await t.mutation(api.tickets.createTextTicket, { ...create, token: newAliceSession, title: "Original Ticket", description: "Original description" });
  expect(replay).toMatchObject({ created: false, ticket: { _id: first.ticket._id, title: "Edited", version: 1 } });
  expect(await snapshot()).toEqual(before);
  expect(before.receipts.find(r => r._id === receipt._id)).toEqual(receipt);
});

test("simultaneous identical requests allocate one Ticket, number, audit and total", async () => {
  const { t, create, snapshot } = await fixture();
  const before = await snapshot();
  const results = await Promise.all(Array.from({ length: 8 }, () => t.mutation(api.tickets.createTextTicket, create)));
  expect(results.filter(r => r.created)).toHaveLength(1);
  expect(new Set(results.map(r => r.ticket._id)).size).toBe(1);
  const after = await snapshot();
  expect(after.tickets).toHaveLength(before.tickets.length + 1);
  expect(after.events).toHaveLength(before.events.length + 1);
  expect(after.receipts).toHaveLength(before.receipts.length + 1);
  expect(after.counters[0].nextNumber).toBe(before.counters[0].nextNumber + 1);
  expect(after.totals[0].count).toBe(before.totals[0].count + 1);
});

test("different content or Project under the same operation/requestId conflicts without writes", async () => {
  const { t, staff, create, snapshot } = await fixture();
  const input = { ...create, token: staff };
  await t.mutation(api.tickets.createTextTicket, input);
  const before = await snapshot();
  for (const changed of [{ title: "Other" }, { description: "Other" }, { projectKey: "APP" }]) {
    await expect(t.mutation(api.tickets.createTextTicket, { ...input, ...changed }))
      .rejects.toMatchObject({ data: { code: "REQUEST_ID_CONFLICT" } });
  }
  expect(await snapshot()).toEqual(before);
});

test("archived Projects reject creation and replay without writes", async () => {
  const { t, create, staff, seed, snapshot } = await fixture();
  const input = { ...create, token: staff };
  await t.mutation(api.tickets.createTextTicket, input);
  await t.run(ctx => ctx.db.patch(seed.projects[0].id, { archivedAt: Date.now() }));
  const before = await snapshot();
  await expect(t.mutation(api.tickets.createTextTicket, input)).rejects.toThrow("PROJECT_NOT_FOUND");
  await expect(t.mutation(api.tickets.createTextTicket, { ...input, requestId: "new-request" })).rejects.toThrow("PROJECT_NOT_FOUND");
  expect(await snapshot()).toEqual(before);
});

test("concurrent different-Project requests conflict rather than partitioning the duplicate index", async () => {
  const { t, staff, create, snapshot } = await fixture();
  const before = await snapshot();
  const results = await Promise.allSettled(["POS", "APP"].map(projectKey => t.mutation(api.tickets.createTextTicket, { ...create, token: staff, projectKey })));
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { data: { code: "REQUEST_ID_CONFLICT" } } });
  expect((await snapshot()).tickets).toHaveLength(before.tickets.length + 1);
});

test("replay checks durable actor, current membership and Ticket access before revealing a result or conflict", async () => {
  const { t, staff, alice, bob, create, snapshot } = await fixture();
  const own = await t.mutation(api.tickets.createTextTicket, create);
  const before = await snapshot();
  for (const token of [staff, bob]) {
    for (const title of [create.title, "Different"]) {
      await expect(t.mutation(api.tickets.createTextTicket, { ...create, token, title }))
        .rejects.toMatchObject({ data: { code: "TICKET_UNAVAILABLE" } });
    }
  }
  expect(await snapshot()).toEqual(before);
  await t.run(async ctx => {
    for (const membership of await ctx.db.query("projectMembers").collect()) await ctx.db.delete(membership._id);
  });
  await expect(t.mutation(api.tickets.createTextTicket, create)).rejects.toMatchObject({ data: { code: "PROJECT_NOT_FOUND" } });
  expect(await t.query(api.tickets.getTicket, { token: alice, id: own.ticket._id })).toBeNull();
});

test("rejected requests reserve no receipt and corrected input or newly granted access can proceed", async () => {
  const { t, alice, create, seed, snapshot } = await fixture();
  const before = await snapshot();
  await expect(t.mutation(api.tickets.createTextTicket, { ...create, title: " " })).rejects.toThrow("REQUIRED_TICKET");
  await expect(t.mutation(api.tickets.createTextTicket, { ...create, projectKey: "APP" })).rejects.toThrow("PROJECT_NOT_FOUND");
  expect(await snapshot()).toEqual(before);
  const session = (await whoami(t, alice));
  await t.run(ctx => ctx.db.insert("projectMembers", { projectId: seed.projects[1].id, customerId: session.customerId!, createdAt: Date.now() }));
  expect(await t.mutation(api.tickets.createTextTicket, { ...create, projectKey: "APP" })).toMatchObject({ created: true, ticket: { ticketNumber: 1, projectKey: "APP" } });
});

test("browser create replay checks original annotations and media after editing, without a session-bound identity", async () => {
  const { t, mediaInput, alice, staff, snapshot } = await fixture();
  const input = { ...await mediaInput(), annotations: [{ mediaIndex: 0, kind: "point" as const, x: 0.2, y: 0.3, text: "  Here  " }] };
  const id = await t.mutation(api.tickets.createTicket, input);
  await t.mutation(api.tickets.editTicket, { token: alice, id, title: "Edited later", description: "", expectedVersion: 0 });
  const session = (await whoami(t, alice));
  const freshBrowserSession = await t.mutation(fixtures.session, { customerId: session.customerId! });
  const before = await snapshot();
  expect(await t.mutation(api.tickets.createTicket, { ...input, token: freshBrowserSession })).toBe(id);
  for (const changed of [
    { annotations: [{ ...input.annotations[0], text: "Different note" }] },
    { media: [{ ...input.media[0], key: "different-key" }] },
  ]) await expect(t.mutation(api.tickets.createTicket, { ...input, ...changed })).rejects.toThrow("REQUEST_ID_CONFLICT");
  await expect(t.mutation(api.tickets.createTicket, { ...input, token: staff })).rejects.toThrow("TICKET_UNAVAILABLE");
  expect(await snapshot()).toEqual(before);
});

test("annotation commands share Ticket versions and audit; stale annotation writes roll back", async () => {
  const { t, mediaInput, alice, snapshot } = await fixture();
  const id = await t.mutation(api.tickets.createTicket, await mediaInput());
  const { annotationId } = await t.mutation(api.annotations.addAnnotation, { token: alice, id, expectedVersion: 0, mediaIndex: 0, kind: "point", x: 0, y: 0, text: "Initial" });
  const updated = await t.mutation(api.annotations.updateAnnotation, { token: alice, id, annotationId, text: "Updated", expectedVersion: 1 });
  expect(updated.version).toBe(2);
  const before = await snapshot();
  await expect(t.mutation(api.annotations.removeAnnotation, { token: alice, id, annotationId, expectedVersion: 1 })).rejects.toThrow("VERSION_CONFLICT");
  expect(await snapshot()).toEqual(before);
  await t.mutation(api.annotations.undoAnnotationUpdate, { token: alice, eventId: updated.eventId, expectedVersion: 2 });
  await t.mutation(api.annotations.removeAnnotation, { token: alice, id, annotationId, expectedVersion: 3 });
  await t.mutation(api.annotations.restoreAnnotation, { token: alice, id, annotationId, expectedVersion: 4 });
  const after = await snapshot();
  expect(after.tickets.find(row => row._id === id)).toMatchObject({ version: 5, annotations: [{ text: "Initial" }] });
  expect(after.tickets.find(row => row._id === id)?.annotations[0]).not.toHaveProperty("deletedAt");
  const events = after.events.filter(event => event.ticketId === id);
  expect(events.map(event => event.after?.version)).toEqual([0, 1, 2, 3, 4, 5]);
  expect(events.slice(1).every(event => event.action === "annotation_changed")).toBe(true);
  expect(after.annotations.filter(event => event.ticketId === id)).toHaveLength(5);
  expect(after.totals).toEqual(before.totals);
});

test("annotation delete then undo and add then remove-via-undo use returned versions", async () => {
  const { t, mediaInput, alice } = await fixture();
  const point = { mediaIndex: 0, kind: "point" as const, x: 0, y: 0, text: "Initial" };
  const id = await t.mutation(api.tickets.createTicket, { ...await mediaInput(), annotations: [point] });
  const row = (await t.query(api.tickets.getTicket, { token: alice, id }))!;
  const annotationId = row.annotations[0].id;
  const removed = await t.mutation(api.annotations.removeAnnotation, { token: alice, id, annotationId, expectedVersion: row.version });
  expect(removed).toEqual({ version: 1 });
  const restored = await t.mutation(api.annotations.restoreAnnotation, { token: alice, id, annotationId, expectedVersion: removed.version });
  expect(restored).toEqual({ version: 2 });
  const added = await t.mutation(api.annotations.addAnnotation, { token: alice, id, ...point, expectedVersion: restored.version });
  expect(added.version).toBe(3);
  const undone = await t.mutation(api.annotations.removeAnnotation, { token: alice, id, annotationId: added.annotationId, expectedVersion: added.version });
  const final = (await t.query(api.tickets.getTicket, { token: alice, id }))!;
  expect(final.version).toBe(undone.version);
  expect(final.annotations.filter(annotation => annotation.deletedAt === undefined).map(annotation => annotation.id)).toEqual([annotationId]);
});

test("customer create replays cannot distinguish non-member, missing or archived Projects", async () => {
  const { t, create, alice, seed, snapshot, mediaInput } = await fixture();
  await t.mutation(api.tickets.createTextTicket, create);
  const media = await mediaInput();
  await t.mutation(api.tickets.createTicket, media);
  const missingId = await t.run(async ctx => {
    const id = await ctx.db.insert("projects", { key: "MISSING", name: "Missing", createdAt: Date.now(), updatedAt: Date.now() });
    await ctx.db.delete(id);
    await ctx.db.patch(seed.projects[0].id, { archivedAt: Date.now() });
    return id;
  });
  const before = await snapshot();
  for (const [projectKey, projectId] of [["APP", seed.projects[1].id], ["MISSING", missingId], ["POS", seed.projects[0].id]] as const) {
    for (const title of [create.title, "Different"]) {
      await expect(t.mutation(api.tickets.createTextTicket, { ...create, projectKey, title }))
        .rejects.toMatchObject({ data: { code: "PROJECT_NOT_FOUND" } });
      await expect(t.mutation(api.tickets.createTicket, { ...media, token: alice, projectId, title }))
        .rejects.toMatchObject({ data: { code: "PROJECT_NOT_FOUND" } });
    }
  }
  expect(await snapshot()).toEqual(before);
});

test("attached intents preserve original display order when upload callbacks arrive out of order", async () => {
  const { t, alice, seed } = await fixture();
  const media = ["first", "second"].map(name => ({ key: `fake-${name}`, name: `${name}.png`, size: 1, type: "image/png", url: `https://fixture.invalid/${name}.png` }));
  const intent = await t.mutation(api.uploads.createUploadIntent, { token: alice, idempotencyKey: "ordered-media-request", files: media.map(({ name, size, type }) => ({ name, size, type })) });
  for (const file of [...media].reverse()) await t.mutation(api.uploads.recordUploadedFile, {
    intentId: intent.intentId, secret: intent.secret, file, callbackToken: "fake-callback-secret",
  });
  const input = { token: alice, projectId: seed.projects[0].id, requestId: "ordered-media-request", title: "Ordered media", description: "", media, uploadIntentId: intent.intentId, uploadIntentSecret: intent.secret };
  const id = await t.mutation(api.tickets.createTicket, input);
  const attached = await t.mutation(api.uploads.createUploadIntent, { token: alice, idempotencyKey: input.requestId, files: media.map(({ name, size, type }) => ({ name, size, type })) });
  expect(attached.uploadedFiles).toEqual(media);
  expect(await t.mutation(api.tickets.createTicket, { ...input, media: attached.uploadedFiles })).toBe(id);
  await expect(t.mutation(api.tickets.createTicket, { ...input, media: [...media].reverse() })).rejects.toThrow("REQUEST_ID_CONFLICT");
});

test("media attachment receipts replay the committed version and event after edits and reject altered targets", async () => {
  const { t, mediaInput, staff, seed, snapshot } = await fixture();
  const media = await mediaInput("attachment-request-id", staff);
  const created = await t.mutation(api.tickets.createTextTicket, { token: staff, projectKey: "POS", title: "Attachment Ticket", description: "", requestId: media.requestId });
  const input = { token: staff, id: created.ticket._id, media: media.media, requestId: media.requestId, uploadIntentId: media.uploadIntentId, uploadIntentSecret: media.uploadIntentSecret, expectedVersion: 0 };
  const results = await Promise.all([t.mutation(api.tickets.attachTicketMedia, input), t.mutation(api.tickets.attachTicketMedia, input)]);
  expect(results[0]).toEqual(results[1]);
  expect(results[0].version).toBe(1);
  await t.mutation(api.tickets.editTicket, { token: staff, id: input.id, title: "Later edit", description: "", expectedVersion: 1 });
  const freshStaffSession = await t.mutation(fixtures.session, { staffId: (await whoami(t, staff)).staffId });
  const before = await snapshot();
  expect(await t.mutation(api.tickets.attachTicketMedia, { ...input, token: freshStaffSession })).toEqual(results[0]);
  for (const changed of [{ id: seed.tickets[0] }, { media: [{ ...media.media[0], key: "different-key" }] }]) {
    await expect(t.mutation(api.tickets.attachTicketMedia, { ...input, ...changed })).rejects.toThrow("REQUEST_ID_CONFLICT");
  }
  expect(await snapshot()).toEqual(before);
  expect(before.receipts.filter(r => r.requestId === input.requestId).map(r => r.operation).sort()).toEqual(["ticket.attach_media", "ticket.create"]);
  expect(before.tickets.find(row => row._id === input.id)).toMatchObject({ version: 2, media: media.media });
});

test("a rejected stale attachment leaves no receipt and can commit with its corrected version", async () => {
  const { t, mediaInput, staff, seed, snapshot } = await fixture();
  const media = await mediaInput("correctable-attachment", staff);
  const input = { token: staff, id: seed.tickets[0], media: media.media, requestId: media.requestId, uploadIntentId: media.uploadIntentId, uploadIntentSecret: media.uploadIntentSecret, expectedVersion: 9 };
  const before = await snapshot();
  await expect(t.mutation(api.tickets.attachTicketMedia, input)).rejects.toThrow("VERSION_CONFLICT");
  expect(await snapshot()).toEqual(before);
  expect(await t.run(ctx => ctx.db.get(media.uploadIntentId))).toMatchObject({ status: "pending" });
  expect(await t.mutation(api.tickets.attachTicketMedia, { ...input, expectedVersion: 0 })).toMatchObject({ version: 1 });
});

test("initial and later annotation count limits include soft-deleted entries", async () => {
  const { t, mediaInput, alice, snapshot } = await fixture();
  const point = { mediaIndex: 0, kind: "point" as const, x: 0, y: 0, text: "Note" };
  const input = await mediaInput();
  const before = await snapshot();
  await expect(t.mutation(api.tickets.createTicket, { ...input, annotations: Array.from({ length: MEDIA_POLICY.maxAnnotationCount + 1 }, () => point) }))
    .rejects.toThrow("ANNOTATION_LIMIT_EXCEEDED");
  expect(await snapshot()).toEqual(before);
  const id = await t.mutation(api.tickets.createTicket, { ...input, annotations: Array.from({ length: MEDIA_POLICY.maxAnnotationCount }, () => point) });
  const row = (await t.query(api.tickets.getTicket, { token: alice, id }))!;
  await t.mutation(api.annotations.removeAnnotation, { token: alice, id, annotationId: row.annotations[0].id, expectedVersion: 0 });
  const full = await snapshot();
  await expect(t.mutation(api.annotations.addAnnotation, { ...point, token: alice, id, expectedVersion: 1 })).rejects.toThrow("ANNOTATION_LIMIT_EXCEEDED");
  expect(await snapshot()).toEqual(full);
});

test("initial, added and edited annotation text budgets include soft-deleted text", async () => {
  const { t, mediaInput, alice, snapshot } = await fixture();
  const point = { mediaIndex: 0, kind: "point" as const, x: 0, y: 0, text: "x".repeat(MEDIA_POLICY.maxAnnotationTextLength) };
  const count = MEDIA_POLICY.maxAnnotationTotalTextLength / MEDIA_POLICY.maxAnnotationTextLength;
  const input = await mediaInput();
  const before = await snapshot();
  await expect(t.mutation(api.tickets.createTicket, { ...input, annotations: Array.from({ length: count + 1 }, () => point) }))
    .rejects.toThrow("ANNOTATION_LIMIT_EXCEEDED");
  expect(await snapshot()).toEqual(before);
  const id = await t.mutation(api.tickets.createTicket, { ...input, annotations: Array.from({ length: count }, () => point) });
  const row = (await t.query(api.tickets.getTicket, { token: alice, id }))!;
  await t.mutation(api.annotations.removeAnnotation, { token: alice, id, annotationId: row.annotations[0].id, expectedVersion: 0 });
  const full = await snapshot();
  await expect(t.mutation(api.annotations.addAnnotation, { ...point, text: "a", token: alice, id, expectedVersion: 1 })).rejects.toThrow("ANNOTATION_LIMIT_EXCEEDED");
  expect(await snapshot()).toEqual(full);
  await t.mutation(api.annotations.updateAnnotation, { token: alice, id, annotationId: row.annotations[1].id, text: "x", expectedVersion: 1 });
  const { annotationId } = await t.mutation(api.annotations.addAnnotation, { ...point, text: "a", token: alice, id, expectedVersion: 2 });
  const atLimit = await snapshot();
  await expect(t.mutation(api.annotations.updateAnnotation, { token: alice, id, annotationId, text: point.text, expectedVersion: 3 })).rejects.toThrow("ANNOTATION_LIMIT_EXCEEDED");
  expect(await snapshot()).toEqual(atLimit);
});

test("purge leaves an unavailable content-free tombstone and never decrements archived totals twice", async () => {
  const { t, create, staff, snapshot, mediaInput } = await fixture();
  const input = { ...create, token: staff };
  const created = await t.mutation(api.tickets.createTextTicket, input);
  const id = created.ticket._id;
  const media = await mediaInput("purged-attachment-request", staff);
  const attachment = { token: staff, id, media: media.media, requestId: media.requestId, uploadIntentId: media.uploadIntentId, uploadIntentSecret: media.uploadIntentSecret, expectedVersion: 0 };
  await t.mutation(api.tickets.attachTicketMedia, attachment);
  await t.mutation(api.tickets.archiveTicket, { token: staff, id, expectedVersion: 1 });
  const before = await snapshot();
  const staffSession = await t.run(ctx => ctx.db.query("sessionAdmissions").withIndex("by_auth_session", q => q.eq("authSessionId", staff)).unique());
  const purge = makeFunctionReference<"mutation", { id: Id<"tickets">; sessionId: Id<"sessionAdmissions"> }>("receiptFixture:purge");
  await t.mutation(purge, { id, sessionId: staffSession!._id });
  const after = await snapshot();
  expect(after.tickets.some(row => row._id === id)).toBe(false);
  expect(after.totals).toEqual(before.totals);
  const oldReceipt = before.receipts.find(r => r.requestId === create.requestId)!;
  const tombstone = after.receipts.find(r => r.requestId === create.requestId)!;
  expect(tombstone).toEqual({ ...oldReceipt, outcome: "unavailable" });
  expect(after.receipts.filter(r => r.ticketId === id)).toHaveLength(2);
  expect(after.receipts.filter(r => r.ticketId === id).every(r => r.outcome === "unavailable")).toBe(true);
  expect(JSON.stringify(tombstone)).not.toMatch(/Original|title|description|media|annotations|sessionId/);
  await expect(t.mutation(api.tickets.createTextTicket, input)).rejects.toMatchObject({ data: { code: "TICKET_UNAVAILABLE" } });
  await expect(t.mutation(api.tickets.createTextTicket, { ...input, title: "Different after purge" })).rejects.toMatchObject({ data: { code: "REQUEST_ID_CONFLICT" } });
  await expect(t.mutation(api.tickets.attachTicketMedia, attachment)).rejects.toMatchObject({ data: { code: "TICKET_UNAVAILABLE" } });
  expect(await snapshot()).toEqual(after);
});

test("customer create retries follow current archived Ticket visibility", async () => {
  const { t, create, staff } = await fixture();
  const result = await t.mutation(api.tickets.createTextTicket, create);
  const id = result.ticket._id;
  await t.mutation(api.tickets.archiveTicket, { token: staff, id, expectedVersion: result.ticket.version });
  await expect(t.mutation(api.tickets.createTextTicket, create)).rejects.toThrow("TICKET_UNAVAILABLE");
  const archived = await t.run(ctx => ctx.db.get(id));
  await t.mutation(api.tickets.restoreTicket, { token: staff, id, expectedVersion: archived!.version });
  expect(await t.mutation(api.tickets.createTextTicket, create)).toMatchObject({ created: false, ticket: { _id: id } });
});
