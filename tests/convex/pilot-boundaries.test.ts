import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, components, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { requireCurrentPilotEpoch, requirePilotAdmission, activeDeploymentProject } from "../../convex/pilot_access";
import { customerInboxReader, inboxMembership } from "../../convex/domain/inbox";
import { createChallenge, customerCredentialSelector } from "../../convex/domain/identity";
import { ARCHIVE_RETENTION_MS, createMediaJob } from "../../convex/domain/media_jobs";
import { accessTokenSessionId } from "../../convex/identity_rules";
import { LOCAL_CUSTOMER_PASSWORD } from "../../convex/local_identity";
import { pilotManifestDigest } from "../../shared/pilot-manifest";
import { firstEpoch, nextEpoch, pilotOrigin, pilotSettings, releaseEvidence, restorePlan } from "../fixtures/pilot";
import { fixtures, identityTest } from "./identity-harness";
import { modules } from "./modules";

const storage = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../../convex/adapters/storage", () => ({ createStorage: storage.create }));

const file = { key: "synthetic-old-key", url: "https://media.invalid/old-object", name: "canary.png", type: "image/png", size: 10 };
const pending = { name: file.name, type: file.type, size: file.size };
const paging = { cursor: null, numItems: 10 };
beforeEach(() => {
  vi.stubEnv("CONVEX_CLOUD_URL", pilotOrigin);
  vi.stubEnv("LOCAL_FIXTURES_ENABLED", "true");
  vi.stubEnv("UPLOAD_CALLBACK_SECRET", "synthetic-old-callback");
  vi.stubEnv("MEDIA_CLEANUP_ENABLED", "false");
  storage.create.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

/**
 * Synthetic pre-pilot state from the disposable seed: named Owner, Alice and Bob
 * with legacy-mode sessions, legacy media on a historical Ticket and an
 * excluded Project. Pilot checks then run through the real named RPC.
 */
async function fixture() {
  const t = identityTest(modules);
  const seed = await t.mutation(internal.seed.install, {});
  const [staff, customer, other] = seed.sessions;
  const [projectId, otherProjectId] = seed.projects.map(project => project.id);
  const principals = await t.run(async ctx => ({
    owner: (await ctx.db.query("staff").withIndex("by_email", q => q.eq("email", "owner@local.test")).unique())!,
    alice: (await ctx.db.query("customers").withIndex("by_username", q => q.eq("username", "alice")).unique())!,
    bob: (await ctx.db.query("customers").withIndex("by_username", q => q.eq("username", "bob")).unique())!,
  }));
  const handle = await t.mutation(api.uploads.createUploadIntent, {
    token: customer, idempotencyKey: "previous-legitimate-upload", files: [pending, pending, pending],
  });
  const create = async (key: string, uploaded: typeof file, owner: string) => {
    const intent = await t.mutation(api.uploads.createUploadIntent, {
      token: owner, idempotencyKey: key, files: [pending],
    });
    await t.mutation(api.uploads.recordUploadedFile, {
      intentId: intent.intentId, secret: intent.secret, file: uploaded, callbackToken: "synthetic-old-callback",
    });
    return t.mutation(api.tickets.createTicket, {
      token: owner, projectId, title: "Synthetic historical Ticket", description: "Plain text",
      requestId: key, media: [uploaded], uploadIntentId: intent.intentId, uploadIntentSecret: intent.secret,
      annotations: [{ mediaIndex: 0, kind: "point", x: 0.5, y: 0.5, text: "hidden annotation canary" }],
    });
  };
  const id = await create("historical-ticket-request", file, customer);
  const excluded = await t.mutation(api.tickets.createTextTicket, {
    token: staff, projectKey: "APP", title: "Excluded Project canary", description: "", requestId: "excluded-ticket-request",
  });
  // Issued before the pilot: no epoch lineage.
  const oldInvitation = await t.mutation(api.identity.createCustomerInvitation, { eligibilityConfirmed: true, token: staff, projectId });
  await t.mutation(fixtures.recordFlow, { state: "pre-pilot-google-flow" });

  /** Operator reconciliation into the current epoch, with traffic closed. */
  const reconcile = async (epoch: string, restored = false) => {
    vi.stubEnv("TICKET_PILOT_TRAFFIC", "closed");
    await t.mutation(internal.identity.reconcilePilotPrincipal, { epoch, staffId: principals.owner._id });
    for (const customerId of [principals.alice._id, principals.bob._id]) {
      const operation = t.mutation(internal.identity.reconcilePilotPrincipal, { epoch, customerId });
      if (restored) await expect(operation).rejects.toThrow("CUSTOMER_REPLACEMENT_REQUIRED");
      else await operation;
    }
    vi.stubEnv("TICKET_PILOT_TRAFFIC", "open");
  };
  /** Fresh browser sign-ins: customer password and the Google completion seam for the Owner. */
  let flows = 0;
  const signIn = {
    customer: async (username: "alice" | "bob") => {
      const result = await t.action(api.auth.signInWithPassword, { username, password: LOCAL_CUSTOMER_PASSWORD });
      if (result.status !== "complete") throw new Error(`sign-in failed: ${JSON.stringify(result)}`);
      return accessTokenSessionId(result.tokens.accessToken);
    },
    owner: async () => {
      // Model a new browser sign-in after the last access transition, even on a fast test runner.
      const cutoff = await t.run(async ctx => (await ctx.db.get(principals.owner._id))!.validAfter);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Math.max(Date.now(), cutoff + 1_000));
      const state = `pilot-google-flow-${++flows}`;
      await t.mutation(fixtures.recordFlow, { state });
      return await t.mutation(fixtures.googleCompletion, { userId: principals.owner.userId, state });
    },
  };
  return {
    t, staff, customer, other, projectId, otherProjectId, id, excluded: excluded.ticket._id, handle, create,
    principals, oldInvitation, reconcile, signIn,
  };
}

async function confirmNewRecoveryCode(f: Awaited<ReturnType<typeof fixture>>, token: string) {
  const issued = await f.t.mutation(api.identity.createRecoveryCode, { token });
  if (!issued.ok) throw new Error(issued.error);
  expect(await f.t.mutation(api.identity.confirmRecoveryEnrollment, { token, code: issued.code })).toEqual({ ok: true });
  return issued;
}

async function configure(raw: string, epoch: string, previousEpoch?: string) {
  for (const [key, value] of Object.entries(pilotSettings(epoch, await pilotManifestDigest(raw), previousEpoch))) {
    vi.stubEnv(key, value ?? undefined);
  }
}

test("removed legacy auth, pre-pilot sessions, media RPC and callbacks cannot cross pilot entry boundaries", async () => {
  const f = await fixture();
  const originalCode = await confirmNewRecoveryCode(f, f.customer);
  const excludedInvitation = await f.t.mutation(api.identity.createCustomerInvitation, {
    eligibilityConfirmed: true, token: f.staff, projectId: f.otherProjectId,
  });
  const raw = JSON.stringify(releaseEvidence(f.projectId));
  await configure(raw, firstEpoch);
  expect(await f.t.query(api.uploads.legacyTransportAvailable, {})).toBe(false);
  // The shared staff password, public signup and raw-token session endpoints no longer exist.
  for (const name of ["auth:login", "auth:currentSession", "auth:logout", "customers:register", "customers:login"]) {
    await expect(f.t.mutation(makeFunctionReference<"mutation">(name), {})).rejects.toThrow();
  }
  // Closed traffic refuses every named entry point before any credential work.
  await expect(f.t.query(api.tickets.getTicket, { token: f.customer, id: f.id })).rejects.toThrow("PILOT_UNAVAILABLE");
  await expect(f.t.action(api.auth.signInWithPassword, { username: "alice", password: LOCAL_CUSTOMER_PASSWORD }))
    .rejects.toThrow("PILOT_UNAVAILABLE");
  expect(await f.t.query(api.identity.viewer, { token: f.staff })).toBeNull();
  const callback = { intentId: f.handle.intentId, secret: f.handle.secret, file: { ...file, key: "synthetic-late" } };
  for (const authority of [{ callbackToken: "synthetic-old-callback" }, { token: f.staff }]) {
    await expect(f.t.mutation(api.uploads.recordUploadedFile, { ...callback, ...authority })).rejects.toThrow("LEGACY_ACCESS_DISABLED");
  }
  await expect(f.t.mutation(internal.pilot_release.install, { manifest: raw + "\n" })).rejects.toThrow("PILOT_MANIFEST_MISMATCH");
  await f.t.mutation(internal.pilot_release.install, { manifest: raw });
  vi.stubEnv("TICKET_PILOT_TRAFFIC", "open");

  // Sessions and principals without current lineage stay out.
  for (const token of [f.customer, f.staff]) {
    await expect(f.t.query(api.tickets.getTicket, { token, id: f.id })).rejects.toThrow("SESSION_EXPIRED");
    await expect(f.t.mutation(api.uploads.createUploadIntent, { token, idempotencyKey: "synthetic-media-attempt", files: [pending] }))
      .rejects.toThrow("SESSION_EXPIRED");
  }
  expect(await f.t.query(api.identity.viewer, { token: f.staff })).toBeNull();
  await expect(f.signIn.customer("alice")).rejects.toThrow("INVALID_CREDENTIALS");
  await expect(f.signIn.owner()).rejects.toThrow("PILOT_STALE_AUTHORITY");
  await expect(f.t.mutation(fixtures.googleCompletion, { userId: f.principals.owner.userId, state: "pre-pilot-google-flow" }))
    .rejects.toThrow("SIGN_IN_RESTART_REQUIRED");

  await f.reconcile(firstEpoch);
  expect(await f.t.run(ctx => ctx.db.get(f.principals.alice._id))).toMatchObject({ pilotEpoch: firstEpoch, generation: 2 });
  const owner = await f.signIn.owner();
  const alice = await f.signIn.customer("alice");
  expect(await f.t.query(api.identity.viewer, { token: owner })).toMatchObject({ kind: "staff", role: "owner" });
  expect(await f.t.query(api.identity.viewer, { token: alice })).toMatchObject({ kind: "customer", needsRecoveryCode: true });
  await expect(f.t.query(api.tickets.getTicket, { token: alice, id: f.id })).rejects.toThrow("RECOVERY_ENROLLMENT_REQUIRED");
  await expect(f.t.mutation(api.identity.joinWithInvitation, { token: alice, invitation: excludedInvitation.secret }))
    .rejects.toThrow("RECOVERY_ENROLLMENT_REQUIRED");
  expect(await f.t.mutation(api.identity.confirmRecoveryEnrollment, { token: alice, code: originalCode.code }))
    .toEqual({ ok: false, error: "RECOVERY_FAILED" });
  await confirmNewRecoveryCode(f, alice);
  for (const token of [alice, owner]) {
    await expect(f.t.mutation(api.uploads.createUploadIntent, { token, idempotencyKey: "synthetic-media-attempt", files: [pending] }))
      .rejects.toThrow("PILOT_MEDIA_DISABLED");
    await expect(f.t.query(api.uploads.validateUploadIntent, {
      token, callbackToken: "synthetic-old-callback", intentId: f.handle.intentId, secret: f.handle.secret, files: [pending],
    })).rejects.toThrow("PILOT_MEDIA_DISABLED");
    expect(await f.t.query(api.pilot_release.ticketCapabilities, { token })).toEqual({ mediaEnabled: false });
  }
  await expect(f.t.mutation(api.uploads.recordUploadedFile, { ...callback, callbackToken: "synthetic-old-callback" }))
    .rejects.toThrow("LEGACY_ACCESS_DISABLED");
  await expect(f.t.mutation(api.uploads.recordUploadedFile, { ...callback, token: owner })).rejects.toThrow("LEGACY_ACCESS_DISABLED");
  await expect(f.t.mutation(api.projects.createProject, { token: owner, name: "Unreviewed", key: "NEW" })).rejects.toThrow("LEGACY_ACCESS_DISABLED");

  // Enrollment stays closed until both invitation and identity sender switches open.
  await expect(f.t.mutation(api.identity.createCustomerInvitation, { eligibilityConfirmed: true, token: owner, projectId: f.projectId }))
    .rejects.toThrow("PILOT_CAPABILITY_DISABLED");
  // The restricted sender's own switch refuses before any code is created or delivered.
  vi.stubEnv("IDENTITY_SENDER", "resend");
  vi.stubEnv("IDENTITY_CODE_KEY", "pilot-only-identity-code-key-0123456789abcdef");
  await expect(f.t.action(api.identity.sendChallengeCode, { token: owner, purpose: "staff-role", target: "x" }))
    .rejects.toThrow("PILOT_CAPABILITY_DISABLED");
  await expect(f.t.query(internal.pilot_release.checkAdmission, { capability: "invitation" }))
    .rejects.toThrow("PILOT_CAPABILITY_DISABLED");
  vi.stubEnv("TICKET_PILOT_INVITATIONS", "true");
  await expect(f.t.query(internal.pilot_release.checkAdmission, { capability: "browser" })).rejects.toThrow("PILOT_UNAVAILABLE");
  vi.stubEnv("TICKET_PILOT_IDENTITY_SENDER", "true");
  expect(await f.t.query(internal.pilot_release.checkAdmission, { capability: "invitation" })).toEqual({ epoch: firstEpoch });
  expect(await f.t.query(api.identity.previewCustomerInvitation, { invitation: f.oldInvitation.secret }))
    .toEqual({ status: "INVITE_NOT_FOUND" });
  await expect(f.t.mutation(api.identity.createCustomerInvitation, { eligibilityConfirmed: true, token: owner, projectId: f.otherProjectId }))
    .rejects.toThrow("PROJECT_NOT_FOUND");
  await expect(f.t.query(api.identity.listCustomerInvitations, { token: owner, projectId: f.otherProjectId })).rejects.toThrow("PROJECT_NOT_FOUND");
  await expect(f.t.mutation(api.identity.revokeCustomerInvitation, { token: owner, invitationId: excludedInvitation.invitationId })).rejects.toThrow("INVITE_NOT_FOUND");
  const invitation = await f.t.mutation(api.identity.createCustomerInvitation, { eligibilityConfirmed: true, token: owner, projectId: f.projectId });
  expect(await f.t.query(api.identity.listCustomerInvitations, { token: owner, projectId: f.projectId }))
    .toContainEqual(expect.objectContaining({ invitationId: invitation.invitationId }));
  expect(await f.t.query(api.identity.previewCustomerInvitation, { invitation: invitation.secret })).toMatchObject({ status: "ready", projectKey: "POS" });
  const enrollment = { username: "pilot_new", displayName: "Pilot New", password: "a fresh pilot passphrase" };
  await expect(f.t.mutation(api.auth.signUpWithInvitation, { ...enrollment, invitation: f.oldInvitation.secret }))
    .rejects.toThrow("PILOT_STALE_AUTHORITY");
  await expect(f.t.mutation(api.identity.joinWithInvitation, { token: alice, invitation: f.oldInvitation.secret }))
    .rejects.toThrow("PILOT_STALE_AUTHORITY");
  // Simulate membership and invitation lineage carried over for a Project outside the release.
  await f.t.run(async ctx => {
    await ctx.db.patch(excludedInvitation.invitationId, { pilotEpoch: firstEpoch });
    await ctx.db.insert("projectMembers", { projectId: f.otherProjectId, customerId: f.principals.alice._id, createdAt: Date.now() });
  });
  await expect(f.t.mutation(api.identity.joinWithInvitation, { token: alice, invitation: excludedInvitation.secret }))
    .rejects.toThrow("INVITE_NOT_FOUND");
  const joined = await f.t.mutation(api.auth.signUpWithInvitation, { ...enrollment, invitation: invitation.secret });
  expect(joined.status).toBe("complete");
  expect(await f.t.run(ctx => ctx.db.query("customers").withIndex("by_username", q => q.eq("username", "pilot_new")).unique()))
    .toMatchObject({ pilotEpoch: firstEpoch });

  // Accidentally pointing a legacy upload runtime at an installed pilot still
  // fails even if the backend has lost every environment pilot marker.
  for (const key of Object.keys(pilotSettings(firstEpoch, ""))) {
    if (key.startsWith("TICKET_PILOT_")) vi.stubEnv(key, undefined);
  }
  vi.stubEnv("TICKET_DEPLOYMENT_MODE", "legacy");
  expect(await f.t.query(api.uploads.legacyTransportAvailable, {})).toBe(false);
  await expect(f.t.query(api.tickets.getTicket, { token: owner, id: f.id })).rejects.toThrow("PILOT_UNAVAILABLE");
});

test("named Ticket operations redact old media and deny attachment writes for both roles", async () => {
  const f = await fixture();
  const raw = JSON.stringify(releaseEvidence(f.projectId));
  await configure(raw, firstEpoch);
  await f.t.mutation(internal.pilot_release.install, { manifest: raw });
  await f.reconcile(firstEpoch);
  const sessions = { staff: await f.signIn.owner(), customer: await f.signIn.customer("alice"), other: await f.signIn.customer("bob") };
  await confirmNewRecoveryCode(f, sessions.customer);
  await confirmNewRecoveryCode(f, sessions.other);
  const ticket = { id: f.id };
  const page = { projectId: f.projectId, lifecycle: "active" as const, paginationOpts: paging };
  for (const role of ["staff", "customer"] as const) {
    const token = sessions[role];
    expect(await f.t.query(api.tickets.getTicket, { token, ...ticket })).toMatchObject({ media: [], annotations: [] });
    expect(await f.t.query(api.tickets.getWorkspaceTicket, { token, projectId: f.projectId, ticket: f.id }))
      .toMatchObject({ media: [], annotations: [] });
    const activities = await f.t.query(api.tickets.listTicketActivity, { token, ...ticket });
    expect(activities.find(row => row.action === "created")?.after).toMatchObject({ mediaCount: 0, annotationCount: 0 });
    expect(activities.every(row => row.action !== "annotation_changed" && row.action !== "media_attached")).toBe(true);
    expect(await f.t.query(api.annotations.listAnnotationActivity, { token, ...ticket })).toEqual([]);
    expect((await f.t.query(api.tickets.pageTickets, { token, ...page })).page.find(row => row._id === f.id))
      .toMatchObject({ mediaCount: 0, annotationCount: 0 });
    expect((await f.t.query(api.tickets.searchTickets, { token, projectId: f.projectId, lifecycle: "active", search: "historical" })).matches)
      .toEqual([expect.objectContaining({ _id: f.id, mediaCount: 0, annotationCount: 0 })]);
    const input = { token, projectId: f.projectId, requestId: `new-text-${role}`, title: "Synthetic text only", description: "", media: [] };
    await expect(f.t.mutation(api.tickets.createTicket, { ...input, media: [file] })).rejects.toThrow("PILOT_MEDIA_DISABLED");
    await expect(f.t.mutation(api.tickets.createTicket, { ...input, uploadIntentId: f.handle.intentId, uploadIntentSecret: f.handle.secret }))
      .rejects.toThrow("PILOT_MEDIA_DISABLED");
    const id = await f.t.mutation(api.tickets.createTicket, input);
    expect(await f.t.mutation(api.tickets.createTicket, input)).toBe(id);
    expect(await f.t.run(ctx => ctx.db.get(id))).toMatchObject({ media: [], annotations: [] });
  }
  expect(await f.t.query(api.tickets.getTicket, { token: sessions.other, ...ticket })).toBeNull();
  expect(await f.t.query(api.tickets.getTicket, { token: sessions.staff, id: f.excluded })).toBeNull();
  await expect(f.t.query(api.tickets.pageTicketDetails, { token: sessions.staff, ...page, projectId: f.otherProjectId }))
    .rejects.toThrow("PROJECT_NOT_FOUND");
  expect((await f.t.query(api.projects.listProjects, { token: sessions.staff })).map(project => project.key)).toEqual(["POS"]);
  await f.t.run(async ctx => {
    const customerId = f.principals.alice._id;
    await ctx.db.insert("projectMembers", { projectId: f.otherProjectId, customerId, createdAt: Date.now() });
    expect(await inboxMembership(ctx, f.otherProjectId, customerId)).toBeNull();
    expect(await activeDeploymentProject(ctx, f.otherProjectId)).toBeNull();
    expect(await inboxMembership(ctx, f.projectId, customerId)).toBeTruthy();
  });
  expect((await f.t.query(api.projects.listProjects, { token: sessions.customer })).map(project => project.key)).toEqual(["POS"]);
  await expect(f.t.query(api.projects.listProjectMembers, { token: sessions.staff, projectId: f.otherProjectId })).rejects.toThrow("PROJECT_NOT_FOUND");
  const projections = [
    await f.t.query(api.tickets.pageTicketDetails, { token: sessions.staff, ...page }),
    await f.t.query(api.tickets.getTicketByTicketNumber, { token: sessions.staff, projectKey: "POS", ticketNumber: 4 }),
  ] as const;
  expect(projections[0].page.find(row => row._id === f.id)).toMatchObject({ media: [], annotations: [] });
  expect(projections[1]).toMatchObject({ media: [], annotations: [] });
  expect(JSON.stringify(projections)).not.toMatch(/synthetic-old-key|media.invalid|canary.png|hidden annotation/);
  await expect(f.t.mutation(api.tickets.attachTicketMedia, {
    token: sessions.staff, ...ticket, media: [file], uploadIntentId: f.handle.intentId, uploadIntentSecret: f.handle.secret,
    expectedVersion: 0, requestId: "old-intent-attach",
  })).rejects.toThrow("PILOT_MEDIA_DISABLED");
  await expect(f.t.mutation(api.annotations.addAnnotation, {
    token: sessions.customer, ...ticket, expectedVersion: 0, mediaIndex: 0, kind: "point", x: 0.5, y: 0.5, text: "new pin",
  })).rejects.toThrow("PILOT_MEDIA_DISABLED");
  expect(await f.t.run(ctx => ctx.db.get(f.id))).toMatchObject({ media: [file], annotations: [expect.objectContaining({ text: "hidden annotation canary" })] });
});

test("rehearses an older installed snapshot behind a rotated external epoch without reviving sessions, callbacks or cleanup", async () => {
  const f = await fixture();
  await f.t.mutation(api.tickets.archiveTicket, { token: f.customer, id: f.id, expectedVersion: 0 });
  await f.t.run(ctx => ctx.db.patch(f.id, { archivedAt: Date.now() - ARCHIVE_RETENTION_MS - 1 }));
  const purgeFile = { ...file, key: "synthetic-purge-key" };
  const purgeTarget = await f.create("historical-purge-request", purgeFile, f.customer);
  await f.t.mutation(api.tickets.archiveTicket, { token: f.customer, id: purgeTarget, expectedVersion: 0 });
  const purgeJob = await f.t.run(async ctx => {
    // Model the persisted state after an old purge claim, before provider work.
    const asset = (await ctx.db.query("mediaAssets").withIndex("by_key", q => q.eq("key", purgeFile.key)).unique())!;
    const job = await createMediaJob(ctx, {
      kind: "ticket_purge", resourceScope: `ticket:${purgeTarget}`, ticketId: purgeTarget, keys: [asset.key],
    });
    await ctx.db.patch(asset._id, { lifecycle: "deleting", jobId: job });
    await ctx.db.patch(purgeTarget, { lifecycle: "purging" });
    return { job, asset: asset._id };
  });
  const pendingFile = { ...file, key: "synthetic-pending" };
  const lateFile = { ...file, key: "synthetic-late" };
  await f.t.mutation(api.uploads.recordUploadedFile, {
    intentId: f.handle.intentId, secret: f.handle.secret, file: pendingFile, callbackToken: "synthetic-old-callback",
  });
  const cancelled = await f.t.mutation(api.uploads.cancelUploadIntent, {
    token: f.customer, intentId: f.handle.intentId, secret: f.handle.secret,
  });
  const jobId = cancelled.jobIds[0];
  const firstManifest = JSON.stringify(releaseEvidence(f.projectId));
  await configure(firstManifest, firstEpoch);
  await f.t.mutation(internal.pilot_release.install, { manifest: firstManifest });
  vi.stubEnv("TICKET_PILOT_TRAFFIC", "open");
  expect(await f.t.query(internal.pilot_release.checkAdmission, { capability: "browser" })).toEqual({ epoch: firstEpoch });
  await f.reconcile(firstEpoch);
  const firstOwner = await f.signIn.owner();
  const firstAlice = await f.signIn.customer("alice");
  const savedCode = await confirmNewRecoveryCode(f, firstAlice);
  expect(savedCode).toMatchObject({ ok: true });

  const routingTicket = await f.t.mutation(api.tickets.createTextTicket, {
    token: firstOwner, projectKey: "POS", requestId: "restore-proposal-ticket", title: "Printer", description: "",
  });
  const routeId = routingTicket.ticket._id;
  const area = { code: "hardware", en: "Hardware", th: "ฮาร์ดแวร์", meaning: "Equipment", active: true,
    primary: [String(f.principals.owner._id)], fallback: [] };
  await f.t.run(async ctx => {
    await ctx.db.insert("ticketRoutingPolicies", { projectId: f.projectId, policyGeneration: 1, ruleRevision: 1,
      areas: [area], products: [{ code: "printer", en: "Printer", th: "เครื่องพิมพ์", meaning: "Printer" }],
      symptoms: [{ code: "blank", en: "Blank", th: "ว่าง", meaning: "Blank" }], intake: [],
      rules: [{ product: "printer", symptom: "blank", area: "hardware" }] });
    await ctx.db.patch(routeId, { routingClassification: { product: "printer", symptom: "blank",
      restricted: false, reviewed: true } });
  });
  const ruleInput = { ticketId: routeId, expectedVersion: 0, requestId: "snapshot-proposal" };
  const proposal = await f.t.mutation(api.ticket_routing.checkRule, { token: firstOwner, ...ruleInput });
  expect(proposal.status).toBe("pending");
  const suggestionId = proposal.id!;
  const pending = await f.t.run(ctx => ctx.db.get(suggestionId));
  await f.t.mutation(api.ticket_routing.reviewSuggestion, { token: firstOwner, suggestionId, decision: "dismiss" });
  // Model the backed-up pending row on this disposable fixture.
  await f.t.run(ctx => ctx.db.patch(suggestionId, { status: pending!.status, reviewer: undefined }));

  const restored = JSON.stringify({
    ...releaseEvidence(f.projectId, nextEpoch),
    recovery: { plan: restorePlan, reconciledIdentityAndProjects: "synthetic/reconciled", revokedAuthoritiesAndReenrollment: "synthetic/revocations" },
  });
  // Leave the first release row, its sessions and the old job in place as the synthetic snapshot state.
  await configure(restored, nextEpoch, firstEpoch);
  vi.stubEnv("TICKET_PILOT_TRAFFIC", "open");
  await expect(f.t.query(internal.pilot_release.checkAdmission, { capability: "browser" })).rejects.toThrow("PILOT_UNAVAILABLE");
  vi.stubEnv("TICKET_PILOT_TRAFFIC", "closed");
  const late = { intentId: f.handle.intentId, intentSecret: f.handle.secret, file: lateFile };
  await expect(f.t.mutation(api.uploads.recordUploadedFile, {
    intentId: late.intentId, secret: late.intentSecret, file: lateFile, callbackToken: "synthetic-old-callback",
  })).rejects.toThrow("LEGACY_ACCESS_DISABLED");
  await expect(f.t.mutation(internal.uploads.reconcileLateCallback, { ...late, epoch: firstEpoch })).rejects.toThrow("PILOT_STALE_AUTHORITY");
  const reconciled = await f.t.mutation(internal.uploads.reconcileLateCallback, { ...late, epoch: nextEpoch });
  expect(reconciled).toMatchObject({ state: "queued" });
  expect(await f.t.mutation(internal.uploads.reconcileLateCallback, { ...late, epoch: nextEpoch })).toEqual(reconciled);
  expect(await f.t.run(ctx => ctx.db.get(f.handle.intentId))).toMatchObject({ status: "cancelled", uploadedFiles: [pendingFile] });
  await expect(f.t.mutation(internal.identity.reconcilePilotPrincipal, { epoch: firstEpoch, customerId: f.principals.alice._id }))
    .rejects.toThrow("PILOT_STALE_AUTHORITY");

  await f.t.action(internal.media_job_actions.run, { jobId });
  await f.t.action(internal.media_job_actions.run, { jobId: purgeJob.job });
  expect(await f.t.mutation(internal.retention.claimPurges, {})).toBe(0);
  expect(await f.t.mutation(internal.retention.expireIntents, {})).toBe(0);
  expect(await f.t.mutation(internal.retention.recover, {})).toBe(0);
  expect(await f.t.run(ctx => ctx.db.get(jobId))).toMatchObject({ state: "pending", attempt: 0, keys: [pendingFile.key] });
  expect(await f.t.run(ctx => ctx.db.get(purgeJob.job))).toMatchObject({ state: "pending", attempt: 0, keys: [purgeFile.key] });
  expect(await f.t.run(ctx => ctx.db.get(purgeJob.asset))).toMatchObject({ lifecycle: "deleting", jobId: purgeJob.job });
  expect(storage.create).not.toHaveBeenCalled();
  await f.t.mutation(internal.pilot_release.install, { manifest: restored });
  vi.stubEnv("TICKET_PILOT_TRAFFIC", "open");
  expect(await f.t.query(internal.pilot_release.checkAdmission, { capability: "browser" })).toEqual({ epoch: nextEpoch });
  for (const oldEpoch of [undefined, firstEpoch]) {
    await expect(f.t.run(async ctx => requireCurrentPilotEpoch(oldEpoch, (await requirePilotAdmission(ctx)).epoch)))
      .rejects.toThrow("PILOT_STALE_AUTHORITY");
  }
  // Sessions, principals and saved codes from the restored epoch cannot act until reconciled again.
  for (const token of [firstOwner, firstAlice]) {
    await expect(f.t.query(api.projects.listProjects, { token })).rejects.toThrow("SESSION_EXPIRED");
  }
  await expect(f.signIn.customer("alice")).rejects.toThrow("INVALID_CREDENTIALS");
  const recover = { username: "alice", recoveryCode: savedCode.ok ? savedCode.code : "", newPassword: "a replaced pilot passphrase" };
  expect(await f.t.mutation(api.auth.recoverWithCode, recover)).toEqual({ success: false, error: "RECOVERY_FAILED" });
  await f.reconcile(nextEpoch, true);
  expect(await f.t.mutation(api.auth.recoverWithCode, recover)).toEqual({ success: false, error: "RECOVERY_FAILED" });
  for (const token of [firstOwner, firstAlice]) {
    await expect(f.t.query(api.projects.listProjects, { token })).rejects.toThrow("SESSION_EXPIRED");
  }
  const owner = await f.signIn.owner();
  await expect(f.signIn.customer("alice")).rejects.toThrow("INVALID_CREDENTIALS");
  expect(await f.t.mutation(api.ticket_routing.checkRule, { token: owner, ...ruleInput })).toMatchObject({ status: "stale" });
  expect(await f.t.mutation(api.ticket_routing.reviewSuggestion, { token: owner, suggestionId, decision: "accept" })).toEqual({ status: "stale" });
  const restoredSettings = await f.t.query(api.ticket_routing.getSettings, { token: owner, projectId: f.projectId });
  const policy = restoredSettings!.policy;
  const save = (expectedEpoch: string) => f.t.mutation(api.ticket_routing.saveConfiguration, {
    token: owner, projectId: f.projectId, expectedGeneration: policy.policyGeneration, expectedEpoch,
    areas: policy.areas, products: policy.products, symptoms: policy.symptoms, rules: policy.rules,
    intake: policy.intake, backup: policy.backup ?? "",
  });
  await expect(save(firstEpoch)).rejects.toThrow("STALE_ROUTING_POLICY");
  const fresh = await f.t.mutation(api.ticket_routing.checkRule, { token: owner, ...ruleInput, requestId: "after-restore" });
  expect(fresh.status).toBe("pending");
  expect(fresh.id).not.toBe(suggestionId);
  expect(await f.t.mutation(api.ticket_routing.reviewSuggestion, { token: owner, suggestionId: fresh.id!, decision: "accept" })).toMatchObject({ status: "accepted" });

  vi.stubEnv("TICKET_PILOT_TRAFFIC", "closed");
  await expect(f.t.mutation(internal.uploads.reconcileLateCallback, { ...late, epoch: nextEpoch })).resolves.toEqual(reconciled);
  vi.stubEnv("TICKET_PILOT_TRAFFIC", "open");
  await expect(f.t.mutation(internal.uploads.reconcileLateCallback, { ...late, epoch: nextEpoch })).rejects.toThrow("PILOT_MAINTENANCE_REQUIRED");
  vi.stubEnv("MEDIA_CLEANUP_ENABLED", "true");
  await f.t.action(internal.media_job_actions.run, { jobId });
  expect(storage.create).not.toHaveBeenCalled();
  expect(await f.t.mutation(internal.retention.claimPurges, {})).toBe(0);
  expect(await f.t.mutation(internal.retention.recover, {})).toBe(0);
  await expect(f.t.query(internal.pilot_release.checkAdmission, { capability: "browser" })).rejects.toThrow("PILOT_UNAVAILABLE");
  vi.stubEnv("MEDIA_CLEANUP_ENABLED", "false");
  await f.t.mutation(api.tickets.restoreTicket, { token: owner, id: f.id, expectedVersion: 1 });
  expect(await f.t.run(ctx => ctx.db.get(f.id))).toMatchObject({ lifecycle: "active", media: [file] });
  vi.stubEnv("TICKET_PILOT_MANIFEST_SHA256", undefined);
  await expect(f.t.query(internal.pilot_release.checkAdmission, { capability: "browser" })).rejects.toThrow("PILOT_UNAVAILABLE");
  await expect(f.t.query(api.tickets.getTicket, { token: owner, id: f.id })).rejects.toThrow("PILOT_UNAVAILABLE");
  void (f.id satisfies Id<"tickets">);
});

test("inbox items restored from a snapshot stay hidden in the new epoch even when visibility counters match", async () => {
  const f = await fixture();
  const firstManifest = JSON.stringify(releaseEvidence(f.projectId));
  await configure(firstManifest, firstEpoch);
  await f.t.mutation(internal.pilot_release.install, { manifest: firstManifest });
  vi.stubEnv("TICKET_PILOT_TRAFFIC", "open");
  await f.reconcile(firstEpoch);
  let owner = await f.signIn.owner();
  await f.t.run(ctx => ctx.db.insert("projectIntakeStaff", { projectId: f.projectId, staffId: String(f.principals.owner._id) }));
  const staffItems = async (token: string) => (await f.t.query(api.staff_inbox.page, { token, projectId: f.projectId, paginationOpts: paging })).page;
  const intake = (requestId: string, title: string) =>
    f.t.mutation(api.tickets.createTextTicket, { token: owner, projectKey: "POS", requestId, title, description: "" });
  await intake("pre-restore-intake", "Before restore");
  const [before] = await staffItems(owner);
  expect(before).toMatchObject({ category: "intake", title: "Before restore" });
  await f.t.mutation(api.tickets.updateTicketStatus, { token: owner, id: f.id, expectedVersion: 0, status: "acknowledged" });
  const customerRow = (await f.t.run(ctx => ctx.db.query("customerInbox").order("desc").first()))!;
  expect(customerRow).toMatchObject({ ticketId: f.id, pilotEpoch: firstEpoch });

  // The rows stay as the synthetic snapshot state; no Project, Ticket or preference counter moves.
  const restored = JSON.stringify({
    ...releaseEvidence(f.projectId, nextEpoch),
    recovery: { plan: restorePlan, reconciledIdentityAndProjects: "synthetic/reconciled", revokedAuthoritiesAndReenrollment: "synthetic/revocations" },
  });
  await configure(restored, nextEpoch, firstEpoch);
  await f.t.mutation(internal.pilot_release.install, { manifest: restored });
  vi.stubEnv("TICKET_PILOT_TRAFFIC", "open");
  await f.reconcile(nextEpoch, true);
  owner = await f.signIn.owner();
  expect(await staffItems(owner)).toEqual([]);
  expect(await f.t.mutation(api.staff_inbox.markRead, { token: owner, id: before.id })).toBe(false);
  // Restored customers need a credential replacement before signing in; check their projection directly.
  expect(await f.t.run(async ctx => (await customerInboxReader(ctx, (await ctx.db.get(customerRow.memberId))!))(customerRow))).toBeNull();
  await intake("post-restore-intake", "After restore");
  expect(await staffItems(owner)).toMatchObject([{ title: "After restore" }]);
});

test("inbox and identity expiry need the matching approved release, open traffic, no quarantine and no operator hold", async () => {
  const f = await fixture();
  const raw = JSON.stringify(releaseEvidence(f.projectId));
  const hour = 3_600_000, day = 24 * hour;
  const expireAll = () => f.t.mutation(internal.pilot_retention.expire, {});
  const start = Date.now();
  const staffRow = (ticketId: Id<"tickets">) => ({ projectId: f.projectId, staffId: String(f.principals.owner._id), ticketId, category: "intake" as const, visibilityVersion: 0 });
  // Creation times only move forward, so age the inbox rows by advancing the clock.
  const inbox = await f.t.run(async ctx => {
    const member = (await ctx.db.query("projectMembers").withIndex("by_project", q =>
      q.eq("projectId", f.projectId).eq("customerId", f.principals.alice._id)).unique())!;
    const event = (await ctx.db.query("ticketEvents").first())!;
    return {
      customer: await ctx.db.insert("customerInbox", { memberId: member._id, customerId: member.customerId, projectId: f.projectId,
        ticketId: f.id, eventId: event._id, status: "new", visibilityVersion: 0, restored: false }),
      staff: await ctx.db.insert("staffInbox", staffRow(f.id)),
    };
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(start + 2 * day);
  const recentInbox = await f.t.run(ctx => ctx.db.insert("staffInbox", staffRow(f.id)));
  const now = start + 31 * day;
  vi.setSystemTime(now);
  const ids = await f.t.run(async ctx => {
    const admission = (await ctx.db.query("sessionAdmissions").first())!;
    const challenge = (age: number) => ctx.db.insert("identityChallenges", { admissionId: admission._id, purpose: "staff-role",
      intentDigest: "synthetic", codeDigest: "synthetic", failedAttempts: 0, createdAt: now - age, expiresAt: now - age + 5 * 60_000 });
    return {
      admission: admission._id,
      oldChallenge: await challenge(25 * hour), expiredChallenge: await challenge(2 * hour),
      stale: await ctx.db.insert("identityAudit", { action: "synthetic", createdAt: now - 91 * day }),
      fresh: await ctx.db.insert("identityAudit", { action: "synthetic", createdAt: now - 89 * day }),
      attempt: await ctx.db.insert("identityAttempts", { key: "synthetic", attempts: 1, firstAttemptAt: now - 31 * day, updatedAt: now - 31 * day }),
      invite: await ctx.db.insert("staffInvitations", { email: "old@fixture.test", createdByStaffId: f.principals.owner._id, status: "pending",
        expiresAt: now - 31 * day, createdAt: now - 35 * day, updatedAt: now - 35 * day, role: "staff", secretDigest: "expired" }),
    };
  });
  const selector = await customerCredentialSelector("retentionfixture");
  for (let i = 0; i < 5; i++) {
    await f.t.action(api.auth.signInWithPassword, { username: "retentionfixture", password: "fixture password guess" });
  }
  // Freeze the component bucket at exhaustion and age only its last-activity index.
  await f.t.run(async ctx => {
    const marker = await ctx.db.query("identityAttempts").withIndex("by_key", q => q.eq("key", selector)).unique();
    await ctx.db.patch(marker!._id, { updatedAt: Date.now() - 31 * day });
  });
  const reserveSelector = () => f.t.run(ctx => ctx.runMutation(components.authPassword.public.reserveVerification, { rateLimitKey: selector }));
  // Issuing a new challenge never deletes earlier records outside the approved job.
  vi.stubEnv("IDENTITY_CODE_KEY", "pilot-only-identity-code-key-0123456789abcdef");
  await f.t.run(async ctx => createChallenge(ctx, (await ctx.db.get(ids.admission))!, "staff-disable", "synthetic", "123456"));
  expect(await f.t.run(ctx => ctx.db.get(ids.oldChallenge))).not.toBeNull();

  // Disposable/legacy deployments have no approval.
  expect(await expireAll()).toBe(0);
  await configure(raw, firstEpoch);
  await f.t.mutation(internal.pilot_release.install, { manifest: raw });
  expect(await expireAll()).toBe(0);
  vi.stubEnv("TICKET_PILOT_TRAFFIC", "open");
  for (const hold of ["true", "incident-2026-11"]) {
    vi.stubEnv("TICKET_RETENTION_HOLD", hold);
    expect(await expireAll()).toBe(0);
  }
  vi.stubEnv("TICKET_RETENTION_HOLD", "false");
  // A release row without approved periods (an earlier build) stays closed.
  const release = (await f.t.run(ctx => ctx.db.query("pilotRelease").unique()))!;
  expect(release.retention).toEqual({ challengeHours: 24, invitationDays: 30, attemptDays: 30, auditDays: 90, inboxDays: 30 });
  await f.t.run(ctx => ctx.db.patch(release._id, { retention: undefined, identityRetentionApproved: true }));
  expect(await expireAll()).toBe(0);
  await f.t.run(ctx => ctx.db.patch(release._id, { retention: release.retention }));
  // Restore quarantine: outside settings rotated before the reviewed release is installed.
  await configure(raw, nextEpoch, firstEpoch);
  vi.stubEnv("TICKET_PILOT_TRAFFIC", "open");
  expect(await expireAll()).toBe(0);
  await configure(raw, firstEpoch);
  vi.stubEnv("TICKET_PILOT_TRAFFIC", "open");

  expect(await reserveSelector()).toBeNull();
  await expireAll();
  expect(await reserveSelector()).toEqual({});
  const rows = await f.t.run(ctx => Promise.all([inbox.customer, inbox.staff, recentInbox, ids.oldChallenge, ids.expiredChallenge,
    ids.stale, ids.fresh, ids.attempt, ids.invite].map(id => ctx.db.get(id))));
  expect(rows.map(row => row !== null)).toEqual([false, false, true, false, true, false, true, false, false]);
});

test("full retention batches continue until drained and recheck the operator hold between passes", async () => {
  const f = await fixture();
  vi.useFakeTimers();
  const day = 86_400_000;
  const start = Date.now();
  await f.t.run(async ctx => {
    for (let i = 0; i < 132; i++) {
      await ctx.db.insert("identityAttempts", { key: `backlog-${i}`, attempts: 1, firstAttemptAt: start, updatedAt: start });
    }
    for (let i = 0; i < 514; i++) {
      await ctx.db.insert("staffInbox", { staffId: String(f.principals.owner._id), projectId: f.projectId,
        ticketId: f.id, category: "intake", visibilityVersion: 0 });
    }
  });
  vi.setSystemTime(start + 31 * day);
  const raw = JSON.stringify(releaseEvidence(f.projectId));
  await configure(raw, firstEpoch);
  await f.t.mutation(internal.pilot_release.install, { manifest: raw });
  vi.stubEnv("TICKET_PILOT_TRAFFIC", "open");
  const counts = () => f.t.run(async ctx => ({
    attempts: (await ctx.db.query("identityAttempts").collect()).filter(row => row.key.startsWith("backlog-")).length,
    inbox: (await ctx.db.query("staffInbox").collect()).length,
  }));
  const runExpiry = () => f.t.mutation(internal.pilot_retention.expire, {});
  await runExpiry();
  const afterFirst = await counts();
  expect(afterFirst.attempts).toBeGreaterThanOrEqual(68);
  expect(afterFirst.attempts).toBeLessThan(132);
  expect(afterFirst.inbox).toBe(450);
  vi.stubEnv("TICKET_RETENTION_HOLD", "true");
  await f.t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await counts()).toEqual(afterFirst);
  vi.stubEnv("TICKET_RETENTION_HOLD", "false");
  await runExpiry();
  await f.t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await counts()).toEqual({ attempts: 0, inbox: 0 });
});

test("pilot admission ends at the controller's Ticket disposal deadline", async () => {
  const f = await fixture();
  vi.useFakeTimers({ toFake: ["Date"] });
  const now = Date.now();
  const evidence = releaseEvidence(f.projectId);
  const install = async (ticketDisposal: unknown) => {
    const manifest = JSON.stringify({ ...evidence, ticketDisposal });
    await configure(manifest, firstEpoch);
    return f.t.mutation(internal.pilot_release.install, { manifest });
  };
  await expect(install(undefined)).rejects.toThrow("PILOT_MANIFEST_INVALID");
  await expect(install({ ...evidence.ticketDisposal, deadline: now })).rejects.toThrow("PILOT_MANIFEST_INVALID");
  await install({ ...evidence.ticketDisposal, deadline: now + 60_000 });
  vi.stubEnv("TICKET_PILOT_TRAFFIC", "open");
  const admit = () => f.t.query(internal.pilot_release.checkAdmission, { capability: "browser" });
  expect(await admit()).toEqual({ epoch: firstEpoch });
  vi.setSystemTime(now + 60_000);
  await expect(admit()).rejects.toThrow("PILOT_UNAVAILABLE");
});
