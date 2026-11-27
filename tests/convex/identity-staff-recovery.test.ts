import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FunctionReference } from "convex/server";
import { api, components, internal } from "../../convex/_generated/api";
import { accessTokenSessionId, sha256Hex } from "../../convex/identity_rules";
import { staffGoogleChangeIntent } from "../../shared/staff-google-change";
import { pilotManifestDigest } from "../../shared/pilot-manifest";
import { firstEpoch, nextEpoch, pilotOrigin, pilotSettings, releaseEvidence, restorePlan } from "../fixtures/pilot";
import { fixtures, identityTest, type IdentityTest } from "./identity-harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("LOCAL_FIXTURES_ENABLED", "true");
  vi.stubEnv("IDENTITY_SENDER", "local");
  vi.stubEnv("IDENTITY_CODE_KEY", "test-only-identity-code-key-0123456789abcdef");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

/** Seed the output of a verified Google callback, then exercise real redemption and admission. */
async function googleProof(t: IdentityTest, state: string, sub: string, email: string) {
  await t.mutation(fixtures.recordFlow, { state });
  const createTicket = (components.authClerk as unknown as { provider: {
    createTicket: FunctionReference<"mutation", "internal", { providerName: string; ticketCodeHash: string; stateHash: string; encryptedPayload: string }, null>;
  } }).provider.createTicket;
  const code = crypto.randomUUID();
  const encode = new TextEncoder();
  const keyBytes = await crypto.subtle.digest("SHA-256", encode.encode(`convex-auth-ticket-payload:${code}`));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encode.encode(JSON.stringify({ claims: { sub: sub.replace(/^https:\/\/clerk\.invalid\|/, ""), email, email_verified: true } }));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  const encryptedPayload = Buffer.concat([iv, new Uint8Array(encrypted)]).toString("base64url");
  const ticketCodeHash = await sha256Hex(code);
  const stateHash = await sha256Hex(state);
  await t.run(ctx => ctx.runMutation(createTicket, { providerName: "clerk", ticketCodeHash, stateHash, encryptedPayload }));
  return () => t.mutation(api.auth.completeSignInWithClerk, { state, code });
}

async function signIn(t: IdentityTest, state: string, sub: string, email: string) {
  const complete = await googleProof(t, state, sub, email);
  const output = await complete() as { status: string; tokens?: { userId: string; accessToken: string; refreshToken: string } };
  if (output.status !== "complete" || !output.tokens) throw new Error("Google completion failed");
  return { ...output.tokens, session: accessTokenSessionId(output.tokens.accessToken) };
}

type BindingChange = Parameters<typeof staffGoogleChangeIntent>[0];
async function issue(t: IdentityTest, owner: { session: string; email: string }, change: BindingChange) {
  await t.action(api.identity.sendChallengeCode, {
    token: owner.session, purpose: "staff-google-binding", target: staffGoogleChangeIntent(change),
  });
  const delivery = await t.query(internal.identity.readLocalDelivery, { to: owner.email });
  if (!delivery) throw new Error("verification code missing");
  return delivery.code;
}

test("Owner proof binds a staff Google replacement and revocation to the exact verified account, role and generation", async () => {
  const t = identityTest();
  const authority = { email: "operator@fixture.test", ...await t.mutation(fixtures.staff, { email: "operator@fixture.test" }) };
  const originalEmail = "original@fixture.test";
  const member = await t.mutation(fixtures.staff, { email: originalEmail, role: "staff" });
  const originalSubject = `fixture-${originalEmail}`;
  const candidateEmail = "replacement@fixture.test";
  const candidate = await signIn(t, "pending", "replacement", candidateEmail);
  const beforeTransition = await googleProof(t, "before-transition", "replacement", candidateEmail);
  const change = {
    staffId: member.staffId, expectedGeneration: 1, expectedRole: "staff" as const, evidenceRef: "private-vault/staff-182",
    change: { kind: "replace" as const, replacement: { googleSubject: "https://clerk.invalid|replacement", verifiedEmail: candidateEmail } },
  };
  const code = await issue(t, authority, change);
  const replace = (token: string, input = change) => t.mutation(api.identity_staff_recovery.changeBinding, { ...input, token, proof: { code } });
  await expect(replace(member.session)).rejects.toThrow("OWNER_ONLY");
  expect(await replace(authority.session, { ...change, evidenceRef: "private-vault/other" })).toEqual({ ok: false, error: "PROOF_REQUIRED" });
  await t.run(ctx => ctx.db.patch(member.staffId, { role: "owner" }));
  await expect(replace(authority.session)).rejects.toThrow("STAFF_BINDING_CHANGED");
  await t.run(ctx => ctx.db.patch(member.staffId, { role: "staff" }));
  expect(await replace(authority.session)).toEqual({ ok: true });
  await expect(replace(authority.session)).rejects.toThrow("STAFF_BINDING_CHANGED");
  expect(await t.query(api.identity.viewer, { token: member.session })).toBeNull();
  expect(await t.query(api.identity.viewer, { token: candidate.session })).toBeNull();
  for (const refreshToken of [member.refreshToken, candidate.refreshToken]) {
    expect(await t.mutation(api.auth.refreshSession, { refreshToken })).toEqual({ kind: "noSession" });
  }
  await expect(beforeTransition()).rejects.toThrow("ACCESS_UNAVAILABLE");
  const previousSubjectSignIn = await googleProof(t, "old-identity", originalSubject, originalEmail);
  await expect(previousSubjectSignIn()).rejects.toThrow("ACCESS_UNAVAILABLE");
  vi.advanceTimersByTime(1);
  const fresh = await signIn(t, "new-identity", "replacement", candidateEmail);
  expect(await t.query(api.identity.viewer, { token: fresh.session })).toMatchObject({ kind: "staff", staffId: member.staffId, role: "staff" });

  const revocation = { ...change, expectedGeneration: 2, change: { kind: "revoke" as const } };
  const revokeCode = await issue(t, authority, revocation);
  expect(await t.mutation(api.identity_staff_recovery.changeBinding, { ...revocation, token: authority.session, proof: { code: revokeCode } }))
    .toEqual({ ok: true });
  expect(await t.query(api.identity.viewer, { token: fresh.session })).toBeNull();
  expect(await t.mutation(api.auth.refreshSession, { refreshToken: fresh.refreshToken })).toEqual({ kind: "noSession" });
  await t.action(api.identity.sendChallengeCode, { token: authority.session, purpose: "staff-enable", target: member.staffId });
  const enable = await t.query(internal.identity.readLocalDelivery, { to: authority.email });
  await expect(t.mutation(api.identity.setStaffAccess, { token: authority.session, staffId: member.staffId, status: "active", proof: { code: enable!.code } }))
    .rejects.toThrow("STAFF_BINDING_REVOKED");
  expect(await t.run(async ctx => (await ctx.db.query("identityAudit").collect()).filter(row => row.staffId === member.staffId))).toMatchObject([
    { action: "staff.google_replaced", actorStaffId: authority.staffId, previousUserId: member.userId, replacementUserId: candidate.userId },
    { action: "staff.google_revoked", actorStaffId: authority.staffId, previousUserId: candidate.userId },
  ]);
});

test("sole Owner cannot be revoked and the verified operator replacement keeps the durable Owner authorized after fresh Google sign-in", async () => {
  const t = identityTest();
  const authority = { email: "sole@fixture.test", ...await t.mutation(fixtures.staff, { email: "sole@fixture.test" }) };
  const change = {
    staffId: authority.staffId, expectedGeneration: 1, expectedRole: "owner" as const,
    change: { kind: "revoke" as const }, evidenceRef: "private-vault/owner-020",
  };
  const code = await issue(t, authority, change);
  await expect(t.mutation(api.identity_staff_recovery.changeBinding, { ...change, token: authority.session, proof: { code } }))
    .rejects.toThrow("LAST_OWNER");

  const replacement = { googleSubject: "https://clerk.invalid|replacement-owner", verifiedEmail: "new-owner@fixture.test" };
  const candidate = await signIn(t, "sole-owner-pending", replacement.googleSubject, replacement.verifiedEmail);
  const { staffId, expectedGeneration, evidenceRef } = change;
  const args = { staffId, expectedGeneration, replacement, evidenceRef };
  await expect(t.mutation(internal.identity_staff_recovery.replaceSoleOwner, args)).rejects.toThrow("OWNER_REPLACEMENT_NOT_AUTHORIZED");
  vi.stubEnv("OWNER_REPLACEMENT_STAFF_ID", authority.staffId);
  vi.stubEnv("OWNER_REPLACEMENT_GOOGLE_SUBJECT", replacement.googleSubject);
  await expect(t.mutation(internal.identity_staff_recovery.replaceSoleOwner, {
    ...args, replacement: { ...replacement, verifiedEmail: "incorrect@fixture.test" },
  })).rejects.toThrow("PENDING_IDENTITY_REQUIRED");
  await t.mutation(internal.identity_staff_recovery.replaceSoleOwner, args);
  await expect(t.mutation(internal.identity_staff_recovery.replaceSoleOwner, args)).rejects.toThrow("STAFF_BINDING_CHANGED");
  expect(await t.query(api.identity.viewer, { token: authority.session })).toBeNull();
  expect(await t.query(api.identity.viewer, { token: candidate.session })).toBeNull();
  vi.advanceTimersByTime(1);
  const fresh = await signIn(t, "sole-owner-new", replacement.googleSubject, replacement.verifiedEmail);
  expect(await t.query(api.identity.viewer, { token: fresh.session })).toMatchObject({ staffId, role: "owner" });
  expect(await t.query(api.identity.listTeam, { token: fresh.session })).toMatchObject({ staff: [{ staffId, role: "owner", generation: 2 }] });
});

test("concurrent revocations retain an authorized active Owner", async () => {
  const t = identityTest();
  const first = { email: "first@fixture.test", ...await t.mutation(fixtures.staff, { email: "first@fixture.test" }) };
  const second = { email: "second@fixture.test", ...await t.mutation(fixtures.staff, { email: "second@fixture.test" }) };
  const toRevoke = (staffId: typeof first.staffId) => ({
    staffId, expectedGeneration: 1, expectedRole: "owner" as const,
    change: { kind: "revoke" as const }, evidenceRef: "private-vault/incident-222",
  });
  const firstChange = toRevoke(second.staffId);
  const secondChange = toRevoke(first.staffId);
  const firstCode = await issue(t, first, firstChange);
  const secondCode = await issue(t, second, secondChange);
  const results = await Promise.allSettled([
    t.mutation(api.identity_staff_recovery.changeBinding, { ...firstChange, token: first.session, proof: { code: firstCode } }),
    t.mutation(api.identity_staff_recovery.changeBinding, { ...secondChange, token: second.session, proof: { code: secondCode } }),
  ]);
  expect(results.filter(result => result.status === "fulfilled")).toEqual([{ status: "fulfilled", value: { ok: true } }]);
  const live = await t.run(ctx => ctx.db.query("staff").withIndex("by_status_role", q => q.eq("status", "active").eq("role", "owner")).collect());
  expect(live).toHaveLength(1);
  const session = live[0]._id === first.staffId ? first.session : second.session;
  expect(await t.query(api.identity.viewer, { token: session })).toMatchObject({ kind: "staff", role: "owner" });
});

test("a partial pilot restore only counts current Owners with a usable Google binding", async () => {
  const t = identityTest();
  const owner = await t.mutation(fixtures.staff, { email: "current-owner@fixture.test" });
  const stale = await t.mutation(fixtures.staff, { email: "stale-owner@fixture.test" });
  const broken = await t.mutation(fixtures.staff, { email: "broken-owner@fixture.test" });
  const project = await t.mutation(api.projects.createProject, { token: owner.session, key: "POS", name: "Point of Sale" });
  const restoredManifest = JSON.stringify({
    ...releaseEvidence(project._id, nextEpoch),
    recovery: { plan: restorePlan, reconciledIdentityAndProjects: "fixture/reconciled", revokedAuthoritiesAndReenrollment: "fixture/revoked" },
  });
  const digest = await pilotManifestDigest(restoredManifest);
  await t.run(async ctx => {
    await ctx.db.insert("pilotRelease", {
      epoch: firstEpoch, projectIds: [project._id], manifestDigest: "3".repeat(64), deploymentOrigin: pilotOrigin,
    });
    for (const staff of [owner, stale, broken]) await ctx.db.patch(staff.staffId, { pilotEpoch: firstEpoch });
    // Reciprocal app rows that have no corresponding Google component account.
    await ctx.db.patch(broken.staffId, { googleSubject: "missing-google-account" });
    await ctx.db.patch(broken.userId, { googleSubject: "missing-google-account" });
  });
  for (const [key, value] of Object.entries(pilotSettings(nextEpoch, digest, firstEpoch))) vi.stubEnv(key, value ?? undefined);
  vi.stubEnv("CONVEX_CLOUD_URL", pilotOrigin);
  for (const staff of [owner, broken]) {
    await t.mutation(internal.identity.reconcilePilotPrincipal, { epoch: nextEpoch, staffId: staff.staffId });
  }
  await t.mutation(internal.pilot_release.install, { manifest: restoredManifest });
  vi.stubEnv("TICKET_PILOT_TRAFFIC", "open");
  vi.stubEnv("TICKET_PILOT_IDENTITY_SENDER", "true");

  vi.advanceTimersByTime(1);
  const token = (await signIn(t, "current-epoch-owner", "fixture-current-owner@fixture.test", "current-owner@fixture.test")).session;
  const auth = t.raw.withIdentity({ subject: token });
  const code = "12345678";
  const base = { token, staffId: owner.staffId, proof: { code } };
  const binding = { staffId: owner.staffId, expectedGeneration: 2, expectedRole: "owner" as const, evidenceRef: "fixture/owner-recovery" };
  const revocation = { ...binding, change: { kind: "revoke" as const } };
  await auth.mutation(internal.identity.issueChallenge, { purpose: "staff-disable", target: owner.staffId, code });
  await expect(t.mutation(api.identity.setStaffAccess, { ...base, status: "disabled" })).rejects.toThrow("LAST_OWNER");
  await auth.mutation(internal.identity.issueChallenge, { purpose: "staff-role", target: `${owner.staffId}:staff`, code });
  await expect(t.mutation(api.identity.setStaffRole, { ...base, role: "staff" })).rejects.toThrow("LAST_OWNER");
  await auth.mutation(internal.identity.issueChallenge, { purpose: "staff-google-binding", target: staffGoogleChangeIntent(revocation), code });
  await expect(t.mutation(api.identity_staff_recovery.changeBinding, { ...revocation, token, proof: { code } })).rejects.toThrow("LAST_OWNER");

  const replacement = { googleSubject: "https://clerk.invalid|current-owner-replacement", verifiedEmail: "replacement@fixture.test" };
  await signIn(t, "replacement-pending", replacement.googleSubject, replacement.verifiedEmail);
  vi.stubEnv("OWNER_REPLACEMENT_STAFF_ID", stale.staffId);
  vi.stubEnv("OWNER_REPLACEMENT_GOOGLE_SUBJECT", replacement.googleSubject);
  await expect(t.mutation(internal.identity_staff_recovery.replaceSoleOwner, {
    staffId: stale.staffId, expectedGeneration: 1, replacement, evidenceRef: binding.evidenceRef,
  })).rejects.toThrow("SOLE_OWNER_REQUIRED");
  vi.stubEnv("OWNER_REPLACEMENT_STAFF_ID", owner.staffId);
  expect(await t.mutation(internal.identity_staff_recovery.replaceSoleOwner, {
    staffId: owner.staffId, expectedGeneration: 2, replacement, evidenceRef: binding.evidenceRef,
  })).toEqual({ ok: true });
  vi.advanceTimersByTime(1);
  const fresh = await signIn(t, "replacement-current", replacement.googleSubject, replacement.verifiedEmail);
  expect(await t.query(api.identity.viewer, { token: fresh.session })).toMatchObject({ staffId: owner.staffId, role: "owner" });
});

test("a Clerk account needs a Project invitation, keeps its customer identity and cannot claim another Project", async () => {
  const t = identityTest();
  const owner = await t.mutation(fixtures.staff, { email: "owner@fixture.test" });
  const project = await t.mutation(api.projects.createProject, { token: owner.session, key: "POS", name: "Point of Sale" });
  await t.mutation(api.projects.createProject, { token: owner.session, key: "APP", name: "Customer App" });
  const invite = await t.mutation(api.identity.createCustomerInvitation, { token: owner.session, projectId: project._id, eligibilityConfirmed: true });
  const account = await signIn(t, "start-customer", "user_customer", "customer@fixture.test");
  const input = { username: "clerk_customer", displayName: "Customer" };
  await expect(t.mutation(api.identity.enrollClerkCustomer, { ...input, invitation: "unused", token: account.session })).rejects.toThrow("INVITE_NOT_FOUND");
  expect(await t.query(api.identity.viewer, { token: account.session })).toMatchObject({ kind: "pending" });
  await t.mutation(api.identity.enrollClerkCustomer, { ...input, invitation: invite.secret, token: account.session });
  const viewer = await t.query(api.identity.viewer, { token: account.session });
  expect(viewer).toMatchObject({ kind: "customer", clerkManaged: true, needsRecoveryCode: false });
  vi.advanceTimersByTime(1000);
  const returning = await signIn(t, "return-customer", "user_customer", "changed@fixture.test");
  expect(await t.query(api.identity.viewer, { token: returning.session })).toEqual(viewer);
  expect((await t.query(api.projects.listProjects, { token: returning.session })).map(p => p.key)).toEqual(["POS"]);
  await expect(t.mutation(api.identity.createRecoveryCode, { token: returning.session })).rejects.toThrow("ACCESS_UNAVAILABLE");
  const other = await signIn(t, "other-customer", "user_other", "changed@fixture.test");
  await expect(t.mutation(api.identity.enrollClerkCustomer, { ...input, username: "other_customer", invitation: invite.secret, token: other.session })).rejects.toThrow("INVITE_USED");
});
