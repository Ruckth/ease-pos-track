import { getFunctionName, type FunctionArgs, type FunctionReference, type FunctionReturnType } from "convex/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internalJobAction, internalJobMutation, internalJobQuery } from "./functions";
import { requireLocalFixtures } from "./local_fixtures";
import { fixtureAccess } from "./local_identity";
import * as tickets from "./tickets";
import * as annotations from "./annotations";
import * as projects from "./projects";
import * as uploads from "./uploads";
import * as retention from "./retention";
import * as identity from "./identity";
import * as auth from "./auth";
import * as pagesModule from "./pages";
import { transitionCustomer } from "./domain/identity";
import { accessTokenSessionId } from "./identity_rules";
import { LOCAL_CUSTOMER_PASSWORD } from "./local_identity";
import { requireUsableProject } from "./domain/projects";
import { createTicketRecord } from "./domain/tickets";
import { actorFields, newTicketOwnership } from "./authz";
import { errorCode } from "../shared/errors";
import { attachIntentAssets, recordUpload } from "./domain/media";
import { reconcilePageWrites } from "./domain/pages";
import { formatTicketNumber } from "../shared/ticket-numbers";
import { pageFormData, sha256Hex } from "../shared/ticket-pages";

// Local-only: run a real public registration under a fixture core session, so
// the smoke exercises the same live session, admission and policy checks as a
// browser JWT. Internal actions have no identity of their own.
const REGISTRY: Record<string, Record<string, unknown>> = { tickets, annotations, projects, uploads, retention, identity, auth, pages: pagesModule };
function registration(name: string) {
  const [module, exportName] = name.split(":");
  const fn = REGISTRY[module]?.[exportName] as { _handler?: (ctx: unknown, args: unknown) => Promise<unknown> } | undefined;
  if (!fn?._handler) throw new Error("INVALID_INPUT");
  return fn._handler;
}
function asSession<C extends QueryCtx | MutationCtx>(ctx: C, subject: string): C {
  const scoped = Object.create(ctx) as C;
  Object.defineProperty(scoped, "auth", { value: { ...ctx.auth, getUserIdentity: async () => ({ subject, issuer: "local-fixture", tokenIdentifier: `local-fixture|${subject}` }) } });
  return scoped;
}
export const queryAs = internalJobQuery({
  name: "local_smoke:queryAs",
  args: { session: v.string(), name: v.string(), args: v.any() },
  handler: async (ctx, input) => { requireLocalFixtures(); return await registration(input.name)(asSession(ctx, input.session), input.args); },
});
export const mutationAs = internalJobMutation({
  name: "local_smoke:mutationAs",
  args: { session: v.string(), name: v.string(), args: v.any() },
  handler: async (ctx, input) => { requireLocalFixtures(); return await registration(input.name)(asSession(ctx, input.session), input.args); },
});
function as(ctx: ActionCtx) {
  return {
    query: <F extends FunctionReference<"query">>(session: string, ref: F, args: FunctionArgs<F>) =>
      ctx.runQuery(internal.local_smoke.queryAs, { session, name: getFunctionName(ref), args }) as Promise<FunctionReturnType<F>>,
    mutation: <F extends FunctionReference<"mutation", "public" | "internal">>(session: string, ref: F, args: FunctionArgs<F>) =>
      ctx.runMutation(internal.local_smoke.mutationAs, { session, name: getFunctionName(ref), args }) as Promise<FunctionReturnType<F>>,
  };
}

/** Stock Google start through the wrapper, then a completion with an unknown ticket. */
export const googleStartAndInvalidCompletion = internalJobMutation({
  name: "local_smoke:googleStartAndInvalidCompletion",
  args: {},
  handler: async (ctx) => {
    requireLocalFixtures();
    const before = (await ctx.db.query("sessionAdmissions").collect()).length;
    const started = await registration("auth:startSignInWithGoogle")(ctx, { redirectTo: "http://localhost:5173/" }) as { redirect: string; state: string };
    const flowRecorded = (await ctx.db.query("googleFlows").collect()).some(flow => flow.consumedAt === undefined);
    const completion = await registration("auth:completeSignInWithGoogle")(ctx, { code: "unknown-ticket", state: started.state }) as { status: string; userError?: { error: string } };
    const admitted = (await ctx.db.query("sessionAdmissions").collect()).length !== before;
    return { redirect: started.redirect, flowRecorded, completion: completion.userError?.error ?? completion.status, admitted };
  },
});

/** Live disable while a session is open, then re-enable (old sessions stay revoked). */
export const disableAndRestore = internalJobMutation({
  name: "local_smoke:disableAndRestore",
  args: { session: v.string() },
  handler: async (ctx, args) => {
    requireLocalFixtures();
    const { actor } = await fixtureAccess(ctx, args.session);
    if (actor.role !== "customer") throw new Error("CUSTOMER_ONLY");
    const owner = (await ctx.db.query("staff").withIndex("by_email", (q) => q.eq("email", "owner@local.test")).unique())!;
    await transitionCustomer(ctx, (await ctx.db.get(actor.customerId))!, "disabled", owner._id);
    await transitionCustomer(ctx, (await ctx.db.get(actor.customerId))!, "active", owner._id);
  },
});

/** Fake metadata is confined to the opt-in local fixture. No provider I/O. */
export const annotationFixture = internalJobMutation({
  name: "local_smoke:annotationFixture",
  args: { session: v.string() },
  handler: async (ctx, args) => {
    requireLocalFixtures();
    const { actor, session } = await fixtureAccess(ctx, args.session);
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
    await recordUpload(ctx, intent, file, "staff");
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
  // convex-test cannot route component httpPrefix callbacks; the disposable
  // backend always runs the Google step.
  args: { skipGoogle: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<{ ok: true; checks: string[] }> => {
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
    const call = as(ctx);
    const seeded = await ctx.runAction(internal.seed.run, {});
    for (let index = 0; index < seeded.sessions.length; index++) {
      check((await call.query(seeded.sessions[index], api.identity.viewer, {}))?.kind === (index === 0 ? "staff" : "customer"), "fixture session admission and explicit role");
    }
    const staff = seeded.sessions[0];
    const attemptSignIn = (username: string, password: string) => ctx.runAction(api.auth.signInWithPassword, { username, password });
    const signIn = async (username: string) => {
      const result = await attemptSignIn(username, LOCAL_CUSTOMER_PASSWORD);
      if (result.status !== "complete") throw new Error("Local smoke failed: customer password sign-in");
      return accessTokenSessionId(result.tokens.accessToken);
    };
    const alice = await signIn("alice");
    const bob = await signIn("bob");
    check((await call.query(staff, api.identity.viewer, {}))?.kind === "staff", "staff credential and explicit role");
    check((await call.query(alice, api.identity.viewer, {}))?.kind === "customer", "customer credential and explicit role");
    check((await attemptSignIn("alice", "wrong customer passphrase")).status === "error", "wrong password issues no session");
    check((await attemptSignIn(`unused-${crypto.randomUUID().slice(0, 8)}`, LOCAL_CUSTOMER_PASSWORD)).status === "error",
      "unknown account issues no session");
    // Real OCC contention: the action starts separate concurrent mutation
    // transactions, rather than simulating duplicates in a single mutation.
    const before = await call.query(staff, api.tickets.laneTotals, { projectId: seeded.projects[0].id });
    const duplicateInput = { projectKey: "POS", requestId: crypto.randomUUID(), title: "Concurrent local create", description: "Immutable original" };
    const duplicates = await Promise.all(Array.from({ length: 8 }, () => call.mutation(staff, api.tickets.createTextTicket, duplicateInput)));
    const duplicateId = duplicates[0].ticket._id;
    check(duplicates.filter(result => result.created).length === 1 && duplicates.every(result => result.ticket._id === duplicateId), "eight concurrent duplicates commit exactly once");
    const after = await call.query(staff, api.tickets.laneTotals, { projectId: seeded.projects[0].id });
    check(after.new === (before.new ?? 0) + 1, "concurrent duplicates insert exactly one Ticket row");
    check((await call.query(staff, api.tickets.listTicketActivity, { id: duplicateId })).length === 1, "concurrent duplicates insert exactly one audit event");
    await call.mutation(staff, api.tickets.editTicket, { id: duplicateId, expectedVersion: 0, title: "Edited after create", description: "" });
    const replay = await call.mutation(staff, api.tickets.createTextTicket, duplicateInput);
    check(!replay.created && replay.ticket._id === duplicateId && replay.ticket.version === 1, "original retry after edit returns same Ticket");
    await denied(() => call.mutation(staff, api.tickets.createTextTicket, { ...duplicateInput, title: "Different" }), "REQUEST_ID_CONFLICT", "different content conflicts");
    await denied(() => call.mutation(staff, api.tickets.createTextTicket, { ...duplicateInput, projectKey: "APP" }), "REQUEST_ID_CONFLICT", "different Project conflicts");
    const crossProjectRequestId = crypto.randomUUID();
    const competing = await Promise.allSettled(["POS", "APP"].map(projectKey => call.mutation(staff, api.tickets.createTextTicket, {
      ...duplicateInput, requestId: crossProjectRequestId, projectKey,
    })));
    check(competing.filter(result => result.status === "fulfilled").length === 1
      && competing.some(result => result.status === "rejected" && errorCode(result.reason) === "REQUEST_ID_CONFLICT"),
    "concurrent different-Project requests commit once and conflict");
    // Large seeds grant APP membership; use a Project owned by this invocation.
    const foreignProject = await call.mutation(staff, api.projects.createProject, {
      key: `S${crypto.randomUUID().replace(/-/g, "").slice(0, 9)}`, name: "Local access smoke",
    });
    await denied(() => call.mutation(alice, api.tickets.createTextTicket, { projectKey: foreignProject.key, requestId: crypto.randomUUID(), title: "Denied", description: "" }), "PROJECT_NOT_FOUND", "customer foreign Project denied");
    for (const token of [staff, alice]) {
      const created = await call.mutation(token, api.tickets.createTextTicket, { projectKey: "POS", requestId: crypto.randomUUID(), title: "Local text-only smoke", description: "" });
      const id = created.ticket._id;
      check(created.created && created.ticket.lifecycle === "active" && created.ticket.media.length === 0, `${token === staff ? "staff" : "customer"} text-only create`);
      check(Boolean(await call.query(token, api.tickets.getTicket, { id })), "detail");
      if (token === alice) {
        check(await call.query(bob, api.tickets.getTicket, { id }) === null, "foreign customer detail denied");
        await denied(() => call.mutation(bob, api.tickets.editTicket, { id, title: "Denied", description: "", expectedVersion: 0 }), "TICKET_UNAVAILABLE", "foreign customer edit denied");
        await denied(() => call.mutation(token, api.tickets.updateTicketStatus, { id, status: "done", expectedVersion: 0 }), "STAFF_ONLY", "customer status denied");
        await denied(() => call.mutation(token, api.tickets.updateUrgencyScore, { id, urgencyScore: 50, expectedVersion: 0 }), "STAFF_ONLY", "customer urgency denied");
      }
      await call.mutation(token, api.tickets.editTicket, { id, title: "Edited local smoke", description: "", expectedVersion: 0 });
      await call.mutation(staff, api.tickets.updateTicketStatus, { id, status: "acknowledged", expectedVersion: 1 });
      await call.mutation(staff, api.tickets.updateUrgencyScore, { id, urgencyScore: 42, expectedVersion: 2 });
      await call.mutation(token, api.tickets.archiveTicket, { id, expectedVersion: 3 });
      if (token === alice) await denied(() => call.mutation(token, api.tickets.restoreTicket, { id, expectedVersion: 4 }), "STAFF_ONLY", "customer restore denied");
      await call.mutation(staff, api.tickets.restoreTicket, { id, expectedVersion: 4 });
      const detail = await call.query(token, api.tickets.getTicket, { id });
      check(detail?.version === 5 && detail.lifecycle === "active" && detail.archivedAt === undefined && detail.status === "acknowledged" && detail.urgencyScore === 42, "edit/status/urgency/archive/restore");
    }
    const id = await ctx.runMutation(internal.local_smoke.annotationFixture, { session: alice });
    await denied(() => call.mutation(bob, api.annotations.addAnnotation, { id, expectedVersion: 0, kind: "point", mediaIndex: 0, x: 0.5, y: 0.5, text: "Denied" }), "TICKET_UNAVAILABLE", "foreign customer annotation denied");
    const added = await call.mutation(alice, api.annotations.addAnnotation, { id, expectedVersion: 0, kind: "point", mediaIndex: 0, x: 0.5, y: 0.5, text: "Local note" });
    const { annotationId } = added;
    const updated = await call.mutation(staff, api.annotations.updateAnnotation, { id, annotationId, expectedVersion: added.version, text: "Reviewed local note" });
    const removed = await call.mutation(alice, api.annotations.removeAnnotation, { id, annotationId, expectedVersion: updated.version });
    const restored = await call.mutation(staff, api.annotations.restoreAnnotation, { id, annotationId, expectedVersion: removed.version });
    check(restored.version === 4, "annotation delete undo uses returned version");
    check((await call.query(alice, api.annotations.listAnnotationActivity, { id })).length === 4, "annotation create/edit/remove/restore with fake metadata");
    if (!args.skipGoogle) {
      const google = await ctx.runMutation(internal.local_smoke.googleStartAndInvalidCompletion, {});
      check(google.redirect.startsWith("https://accounts.google.com/") && google.redirect.includes(encodeURIComponent("/oauth/google/callback")), "Google start uses the component callback route");
      check(google.flowRecorded && google.completion === "INVALID_CODE" && !google.admitted, "Google flow recorded; unknown ticket admits nothing");
    }
    await ctx.runMutation(internal.local_smoke.disableAndRestore, { session: bob });
    await denied(() => call.query(bob, api.tickets.getTicket, { id }), "SESSION_EXPIRED", "disabled customer session denied on next call");
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
    const call = as(ctx);
    const seeded = await ctx.runAction(internal.seed.run, {});
    const token = seeded.sessions[0];
    const requestId = crypto.randomUUID();
    const file = { key: `local-fake-${requestId}`, name: "fixture.png", size: 1, type: "image/png", url: "https://fixture.invalid/image.png" };
    const files = [{ name: file.name, size: file.size, type: file.type }];
    const handles = await Promise.all(["first", "second"].map(suffix => call.mutation(token, api.uploads.createUploadIntent, {
      idempotencyKey: `${requestId}-${suffix}`, files,
    })));
    const record = (handle: typeof handles[number], uploaded = file) => call.mutation(token, api.uploads.recordUploadedFile, {
      intentId: handle.intentId, secret: handle.secret, file: uploaded,
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
    const input = { projectId: seeded.projects[0].id, requestId, title: "Local media ownership fixture", description: "", media: [file], uploadIntentId: winner.intentId, uploadIntentSecret: winner.secret };
    const id = await call.mutation(token, api.tickets.createTicket, input);
    if (await call.mutation(token, api.tickets.createTicket, input) !== id || (await record(winner)).state !== "recorded") throw new Error("LOCAL_MEDIA_ATTACHMENT_FAILED");
    try { await record(loser); throw new Error("LOCAL_MEDIA_TAKEOVER_FAILED"); }
    catch (error) { if (errorCode(error) !== "MEDIA_OWNERSHIP_CONFLICT") throw error; }
    const cancellation = await call.mutation(token, api.uploads.cancelUploadIntent, { intentId: winner.intentId, secret: winner.secret });
    if (cancellation.state !== "completed" || cancellation.jobIds.length) throw new Error("LOCAL_MEDIA_ATTACHED_CANCEL_FAILED");
    await call.mutation(token, api.uploads.cancelUploadIntent, { intentId: loser.intentId, secret: loser.secret });
    try { await record(loser, { ...file, key: `${file.key}-legacy` }); throw new Error("LOCAL_MEDIA_STAFF_LATE_FAILED"); }
    catch (error) { if (errorCode(error) !== "UPLOAD_INTENT_INVALID") throw error; }
    const late = await ctx.runMutation(api.uploads.recordUploadedFile, {
      callbackToken: process.env.UPLOAD_CALLBACK_SECRET, intentId: loser.intentId, secret: loser.secret,
      file: { ...file, key: `${file.key}-late` },
    });
    if (late.state !== "queued" || late.jobIds.length !== 1) throw new Error("LOCAL_MEDIA_LATE_FAILED");
    const progress = await call.query(token, api.retention.progress, {
      intentId: loser.intentId, secret: loser.secret, jobId: late.jobIds[0],
    });
    if (progress.state !== "pending" || progress.attempt !== 0 || progress.completedCount !== 0) throw new Error("LOCAL_MEDIA_DISABLED_PROGRESS_FAILED");
    const row = await call.query(token, api.tickets.getTicket, { id });
    if (row?.media.length !== 1 || row.media[0].key !== file.key) throw new Error("LOCAL_MEDIA_TICKET_FAILED");
    const customer = seeded.sessions[1];
    const customerFile = { ...file, key: `${file.key}-customer` };
    const customerIntent = await call.mutation(customer, api.uploads.createUploadIntent, { idempotencyKey: `${requestId}-customer`, files });
    const callbackToken = process.env.UPLOAD_CALLBACK_SECRET;
    if (!callbackToken) throw new Error("UPLOAD_CALLBACK_NOT_CONFIGURED");
    if (!await call.query(customer, api.uploads.validateUploadIntent, {
      callbackToken, intentId: customerIntent.intentId, secret: customerIntent.secret, files,
    })) throw new Error("LOCAL_MEDIA_PREFLIGHT_FAILED");
    await ctx.runMutation(api.uploads.recordUploadedFile, { callbackToken, intentId: customerIntent.intentId, secret: customerIntent.secret, file: customerFile });
    const customerId = await call.mutation(customer, api.tickets.createTicket, {
      ...input, requestId: `${requestId}-customer`, media: [customerFile],
      uploadIntentId: customerIntent.intentId, uploadIntentSecret: customerIntent.secret,
    });
    if ((await call.query(customer, api.tickets.getTicket, { id: customerId }))?.media[0].key !== customerFile.key) throw new Error("LOCAL_MEDIA_CUSTOMER_FAILED");
    return { ok: true, checks: ["concurrent exclusive key claims", "eight identical recording replays", "atomic attachment and create replay", "attached key takeover denied", "attached cancellation reserves nothing", "customer callback preflight and media Ticket", "staff late key rejected", "trusted late new upload reserved under pending job", "disabled cleanup exposes pending progress without provider attempts"] };
  },
});

/** P5 real search-engine validation; text-only fixtures and no provider I/O. */
export const reads = internalJobAction({
  name: "local_smoke:reads",
  args: {},
  handler: async (ctx): Promise<{ ok: true; checks: string[]; projects: { key: string; tickets: number }[]; searchOrder: string[]; thaiMatches: { search: string; titles: string[] }[]; firstPageDocuments: number; firstPageJsonBytes: number }> => {
    requireLocalFixtures();
    const call = as(ctx);
    const seeded = await ctx.runAction(internal.seed.run, { largeDataset: true });
    const token = seeded.sessions[0];
    // Exact relevance assertions need controlled matches, independent of prior
    // smoke runs or unrelated Tickets that could fill the bounded search window.
    const searchProject = await call.mutation(token, api.projects.createProject, {
      key: `S${crypto.randomUUID().replace(/-/g, "").slice(0, 9)}`, name: "Local search smoke",
    });
    await ctx.runMutation(internal.seed.largeBatch, { projectId: searchProject._id, sessions: seeded.sessions, start: 0 });
    const args = { projectId: searchProject._id, lifecycle: "active" as const, paginationOpts: { numItems: 20, cursor: null } };
    const matches = await call.query(token, api.tickets.searchTickets, { projectId: args.projectId, lifecycle: args.lifecycle, search: "quar" });
    const searchOrder = matches.matches.map(row => row.title);
    if (JSON.stringify(searchOrder) !== JSON.stringify(["quartz", "quartz calibration", "Printer calibration"])) throw new Error(`LOCAL_SEARCH_ORDER_FAILED:${JSON.stringify(searchOrder)}`);
    const owned = await call.query(seeded.sessions[1], api.tickets.searchTickets, { projectId: args.projectId, lifecycle: args.lifecycle, search: "quartz" });
    if (owned.matches.length !== 1 || owned.matches[0].title !== "Printer calibration") throw new Error("LOCAL_SEARCH_OWNER_FAILED");
    const foreign = await call.query(token, api.tickets.searchTickets, { projectId: args.projectId, lifecycle: args.lifecycle, search: "APP-0001" });
    if (foreign.matches.length) throw new Error("LOCAL_SEARCH_PROJECT_FAILED");
    const fragment = await call.query(token, api.tickets.searchTickets, { projectId: args.projectId, lifecycle: args.lifecycle, search: "uartz" });
    if (fragment.matches.length) throw new Error("LOCAL_SEARCH_FRAGMENT_FAILED");
    const thaiExamples = ["หน้าจอค้าง เมื่อกดปุ่มชำระเงิน ที่สาขาสีลม", "เครื่องพิมพ์ไม่ออกใบเสร็จ"];
    for (const title of [...thaiExamples, "HP-1020 printer"]) await call.mutation(token, api.tickets.createTextTicket, {
      projectKey: searchProject.key, requestId: crypto.randomUUID(), title, description: "",
    });
    const printer = await call.query(token, api.tickets.searchTickets, { projectId: args.projectId, lifecycle: args.lifecycle, search: "HP-1020" });
    if (printer.matches.length !== 1 || printer.matches[0].title !== "HP-1020 printer") throw new Error("LOCAL_REFERENCE_TEXT_FALLBACK_FAILED");
    const thaiMatches: { search: string; titles: string[] }[] = [];
    for (const search of [...thaiExamples, "หน้าจอ", "ค้าง", "หน้าจอค้าง", "เมื่อกดปุ่มชำระเงิน", "ชำระเงิน", "เครื่องพิมพ์", "ใบเสร็จ"]) {
      const result = await call.query(token, api.tickets.searchTickets, { projectId: args.projectId, lifecycle: args.lifecycle, search });
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
        const result: FunctionReturnType<typeof api.tickets.pageTickets> = await call.query(token, api.tickets.pageTickets, { ...args, projectId: project.id, paginationOpts: { numItems: 50, cursor } });
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
      const totals = await call.query(token, api.tickets.laneTotals, { projectId: project.id });
      if (Object.values(totals).reduce((a, b) => a + b, 0) !== count) throw new Error("LOCAL_TOTALS_FAILED");
      projects.push({ key: project.key, tickets: count });
    }
    const first = await call.query(token, api.tickets.pageTickets, { ...args, projectId: seeded.projects[0].id, status: "new" });
    return { ok: true, checks: ["relevance order differs from Ticket-number order", "owner and Project search scope", "prefix matches; middle fragment does not", "reference-shaped text falls back to indexed search", "Thai examples accepted with real token boundary matching", "all pages ordered without duplicates", "workflow totals independent of pages"], projects, searchOrder, thaiMatches, firstPageDocuments: first.page.length, firstPageJsonBytes: new TextEncoder().encode(JSON.stringify(first)).byteLength };
  },
});

export const pageStorage = internalJobQuery({
  name: "local_smoke:pageStorage",
  args: { pageId: v.id("ticketPages"), ids: v.array(v.id("_storage")) },
  handler: async (ctx, { pageId, ids }) => {
    requireLocalFixtures();
    return { row: await ctx.db.get(pageId), blobs: await Promise.all(ids.map(id => ctx.db.system.get(id))) };
  },
});

export const reconcilePage = internalJobMutation({
  name: "local_smoke:reconcilePage",
  args: { pageId: v.id("ticketPages") },
  handler: async (ctx, { pageId }) => { requireLocalFixtures(); await reconcilePageWrites(ctx, pageId); },
});

/**
 * Store-before-record interruption on the real local backend: storage metadata
 * keeps the private write marker, a same-key retry over HTTP adopts exactly that
 * blob, and an abandoned interruption becomes recorded, unreclaimed ownership.
 */
export const pages = internalJobAction({
  name: "local_smoke:pages",
  args: {},
  handler: async (ctx): Promise<{ ok: true; checks: string[] }> => {
    requireLocalFixtures();
    if (process.env.MEDIA_CLEANUP_ENABLED === "true") throw new Error("LOCAL_PAGES_REQUIRES_CLEANUP_DISABLED");
    const checks: string[] = [];
    const check = (value: unknown, name: string) => { if (!value) throw new Error(`Local page smoke failed: ${name}`); checks.push(name); };
    const seeded = await ctx.runAction(internal.seed.run, {});
    const call = as(ctx);
    // The HTTP route verifies a real Convex Auth JWT; internal steps run under its session.
    const signedIn = await ctx.runMutation(api.auth.signInLocalFixture, { email: "owner@local.test" });
    if (signedIn.status !== "complete") throw new Error("Local page smoke failed: fixture sign-in");
    const jwt = signedIn.tokens.accessToken;
    const session = accessTokenSessionId(jwt);
    const ticket = (await call.query(session, api.tickets.getTicket, { id: seeded.tickets[0] }))!;
    const ref = formatTicketNumber(ticket.ticketNumber, ticket.projectKey);
    const files: Record<string, string> = { "index.html": `<p>local ${crypto.randomUUID()}</p>`, "assets/site.css": "body{}" };
    const manifest = await Promise.all(Object.entries(files).map(async ([path, text]) => {
      const bytes = new TextEncoder().encode(text);
      return { path, size: bytes.byteLength, sha256: await sha256Hex(bytes) };
    }));
    async function interrupted(requestId: string) {
      const reserved = await call.mutation(session, internal.pages.reserve, { ticket: ref, requestId, entry: "index.html", manifest });
      if (reserved.state !== "staging") throw new Error("Local page smoke failed: staging reservation");
      const write = reserved.writes.find(item => item.path === "index.html")!;
      const orphan = await ctx.storage.store(new Blob([files["index.html"]], { type: write.contentType }));
      const unrelated = await ctx.storage.store(new Blob([files["index.html"]]));
      return { reserved, write, orphan, unrelated };
    }

    const requestId = crypto.randomUUID();
    const first = await interrupted(requestId);
    const stored = await ctx.runQuery(internal.local_smoke.pageStorage, { pageId: first.reserved.pageId, ids: [first.orphan, first.unrelated] });
    check(stored.blobs[0]?.contentType === first.write.contentType, "local storage metadata retains the private write marker");
    check(stored.blobs[0]?.sha256 === stored.blobs[1]?.sha256 && !stored.blobs[1]?.contentType, "unrelated blob has the same content and no marker");
    check(stored.row?.writes?.length === 2 && stored.row.files.length === 0, "writes are claimed before storage; nothing recorded");

    const site = process.env.CONVEX_SITE_URL!;
    const response = await fetch(`${site}/v1/tickets/${ref}/pages`, { method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "Idempotency-Key": requestId, "X-Ticket-Image-Policy": "v1" },
      body: pageFormData("index.html", Object.entries(files).map(([path, text]) => ({ path, blob: new Blob([text]) }))) });
    const page = await response.json() as { url: string; pageId: string };
    check(response.status === 201, "same-key retry over HTTP publishes");
    const adopted = await ctx.runQuery(internal.local_smoke.pageStorage, { pageId: first.reserved.pageId, ids: [first.orphan, first.unrelated] });
    const ids = adopted.row?.files.map(file => file.storageId) ?? [];
    check(ids.includes(first.orphan) && !ids.includes(first.unrelated) && adopted.row?.discarded.length === 0, "retry adopts exactly the interrupted blob");
    check(adopted.blobs.every(Boolean), "unrelated blob untouched");
    const served = await fetch(page.url);
    check(served.headers.get("content-type") === "text/html; charset=utf-8" && await served.text() === files["index.html"], "served type comes from the validated path");

    const second = await interrupted(crypto.randomUUID());
    await ctx.runMutation(internal.pages.abandon, { pageId: second.reserved.pageId });
    await ctx.runMutation(internal.local_smoke.reconcilePage, { pageId: second.reserved.pageId });
    await ctx.runMutation(internal.pages.reclaim, {});
    const abandoned = await ctx.runQuery(internal.local_smoke.pageStorage, { pageId: second.reserved.pageId, ids: [second.orphan, second.unrelated] });
    check(abandoned.row?.discarded.includes(second.orphan) && !abandoned.row.discarded.includes(second.unrelated), "abandoned interruption is recorded as owned");
    check(abandoned.blobs.every(Boolean), "cleanup disabled: no page blob deleted");

    await call.mutation(session, api.pages.revokeTicketPage, { pageId: page.pageId as Id<"ticketPages"> });
    check((await fetch(page.url)).status === 404, "revoked smoke page stops serving");
    return { ok: true, checks };
  },
});
