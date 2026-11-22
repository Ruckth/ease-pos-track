import { fixtures, identityTest, whoami } from "./identity-harness";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import schema from "../../convex/schema";
import { modules } from "./modules";

beforeEach(() => { vi.stubEnv("LOCAL_FIXTURES_ENABLED", "true"); vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3212"); vi.stubEnv("MEDIA_CLEANUP_ENABLED", "true"); });
afterEach(() => vi.unstubAllEnvs());

async function fixture() {
  const t = identityTest(modules);
  const seed = await t.mutation(internal.seed.install, {});
  return { t, seed, staff: seed.sessions[0], alice: seed.sessions[1], bob: seed.sessions[2] };
}

test("entry policies resolve explicit roles and reject missing, expired and forged credentials", async () => {
  const { t, staff, alice, seed } = await fixture();
  // A core session that was signed out no longer resolves, even with its admission row.
  const expired = await t.mutation(fixtures.session, { staffId: (await t.run(ctx => ctx.db.query("staff").first()))!._id });
  await t.run(async ctx => {
    const admission = (await ctx.db.query("sessionAdmissions").withIndex("by_auth_session", q => q.eq("authSessionId", expired)).unique())!;
    await ctx.db.patch(admission._id, { revokedAt: Date.now() });
  });
  for (const token of ["unknown", expired]) {
    await expect(t.query(api.projects.listProjects, { token })).rejects.toThrow("SESSION_EXPIRED");
  }
  await expect(t.query(api.tickets.laneTotals, { token: alice, projectId: seed.projects[0].id })).rejects.toThrow("STAFF_ONLY");
  await expect(t.mutation(api.tickets.createTextTicket, {
    token: alice, projectKey: "POS", requestId: "forged", title: "Forged", description: "",
    ownerCustomerId: "somebody", role: "staff",
  } as never)).rejects.toThrow("Unexpected field `ownerCustomerId`");
  const staffTicket = await t.mutation(api.tickets.createTextTicket, {
    token: staff, projectKey: "APP", requestId: "staff-app", title: "Global staff", description: "",
  });
  expect(staffTicket.ticket).not.toHaveProperty("ownerCustomerId");
  expect((await t.run(ctx => ctx.db.get(staffTicket.ticket._id)))?.ownerCustomerId).toBeUndefined();
  expect(staffTicket.ticket.origin).toBe("staff");
});

test("registered sign-in creates explicit roles from named staff identity or durable customer identity", async () => {
  const t = identityTest(modules);
  await t.action(internal.seed.run, {});
  const staff = await t.mutation(api.auth.signInLocalFixture, { email: "owner@local.test" });
  const customer = await t.action(api.auth.signInWithPassword, { username: "Alice", password: "local customer passphrase" });
  expect(staff.status).toBe("complete");
  expect(customer.status).toBe("complete");
  const subject = (bundle: typeof staff) => JSON.parse(atob(bundle.status === "complete" ? bundle.tokens.accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/") : "")).sub as string;
  expect(await t.query(api.identity.viewer, { token: subject(staff) })).toMatchObject({ kind: "staff", role: "owner" });
  const account = await t.query(api.identity.viewer, { token: subject(customer) });
  expect(account).toMatchObject({ kind: "customer", username: "alice" });
  expect(account?.kind === "customer" && account.customerId).toBeTruthy();
  expect(await t.action(api.auth.signInWithPassword, { username: "alice", password: "wrong customer passphrase" }))
    .toEqual({ status: "error", userError: { error: "INVALID_CREDENTIALS" } });
  expect(await t.action(api.auth.signInWithPassword, { username: "nobody", password: "local customer passphrase" }))
    .toEqual({ status: "error", userError: { error: "INVALID_CREDENTIALS" } });
  await expect(t.mutation(api.auth.signInLocalFixture, { email: "alice@local.test" })).resolves.toMatchObject({ status: "error" });
}, 30_000);

test("local seed is disabled without explicit fixture opt-in", async () => {
  vi.stubEnv("LOCAL_FIXTURES_ENABLED", "");
  const t = identityTest(modules);
  await expect(t.mutation(internal.seed.install, {})).rejects.toThrow("LOCAL_FIXTURES_DISABLED");
  expect(await t.run(ctx => ctx.db.query("projects").collect())).toEqual([]);
});

test("domain Project membership and Ticket ownership remain independent of entry policy", async () => {
  const { t, seed, alice, bob, staff } = await fixture();
  await expect(t.mutation(api.tickets.createTextTicket, {
    token: alice, projectKey: "APP", requestId: "foreign-project", title: "Denied", description: "",
  })).rejects.toThrow("PROJECT_NOT_FOUND");
  await expect(t.mutation(api.tickets.createTextTicket, {
    token: staff, requestId: "ambiguous-project", title: "Denied", description: "",
  })).rejects.toThrow("PROJECT_REQUIRED");
  const id = seed.tickets[1];
  expect(await t.query(api.tickets.getTicket, { token: bob, id })).toBeNull();
  expect(await t.query(api.tickets.listTicketActivity, { token: bob, id })).toEqual([]);
  await expect(t.mutation(api.tickets.editTicket, {
    token: bob, id, title: "Takeover", description: "", expectedVersion: 0,
  })).rejects.toThrow("TICKET_UNAVAILABLE");
  await expect(t.mutation(api.tickets.archiveTicket, { token: bob, id, expectedVersion: 0 }))
    .rejects.toThrow("TICKET_UNAVAILABLE");
  await t.run(async ctx => {
    const memberships = await ctx.db.query("projectMembers").collect();
    for (const row of memberships) await ctx.db.delete(row._id);
  });
  // Current membership is required even for the customer's own Ticket.
  expect(await t.query(api.tickets.getTicket, { token: alice, id } )).toBeNull();
  await expect(t.query(api.tickets.pageTickets, { token: alice, projectId: seed.projects[0].id, lifecycle: "active", paginationOpts: { numItems: 50, cursor: null } })).rejects.toThrow("PROJECT_NOT_FOUND");
  expect(await t.query(api.tickets.listTicketActivity, { token: alice, id })).toEqual([]);
  expect(await t.query(api.annotations.listAnnotationActivity, { token: alice, id })).toEqual([]);
  await expect(t.mutation(api.tickets.editTicket, { token: alice, id, title: "Denied", description: "", expectedVersion: 0 }))
    .rejects.toMatchObject({ data: { code: "TICKET_UNAVAILABLE" } });
  await expect(t.mutation(api.tickets.archiveTicket, { token: alice, id, expectedVersion: 0 }))
    .rejects.toMatchObject({ data: { code: "TICKET_UNAVAILABLE" } });
  await expect(t.mutation(api.annotations.addAnnotation, { token: alice, id, expectedVersion: 0, mediaIndex: 0, kind: "point", x: 0, y: 0, text: "Denied" }))
    .rejects.toMatchObject({ data: { code: "TICKET_UNAVAILABLE" } });
  expect(await t.query(api.tickets.getTicket, { token: staff, id })).not.toBeNull();
  await expect(t.mutation(api.tickets.createTextTicket, {
    token: alice, projectKey: "POS", requestId: "removed-member", title: "Denied", description: "",
  })).rejects.toThrow("PROJECT_NOT_FOUND");
});

test("both roles create and edit text-only Tickets; workflow, urgency and restore remain staff controls", async () => {
  const { t, seed, staff, alice } = await fixture();
  const intent = await t.mutation(api.uploads.createUploadIntent, { token: alice, idempotencyKey: "customer-text-only", files: [] });
  const id = await t.mutation(api.tickets.createTicket, {
    token: alice, projectId: seed.projects[0].id, title: " Customer Ticket ", description: " Text only ", media: [],
    uploadIntentId: intent.intentId, uploadIntentSecret: intent.secret, requestId: "customer-text-only",
  });
  const customer = await t.query(api.tickets.getTicket, { token: alice, id });
  expect(customer).toMatchObject({ title: "Customer Ticket", description: "Text only", lifecycle: "active", version: 0, media: [], annotations: [], origin: "customer" });
  expect((await t.run(ctx => ctx.db.get(id)))?.ownerCustomerId).toBeDefined();
  expect(customer).not.toHaveProperty("ownerCustomerId");
  const cli = await t.mutation(api.tickets.createTextTicket, {
    token: staff, projectKey: "POS", requestId: "cli-text-only", title: "Staff Ticket", description: "",
  });
  expect(cli).toMatchObject({ created: true, requestId: "cli-text-only", ticket: { origin: "staff", createdVia: "codex", lifecycle: "active" } });
  expect((await t.mutation(api.tickets.createTextTicket, {
    token: staff, projectKey: "POS", requestId: "cli-text-only", title: "Staff Ticket", description: "",
  })).created).toBe(false);
  await t.mutation(api.tickets.editTicket, { token: alice, id, title: "Edited by customer", description: "", expectedVersion: 0 });
  await expect(t.mutation(api.tickets.editTicket, { token: staff, id, title: "Stale", description: "", expectedVersion: 0 }))
    .rejects.toThrow("VERSION_CONFLICT");
  await t.mutation(api.tickets.editTicket, { token: staff, id, title: "Reviewed by staff", description: "", expectedVersion: 1 });
  await expect(t.mutation(api.tickets.updateTicketStatus, { token: alice, id, status: "acknowledged", expectedVersion: 2 })).rejects.toThrow("STAFF_ONLY");
  await expect(t.mutation(api.tickets.updateUrgencyScore, { token: alice, id, urgencyScore: 50, expectedVersion: 2 })).rejects.toThrow("STAFF_ONLY");
  await t.mutation(api.tickets.updateTicketStatus, { token: staff, id, status: "acknowledged", expectedVersion: 2 });
  await t.mutation(api.tickets.updateUrgencyScore, { token: staff, id, urgencyScore: 50, expectedVersion: 3 });
  await t.mutation(api.tickets.archiveTicket, { token: alice, id, expectedVersion: 4 });
  expect((await t.query(api.tickets.pageTickets, { token: alice, projectId: seed.projects[0].id, lifecycle: "active", paginationOpts: { numItems: 50, cursor: null } })).page.some(row => row._id === id)).toBe(false);
  await expect(t.mutation(api.tickets.restoreTicket, { token: alice, id, expectedVersion: 5 })).rejects.toThrow("STAFF_ONLY");
  await t.mutation(api.tickets.restoreTicket, { token: staff, id, expectedVersion: 5 });
  const restored = await t.query(api.tickets.getTicket, { token: alice, id });
  expect(restored).toMatchObject({ lifecycle: "active", status: "acknowledged", urgencyScore: 50, version: 6 });
  expect(restored).not.toHaveProperty("archivedAt");
  expect(await t.query(api.tickets.listTicketActivity, { token: alice, id })).toHaveLength(7);
  const totals = await t.run(ctx => ctx.db.query("ticketTotals").collect());
  expect(totals.reduce((count, total) => count + total.count, 0)).toBe(5);
  expect(totals.find(total => total.status === "acknowledged")?.count).toBe(1);
});

test("annotations enforce ownership and media validity; both roles can annotate owned Tickets", async () => {
  const { t, seed, alice, bob, staff } = await fixture();
  const id = seed.tickets[1];
  const point = { id, expectedVersion: 0, mediaIndex: 0, kind: "point" as const, x: 0.2, y: 0.3, text: "Point here" };
  await expect(t.mutation(api.annotations.addAnnotation, { ...point, token: alice })).rejects.toThrow("INVALID_MEDIA_INDEX");
  // Metadata fixture only. No upload or real provider call.
  await t.run(ctx => ctx.db.patch(id, { media: [{ key: "fake-only", name: "fixture.png", type: "image/png", size: 1, url: "https://fixture.invalid/image.png" }] }));
  await expect(t.mutation(api.annotations.addAnnotation, { ...point, token: bob })).rejects.toThrow("TICKET_UNAVAILABLE");
  const { annotationId } = await t.mutation(api.annotations.addAnnotation, { ...point, token: alice });
  await t.mutation(api.annotations.updateAnnotation, { token: staff, id, annotationId, expectedVersion: 1, text: "Reviewed note" });
  await t.mutation(api.annotations.removeAnnotation, { token: alice, id, annotationId, expectedVersion: 2 });
  await t.mutation(api.annotations.restoreAnnotation, { token: staff, id, annotationId, expectedVersion: 3 });
  const detail = await t.query(api.tickets.getTicket, { token: alice, id });
  expect(detail?.annotations[0]).toMatchObject({ text: "Reviewed note" });
  expect(detail?.annotations[0]).not.toHaveProperty("deletedAt");
  const events = await t.query(api.annotations.listAnnotationActivity, { token: alice, id });
  expect(events.map(e => e.action).sort()).toEqual(["created", "deleted", "restored", "updated"]);
  expect(events.every(e => !("sessionId" in e) && !("actorCustomerId" in e))).toBe(true);
});

test("seed is repeatable and final model numbering, totals and purging reads agree", async () => {
  const { t, seed, staff, alice } = await fixture();
  const again = await t.mutation(internal.seed.install, {});
  expect(again.tickets).toEqual(seed.tickets);
  expect(again.projects).toEqual(seed.projects);
  expect(again.sessions).not.toEqual(seed.sessions);
  expect(new Set([...again.sessions, ...seed.sessions]).size).toBe(6);
  for (const token of [...seed.sessions, ...again.sessions]) expect((await whoami(t, token)).admissionId).toBeTruthy();
  const { page: rows } = await t.query(api.tickets.pageTickets, { token: staff, projectId: seed.projects[0].id, lifecycle: "active", paginationOpts: { numItems: 50, cursor: null } });
  expect(rows.map(row => row.ticketNumber).sort()).toEqual([1, 2, 3]);
  const totals = await t.run(ctx => ctx.db.query("ticketTotals").collect());
  expect(totals).toMatchObject([{ status: "new", count: 3 }]);
  const id = seed.tickets[1];
  await t.run(ctx => ctx.db.patch(id, { lifecycle: "purging" }));
  expect(await t.query(api.tickets.getTicket, { token: staff, id })).toBeNull();
  expect(await t.query(api.tickets.getTicketByTicketNumber, { token: staff, projectKey: "POS", ticketNumber: 2, includeDeleted: true })).toBeNull();
  expect((await t.query(api.tickets.pageTickets, { token: alice, projectId: seed.projects[0].id, lifecycle: "archived", paginationOpts: { numItems: 50, cursor: null } })).page.some(row => row._id === id)).toBe(false);
  await expect(t.mutation(api.tickets.restoreTicket, { token: staff, id, expectedVersion: 0 })).rejects.toMatchObject({ data: { code: "TICKET_PURGING" } });
});

test("trusted callback constructor rejects customers, unconfigured credentials and foreign staff sessions", async () => {
  const { t, alice, staff } = await fixture();
  const intent = await t.mutation(api.uploads.createUploadIntent, { token: staff, idempotencyKey: "trusted-recording", files: [{ name: "fixture.png", size: 1, type: "image/png" }] });
  const input = { intentId: intent.intentId, secret: intent.secret, file: { key: "fake-recording", name: "fixture.png", size: 1, type: "image/png", url: "https://fixture.invalid/image.png" } };
  vi.stubEnv("UPLOAD_CALLBACK_SECRET", "");
  await expect(t.mutation(api.uploads.recordUploadedFile, input)).rejects.toThrow("UPLOAD_CALLBACK_NOT_CONFIGURED");
  vi.stubEnv("UPLOAD_CALLBACK_SECRET", "server-only");
  await expect(t.mutation(api.uploads.recordUploadedFile, { ...input, callbackToken: "forged" })).rejects.toThrow("TRUSTED_CALLBACK_REQUIRED");
  await expect(t.mutation(api.uploads.recordUploadedFile, { ...input, token: alice })).rejects.toThrow("STAFF_ONLY");
  const other = await t.mutation(fixtures.staff, { email: "other@fixture.test", role: "staff" });
  await expect(t.mutation(api.uploads.recordUploadedFile, { ...input, token: other.session })).rejects.toThrow("UPLOAD_INTENT_NOT_FOUND");
  await expect(t.mutation(api.uploads.recordUploadedFile, { ...input, token: staff, callbackToken: "server-only" })).rejects.toThrow("MIXED_CREDENTIALS");
  await t.mutation(api.uploads.recordUploadedFile, { ...input, token: staff });
  await t.mutation(api.uploads.recordUploadedFile, { ...input, callbackToken: "server-only" });
  expect(await t.run(ctx => ctx.db.get(intent.intentId))).toMatchObject({ uploadedFiles: [input.file] });
});


test("local fixtures reject missing, malformed and remote deployment URLs even with opt-in", async () => {
  for (const url of ["", "invalid", "https://shared.convex.cloud", "http://127.0.0.1.evil.test"]) {
    vi.stubEnv("CONVEX_CLOUD_URL", url);
    const t = identityTest(modules);
    await expect(t.mutation(internal.seed.install, {})).rejects.toMatchObject({ data: { code: "LOCAL_FIXTURES_DISABLED" } });
    expect(await t.run(ctx => ctx.db.query("projects").collect())).toEqual([]);
  }
});

test("customer Ticket listing uses explicit Project identity", async () => {
  const { t, alice, seed } = await fixture();
  const { page: tickets } = await t.query(api.tickets.pageTickets, { token: alice, projectId: seed.projects[0].id, lifecycle: "active", paginationOpts: { numItems: 50, cursor: null } });
  expect(tickets.map(ticket => ticket._id)).toEqual([seed.tickets[1]]);
});

test("customer handlers deny status/urgency undo, media attachment and Ticket-number lookup", async () => {
  const { t, alice, staff, seed } = await fixture();
  const id = seed.tickets[1];
  const status = await t.mutation(api.tickets.updateTicketStatus, { token: staff, id, status: "acknowledged", expectedVersion: 0 });
  const urgency = await t.mutation(api.tickets.updateUrgencyScore, { token: staff, id, urgencyScore: 50, expectedVersion: 1 });
  const intent = await t.mutation(api.uploads.createUploadIntent, { token: alice, idempotencyKey: "customer-denied-media-attach", files: [] });
  await expect(t.mutation(api.tickets.undoTicketStatus, { token: alice, eventId: status.eventId!, expectedVersion: 2 }))
    .rejects.toMatchObject({ data: { code: "STAFF_ONLY" } });
  await expect(t.mutation(api.tickets.undoUrgencyScore, { token: alice, eventId: urgency.eventId!, expectedVersion: 2 }))
    .rejects.toMatchObject({ data: { code: "STAFF_ONLY" } });
  await expect(t.mutation(api.tickets.attachTicketMedia, { token: alice, id, media: [], requestId: "denied-attach", uploadIntentId: intent.intentId, uploadIntentSecret: intent.secret, expectedVersion: 2 }))
    .rejects.toMatchObject({ data: { code: "STAFF_ONLY" } });
  await expect(t.query(api.tickets.getTicketByTicketNumber, { token: alice, projectKey: "POS", ticketNumber: 2 }))
    .rejects.toMatchObject({ data: { code: "STAFF_ONLY" } });
  expect(await t.query(api.tickets.getTicket, { token: alice, id })).toMatchObject({ version: 2, status: "acknowledged", urgencyScore: 50, media: [] });
});
