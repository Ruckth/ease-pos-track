import type { FunctionReturnType } from "convex/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import { internalJobAction, internalJobMutation } from "./functions";
import { requireLocalFixtures } from "./local_fixtures";
import { requireActor } from "./session_auth";
import { requireUsableProject } from "./domain/projects";
import { createTicketRecord } from "./domain/tickets";
import { actorFields, newTicketOwnership } from "./authz";
import { errorCode } from "../shared/errors";
import { attachIntentAssets, recordUpload } from "./domain/media";

/** Fake metadata is confined to the opt-in local fixture. No provider I/O. */
export const annotationFixture = internalJobMutation({
  name: "local_smoke:annotationFixture",
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    requireLocalFixtures();
    const { actor, session } = await requireActor(ctx, token);
    const project = await ctx.db.query("projects").withIndex("by_key", q => q.eq("key", "POS")).unique();
    if (!project) throw new Error("PROJECT_NOT_FOUND");
    const now = Date.now();
    const file = { key: `local-fake-${crypto.randomUUID()}`, name: "fixture.png", size: 1, type: "image/png", url: "https://fixture.invalid/image.png" };
    const intentId = await ctx.db.insert("uploadIntents", {
      sessionId: session._id, ...actorFields(actor), secret: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(),
      expectedFiles: [{ name: file.name, size: file.size, type: file.type }], uploadedFiles: [], status: "pending",
      createdAt: now, updatedAt: now, expiresAt: now + 60_000,
    });
    const intent = (await ctx.db.get(intentId))!;
    await recordUpload(ctx, intent, file);
    const created = await createTicketRecord(ctx, {
      project: await requireUsableProject(ctx, actor, project._id),
      title: "Local annotation fixture", description: "Fake metadata only",
      media: [file],
      ownership: newTicketOwnership(actor), author: { sessionId: session._id, ...actorFields(actor) }, now: Date.now(),
    });
    await attachIntentAssets(ctx, intent, created._id, [file]);
    return created._id;
  },
});

export const run = internalJobAction({
  name: "local_smoke:run",
  args: {},
  handler: async (ctx): Promise<{ ok: true; checks: string[] }> => {
    requireLocalFixtures();
    const checks: string[] = [];
    function check(value: unknown, name: string) {
      if (!value) throw new Error(`Local smoke failed: ${name}`);
      checks.push(name);
    }
    async function denied(run: () => Promise<unknown>, code: string, name: string) {
      try { await run(); }
      catch (error) { check(errorCode(error) === code, name); return; }
      throw new Error(`Local smoke failed: ${name}`);
    }
    const seeded = await ctx.runAction(internal.seed.run, {});
    for (let index = 0; index < seeded.sessions.length; index++) {
      const token = seeded.sessions[index];
      check((await ctx.runQuery(api.auth.currentSession, { token }))?.role === (index === 0 ? "staff" : "customer"), "random seed session and explicit role");
    }
    const staff = (await ctx.runMutation(api.auth.login, { password: "LocalStaff123!", clientId: "local-smoke-staff-client" })).token;
    const alice = (await ctx.runAction(api.customers.login, { email: "alice@local.test", password: "LocalCustomer123!", clientId: "local-smoke-alice-client" })).token;
    const bob = (await ctx.runAction(api.customers.login, { email: "bob@local.test", password: "LocalCustomer123!", clientId: "local-smoke-bob-client" })).token;
    check((await ctx.runQuery(api.auth.currentSession, { token: staff }))?.role === "staff", "staff credential and explicit role");
    check((await ctx.runQuery(api.auth.currentSession, { token: alice }))?.role === "customer", "customer credential and explicit role");
    // Real OCC contention: the action starts separate concurrent mutation
    // transactions, rather than simulating duplicates in a single mutation.
    const before = await ctx.runQuery(api.tickets.laneTotals, { token: staff, projectId: seeded.projects[0].id });
    const duplicateInput = { token: staff, projectKey: "POS", requestId: crypto.randomUUID(), title: "Concurrent local create", description: "Immutable original" };
    const duplicates = await Promise.all(Array.from({ length: 8 }, () => ctx.runMutation(api.tickets.createTextTicket, duplicateInput)));
    const duplicateId = duplicates[0].ticket._id;
    check(duplicates.filter(result => result.created).length === 1 && duplicates.every(result => result.ticket._id === duplicateId), "eight concurrent duplicates commit exactly once");
    const after = await ctx.runQuery(api.tickets.laneTotals, { token: staff, projectId: seeded.projects[0].id });
    check(after.new === (before.new ?? 0) + 1, "concurrent duplicates insert exactly one Ticket row");
    check((await ctx.runQuery(api.tickets.listTicketActivity, { token: staff, id: duplicateId })).length === 1, "concurrent duplicates insert exactly one audit event");
    await ctx.runMutation(api.tickets.editTicket, { token: staff, id: duplicateId, expectedVersion: 0, title: "Edited after create", description: "" });
    const replay = await ctx.runMutation(api.tickets.createTextTicket, duplicateInput);
    check(!replay.created && replay.ticket._id === duplicateId && replay.ticket.version === 1, "original retry after edit returns same Ticket");
    await denied(() => ctx.runMutation(api.tickets.createTextTicket, { ...duplicateInput, title: "Different" }), "REQUEST_ID_CONFLICT", "different content conflicts");
    await denied(() => ctx.runMutation(api.tickets.createTextTicket, { ...duplicateInput, projectKey: "APP" }), "REQUEST_ID_CONFLICT", "different Project conflicts");
    const crossProjectRequestId = crypto.randomUUID();
    const competing = await Promise.allSettled(["POS", "APP"].map(projectKey => ctx.runMutation(api.tickets.createTextTicket, {
      ...duplicateInput, requestId: crossProjectRequestId, projectKey,
    })));
    check(competing.filter(result => result.status === "fulfilled").length === 1
      && competing.some(result => result.status === "rejected" && errorCode(result.reason) === "REQUEST_ID_CONFLICT"),
    "concurrent different-Project requests commit once and conflict");
    // Large seeds grant APP membership; use a Project owned by this invocation.
    const foreignProject = await ctx.runMutation(api.projects.createProject, {
      token: staff, key: `S${crypto.randomUUID().replace(/-/g, "").slice(0, 9)}`, name: "Local access smoke",
    });
    await denied(() => ctx.runMutation(api.tickets.createTextTicket, { token: alice, projectKey: foreignProject.key, requestId: crypto.randomUUID(), title: "Denied", description: "" }), "PROJECT_NOT_FOUND", "customer foreign Project denied");
    for (const token of [staff, alice]) {
      const created = await ctx.runMutation(api.tickets.createTextTicket, { token, projectKey: "POS", requestId: crypto.randomUUID(), title: "Local text-only smoke", description: "" });
      const id = created.ticket._id;
      check(created.created && created.ticket.lifecycle === "active" && created.ticket.media.length === 0, `${token === staff ? "staff" : "customer"} text-only create`);
      check(Boolean(await ctx.runQuery(api.tickets.getTicket, { token, id })), "detail");
      if (token === alice) {
        check(await ctx.runQuery(api.tickets.getTicket, { token: bob, id }) === null, "foreign customer detail denied");
        await denied(() => ctx.runMutation(api.tickets.editTicket, { token: bob, id, title: "Denied", description: "", expectedVersion: 0 }), "TICKET_UNAVAILABLE", "foreign customer edit denied");
        await denied(() => ctx.runMutation(api.tickets.updateTicketStatus, { token, id, status: "done", expectedVersion: 0 }), "STAFF_ONLY", "customer status denied");
        await denied(() => ctx.runMutation(api.tickets.updateUrgencyScore, { token, id, urgencyScore: 50, expectedVersion: 0 }), "STAFF_ONLY", "customer urgency denied");
      }
      await ctx.runMutation(api.tickets.editTicket, { token, id, title: "Edited local smoke", description: "", expectedVersion: 0 });
      await ctx.runMutation(api.tickets.updateTicketStatus, { token: staff, id, status: "acknowledged", expectedVersion: 1 });
      await ctx.runMutation(api.tickets.updateUrgencyScore, { token: staff, id, urgencyScore: 42, expectedVersion: 2 });
      await ctx.runMutation(api.tickets.archiveTicket, { token, id, expectedVersion: 3 });
      if (token === alice) await denied(() => ctx.runMutation(api.tickets.restoreTicket, { token, id, expectedVersion: 4 }), "STAFF_ONLY", "customer restore denied");
      await ctx.runMutation(api.tickets.restoreTicket, { token: staff, id, expectedVersion: 4 });
      const detail = await ctx.runQuery(api.tickets.getTicket, { token, id });
      check(detail?.version === 5 && detail.lifecycle === "active" && detail.archivedAt === undefined && detail.status === "acknowledged" && detail.urgencyScore === 42, "edit/status/urgency/archive/restore");
    }
    const id = await ctx.runMutation(internal.local_smoke.annotationFixture, { token: alice });
    await denied(() => ctx.runMutation(api.annotations.addAnnotation, { token: bob, id, expectedVersion: 0, kind: "point", mediaIndex: 0, x: 0.5, y: 0.5, text: "Denied" }), "TICKET_UNAVAILABLE", "foreign customer annotation denied");
    const added = await ctx.runMutation(api.annotations.addAnnotation, { token: alice, id, expectedVersion: 0, kind: "point", mediaIndex: 0, x: 0.5, y: 0.5, text: "Local note" });
    const { annotationId } = added;
    const updated = await ctx.runMutation(api.annotations.updateAnnotation, { token: staff, id, annotationId, expectedVersion: added.version, text: "Reviewed local note" });
    const removed = await ctx.runMutation(api.annotations.removeAnnotation, { token: alice, id, annotationId, expectedVersion: updated.version });
    const restored = await ctx.runMutation(api.annotations.restoreAnnotation, { token: staff, id, annotationId, expectedVersion: removed.version });
    check(restored.version === 4, "annotation delete undo uses returned version");
    check((await ctx.runQuery(api.annotations.listAnnotationActivity, { token: alice, id })).length === 4, "annotation create/edit/remove/restore with fake metadata");
    for (const token of [staff, alice, bob, ...seeded.sessions]) await ctx.runMutation(api.auth.logout, { token });
    return { ok: true, checks };
  },
});

/** P3 contention proof on the disposable backend. Fake receipts, no provider I/O. */
export const media = internalJobAction({
  name: "local_smoke:media",
  args: {},
  handler: async (ctx): Promise<{ ok: true; checks: string[] }> => {
    requireLocalFixtures();
    // Fake keys must remain reserved without ever waking a real provider action.
    if (process.env.MEDIA_CLEANUP_ENABLED === "true") throw new Error("LOCAL_MEDIA_REQUIRES_CLEANUP_DISABLED");
    const seeded = await ctx.runAction(internal.seed.run, {});
    const token = seeded.sessions[0];
    const requestId = crypto.randomUUID();
    const file = { key: `local-fake-${requestId}`, name: "fixture.png", size: 1, type: "image/png", url: "https://fixture.invalid/image.png" };
    const files = [{ name: file.name, size: file.size, type: file.type }];
    const handles = await Promise.all(["first", "second"].map(suffix => ctx.runMutation(api.uploads.createUploadIntent, {
      token, idempotencyKey: `${requestId}-${suffix}`, files,
    })));
    const record = (handle: typeof handles[number], uploaded = file) => ctx.runMutation(api.uploads.recordUploadedFile, {
      token, intentId: handle.intentId, secret: handle.secret, file: uploaded,
    });
    const claims = await Promise.allSettled(handles.map(handle => record(handle)));
    if (claims.filter(result => result.status === "fulfilled").length !== 1
      || !claims.some(result => result.status === "rejected" && errorCode(result.reason) === "MEDIA_OWNERSHIP_CONFLICT")) {
      throw new Error("LOCAL_MEDIA_CLAIM_FAILED");
    }
    const winner = handles[claims.findIndex(result => result.status === "fulfilled")];
    const loser = handles[claims.findIndex(result => result.status === "rejected")];
    const duplicates = await Promise.all(Array.from({ length: 8 }, () => record(winner)));
    if (!duplicates.every(result => result.state === "recorded")) throw new Error("LOCAL_MEDIA_REPLAY_FAILED");
    const input = { token, projectId: seeded.projects[0].id, requestId, title: "Local media ownership fixture", description: "", media: [file], uploadIntentId: winner.intentId, uploadIntentSecret: winner.secret };
    const id = await ctx.runMutation(api.tickets.createTicket, input);
    if (await ctx.runMutation(api.tickets.createTicket, input) !== id || (await record(winner)).state !== "recorded") throw new Error("LOCAL_MEDIA_ATTACHMENT_FAILED");
    try { await record(loser); throw new Error("LOCAL_MEDIA_TAKEOVER_FAILED"); }
    catch (error) { if (errorCode(error) !== "MEDIA_OWNERSHIP_CONFLICT") throw error; }
    const cancellation = await ctx.runMutation(api.uploads.cancelUploadIntent, { token, intentId: winner.intentId, secret: winner.secret });
    if (cancellation.state !== "completed" || cancellation.jobIds.length) throw new Error("LOCAL_MEDIA_ATTACHED_CANCEL_FAILED");
    await ctx.runMutation(api.uploads.cancelUploadIntent, { token, intentId: loser.intentId, secret: loser.secret });
    try { await record(loser, { ...file, key: `${file.key}-legacy` }); throw new Error("LOCAL_MEDIA_STAFF_LATE_FAILED"); }
    catch (error) { if (errorCode(error) !== "UPLOAD_INTENT_INVALID") throw error; }
    const late = await ctx.runMutation(api.uploads.recordUploadedFile, {
      callbackToken: process.env.UPLOAD_CALLBACK_SECRET, intentId: loser.intentId, secret: loser.secret,
      file: { ...file, key: `${file.key}-late` },
    });
    if (late.state !== "queued" || late.jobIds.length !== 1) throw new Error("LOCAL_MEDIA_LATE_FAILED");
    const progress = await ctx.runQuery(api.retention.progress, {
      token, intentId: loser.intentId, secret: loser.secret, jobId: late.jobIds[0],
    });
    if (progress.state !== "pending" || progress.attempt !== 0 || progress.completedCount !== 0) throw new Error("LOCAL_MEDIA_DISABLED_PROGRESS_FAILED");
    const row = await ctx.runQuery(api.tickets.getTicket, { token, id });
    if (row?.media.length !== 1 || row.media[0].key !== file.key) throw new Error("LOCAL_MEDIA_TICKET_FAILED");
    const customer = seeded.sessions[1];
    const customerFile = { ...file, key: `${file.key}-customer` };
    const customerIntent = await ctx.runMutation(api.uploads.createUploadIntent, { token: customer, idempotencyKey: `${requestId}-customer`, files });
    const callbackToken = process.env.UPLOAD_CALLBACK_SECRET;
    if (!callbackToken) throw new Error("UPLOAD_CALLBACK_NOT_CONFIGURED");
    if (!await ctx.runQuery(api.uploads.validateUploadIntent, {
      token: customer, callbackToken, intentId: customerIntent.intentId, secret: customerIntent.secret, files,
    })) throw new Error("LOCAL_MEDIA_PREFLIGHT_FAILED");
    await ctx.runMutation(api.uploads.recordUploadedFile, { callbackToken, intentId: customerIntent.intentId, secret: customerIntent.secret, file: customerFile });
    const customerId = await ctx.runMutation(api.tickets.createTicket, {
      ...input, token: customer, requestId: `${requestId}-customer`, media: [customerFile],
      uploadIntentId: customerIntent.intentId, uploadIntentSecret: customerIntent.secret,
    });
    if ((await ctx.runQuery(api.tickets.getTicket, { token: customer, id: customerId }))?.media[0].key !== customerFile.key) throw new Error("LOCAL_MEDIA_CUSTOMER_FAILED");
    return { ok: true, checks: ["concurrent exclusive key claims", "eight identical recording replays", "atomic attachment and create replay", "attached key takeover denied", "attached cancellation reserves nothing", "customer callback preflight and media Ticket", "staff late key rejected", "trusted late new upload reserved under pending job", "disabled cleanup exposes pending progress without provider attempts"] };
  },
});

/** P5 real search-engine validation; text-only fixtures and no provider I/O. */
export const reads = internalJobAction({
  name: "local_smoke:reads",
  args: {},
  handler: async (ctx): Promise<{ ok: true; checks: string[]; projects: { key: string; tickets: number }[]; searchOrder: string[]; thaiMatches: { search: string; titles: string[] }[]; firstPageDocuments: number; firstPageJsonBytes: number }> => {
    requireLocalFixtures();
    const seeded = await ctx.runAction(internal.seed.run, { largeDataset: true });
    const token = seeded.sessions[0];
    // Exact relevance assertions need controlled matches, independent of prior
    // smoke runs or unrelated Tickets that could fill the bounded search window.
    const searchProject = await ctx.runMutation(api.projects.createProject, {
      token, key: `S${crypto.randomUUID().replace(/-/g, "").slice(0, 9)}`, name: "Local search smoke",
    });
    await ctx.runMutation(internal.seed.largeBatch, { projectId: searchProject._id, sessions: seeded.sessions, start: 0 });
    const args = { token, projectId: searchProject._id, lifecycle: "active" as const, paginationOpts: { numItems: 20, cursor: null } };
    const matches = await ctx.runQuery(api.tickets.searchTickets, { token, projectId: args.projectId, lifecycle: args.lifecycle, search: "quar" });
    const searchOrder = matches.matches.map(row => row.title);
    if (JSON.stringify(searchOrder) !== JSON.stringify(["quartz", "quartz calibration", "Printer calibration"])) throw new Error(`LOCAL_SEARCH_ORDER_FAILED:${JSON.stringify(searchOrder)}`);
    const owned = await ctx.runQuery(api.tickets.searchTickets, { token: seeded.sessions[1], projectId: args.projectId, lifecycle: args.lifecycle, search: "quartz" });
    if (owned.matches.length !== 1 || owned.matches[0].title !== "Printer calibration") throw new Error("LOCAL_SEARCH_OWNER_FAILED");
    const foreign = await ctx.runQuery(api.tickets.searchTickets, { token, projectId: args.projectId, lifecycle: args.lifecycle, search: "APP-0001" });
    if (foreign.matches.length) throw new Error("LOCAL_SEARCH_PROJECT_FAILED");
    const fragment = await ctx.runQuery(api.tickets.searchTickets, { token, projectId: args.projectId, lifecycle: args.lifecycle, search: "uartz" });
    if (fragment.matches.length) throw new Error("LOCAL_SEARCH_FRAGMENT_FAILED");
    const thaiExamples = ["หน้าจอค้าง เมื่อกดปุ่มชำระเงิน ที่สาขาสีลม", "เครื่องพิมพ์ไม่ออกใบเสร็จ"];
    for (const title of [...thaiExamples, "HP-1020 printer"]) await ctx.runMutation(api.tickets.createTextTicket, {
      token, projectKey: searchProject.key, requestId: crypto.randomUUID(), title, description: "",
    });
    const printer = await ctx.runQuery(api.tickets.searchTickets, { token, projectId: args.projectId, lifecycle: args.lifecycle, search: "HP-1020" });
    if (printer.matches.length !== 1 || printer.matches[0].title !== "HP-1020 printer") throw new Error("LOCAL_REFERENCE_TEXT_FALLBACK_FAILED");
    const thaiMatches: { search: string; titles: string[] }[] = [];
    for (const search of [...thaiExamples, "หน้าจอ", "ค้าง", "หน้าจอค้าง", "เมื่อกดปุ่มชำระเงิน", "ชำระเงิน", "เครื่องพิมพ์", "ใบเสร็จ"]) {
      const result = await ctx.runQuery(api.tickets.searchTickets, { token, projectId: args.projectId, lifecycle: args.lifecycle, search });
      const titles = result.matches.map(row => row.title);
      const expected = search === "ชำระเงิน" ? [] : [thaiExamples[search === thaiExamples[1] || search === "เครื่องพิมพ์" || search === "ใบเสร็จ" ? 1 : 0]];
      if (JSON.stringify(titles) !== JSON.stringify(expected)) throw new Error(`LOCAL_THAI_SEARCH_FAILED:${search}`);
      thaiMatches.push({ search, titles });
    }
    const projects = [];
    for (const project of [...seeded.projects, { id: searchProject._id, key: searchProject.key }]) {
      let count = 0;
      let cursor: string | null = null;
      let previous = Infinity;
      for (;;) {
        const result: FunctionReturnType<typeof api.tickets.pageTickets> = await ctx.runQuery(api.tickets.pageTickets, { ...args, projectId: project.id, paginationOpts: { numItems: 50, cursor } });
        if (result.page.length > 50) throw new Error("LOCAL_PAGE_BOUND_FAILED");
        for (const row of result.page) {
          // Strictly descending numbers also detect repeated rows across pages.
          if (row.projectId !== project.id || row.ticketNumber >= previous) throw new Error("LOCAL_PAGE_ORDER_FAILED");
          previous = row.ticketNumber;
          count++;
        }
        if (result.isDone) break;
        cursor = result.continueCursor;
      }
      const totals = await ctx.runQuery(api.tickets.laneTotals, { token, projectId: project.id });
      if (Object.values(totals).reduce((a, b) => a + b, 0) !== count) throw new Error("LOCAL_TOTALS_FAILED");
      projects.push({ key: project.key, tickets: count });
    }
    const first = await ctx.runQuery(api.tickets.pageTickets, { ...args, projectId: seeded.projects[0].id, status: "new" });
    return { ok: true, checks: ["relevance order differs from Ticket-number order", "owner and Project search scope", "prefix matches; middle fragment does not", "reference-shaped text falls back to indexed search", "Thai examples accepted with real token boundary matching", "all pages ordered without duplicates", "workflow totals independent of pages"], projects, searchOrder, thaiMatches, firstPageDocuments: first.page.length, firstPageJsonBytes: new TextEncoder().encode(JSON.stringify(first)).byteLength };
  },
});
