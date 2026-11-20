import { afterEach, expect, test, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { api, components, internal } from "../../convex/_generated/api";
import { accessTokenSessionId } from "../../convex/identity_rules";
import {
  approveRestoreValues, encryptRestorePassword, signRestoreAttestation, verifyRestoreValues,
} from "../../shared/identity-restore-crypto";
import { fixtures, identityTest } from "./identity-harness";

const origin = "http://127.0.0.1:3212";
const previous = "1".repeat(64);
const epoch = "2".repeat(64);
const manifestDigest = "3".repeat(64);
const verifierKey = "4".repeat(64);
const reviewerKey = "5".repeat(64);
const entryKey = "6".repeat(64);
const password = "historic synthetic password";
const newPassword = "customer private new password";
const verifierId = "operator.alpha";
const reviewerId = "operator.beta";

afterEach(() => vi.unstubAllEnvs());

function quarantine() {
  for (const [name, value] of Object.entries({
    CONVEX_CLOUD_URL: origin, TICKET_DEPLOYMENT_MODE: "named-pilot", TICKET_PILOT_PREVIOUS_EPOCH: previous,
    TICKET_PILOT_EPOCH: epoch, TICKET_PILOT_MANIFEST_SHA256: manifestDigest, TICKET_PILOT_TRAFFIC: "closed",
    TICKET_PILOT_INVITATIONS: "false", TICKET_PILOT_IDENTITY_SENDER: "false", MEDIA_CLEANUP_ENABLED: "false",
    IDENTITY_RESTORE_VERIFIER_ID: verifierId, IDENTITY_RESTORE_VERIFIER_KEY: verifierKey,
    IDENTITY_RESTORE_REVIEWER_ID: reviewerId, IDENTITY_RESTORE_REVIEWER_KEY: reviewerKey, IDENTITY_RESTORE_ENTRY_KEY: entryKey,
  })) vi.stubEnv(name, value);
}

test.each(["active", "disabled"] as const)("quarantine restores the %s customer without changing access or Ticket ownership", async status => {
  const t = identityTest();
  const owner = await t.mutation(fixtures.staff, {});
  const project = await t.mutation(api.projects.createProject, { token: owner.session, key: "POS", name: "Point of Sale" });
  const alice = await t.mutation(fixtures.customer, { username: "alice", password, projectIds: [project._id] });
  const bob = await t.mutation(fixtures.customer, { username: "bob", password, projectIds: [project._id] });
  const { ticket } = await t.mutation(api.tickets.createTextTicket, { token: alice.session, projectKey: "POS", requestId: "alice", title: "Alice Ticket", description: "" });
  const other = await t.mutation(api.tickets.createTextTicket, { token: bob.session, projectKey: "POS", requestId: "bob", title: "Bob Ticket", description: "" });
  const oldCode = await t.mutation(api.identity.createRecoveryCode, { token: alice.session });
  if (!oldCode.ok) throw new Error("saved code fixture");
  if (status === "disabled") {
    await t.mutation(api.identity.setCustomerAccess, { token: owner.session, customerId: alice.customerId, status });
  }
  const snapshot = await t.run(async ctx => ({
    customer: (await ctx.db.get(alice.customerId))!,
    releaseId: await ctx.db.insert("pilotRelease", { deploymentOrigin: origin, epoch: previous, manifestDigest, projectIds: [project._id] }),
  }));
  quarantine();

  const oldPasswordRpc = () => t.action(api.auth.signInWithPassword, { username: "alice", password });
  const oldSavedCodeRpc = () => t.mutation(api.auth.recoverWithCode, { username: "alice", recoveryCode: oldCode.code, newPassword });
  const refresh = (refreshToken: string) => t.mutation(api.auth.refreshSession, { refreshToken });
  const read = (token: string, id = ticket._id) => t.query(api.tickets.getTicket, { token, id });
  await expect(oldPasswordRpc()).rejects.toThrow("PILOT_UNAVAILABLE");
  await expect(oldSavedCodeRpc()).rejects.toThrow("PILOT_UNAVAILABLE");
  await expect(refresh(alice.refreshToken)).rejects.toThrow("PILOT_UNAVAILABLE");
  await expect(read(alice.session)).rejects.toThrow("PILOT_UNAVAILABLE");

  const claim = {
    epoch, requestId: "7".repeat(64), customerId: alice.customerId, userId: alice.userId,
    generation: snapshot.customer.generation, evidenceRef: "private-vault/restore-001", expiresAt: Date.now() + 1800_000,
  };
  async function verify(input = claim) {
    const signature = await signRestoreAttestation(verifierKey, verifyRestoreValues(origin, verifierId, input));
    return t.mutation(internal.identity_restore.verifyCustomer, { ...input, signature });
  }
  await expect(verify({ ...claim, epoch: previous })).rejects.toThrow("PILOT_STALE_AUTHORITY");
  await expect(verify({ ...claim, userId: bob.userId })).rejects.toThrow("RESTORE_CUSTOMER_MISMATCH");
  vi.stubEnv("IDENTITY_RESTORE_REVIEWER_ID", verifierId);
  await expect(verify()).rejects.toThrow("RESTORE_OPERATORS_UNAVAILABLE");
  vi.stubEnv("IDENTITY_RESTORE_REVIEWER_ID", reviewerId);
  const { caseId } = await verify();
  await expect(verify()).rejects.toThrow("RESTORE_CASE_REPLAY");
  await expect(t.query(internal.identity_restore.readReplacement, { caseId, epoch })).rejects.toThrow("RESTORE_APPROVAL_REQUIRED");

  const reviewed = await t.query(internal.identity_restore.readCaseForReview, { caseId, epoch });
  const approvalValues = approveRestoreValues(origin, reviewerId, reviewed);
  const selfApproval = await signRestoreAttestation(verifierKey, approvalValues);
  await expect(t.mutation(internal.identity_restore.approveReplacement, { caseId, epoch, signature: selfApproval }))
    .rejects.toThrow("RESTORE_ATTESTATION_REQUIRED");
  const signature = await signRestoreAttestation(reviewerKey, approvalValues);
  await t.mutation(internal.identity_restore.approveReplacement, { caseId, epoch, signature });
  await expect(t.mutation(internal.identity_restore.approveReplacement, { caseId, epoch, signature })).rejects.toThrow("RESTORE_CASE_REPLAY");

  const { binding } = await t.query(internal.identity_restore.readReplacement, { caseId, epoch });
  const correctEnvelope = await encryptRestorePassword(entryKey, binding, newPassword);
  const wrongEnvelope = await encryptRestorePassword(entryKey, { ...binding, customerId: bob.customerId }, newPassword);
  const replace = (envelope = correctEnvelope) => t.mutation(internal.identity_restore.replacePassword, { caseId, epoch, envelope });
  await expect(replace(wrongEnvelope)).rejects.toThrow("INVALID_RESTORE_CREDENTIAL");
  expect(await replace(await encryptRestorePassword(entryKey, binding, password))).toEqual({ success: false, error: "PASSWORD_REUSE" });

  const abort = makeFunctionReference<"mutation", { caseId: typeof caseId; epoch: string; envelope: typeof correctEnvelope }>("identityFixture:replaceThenAbort");
  await expect(t.mutation(abort, { caseId, epoch, envelope: correctEnvelope })).rejects.toThrow("FORCED_RESTORE_ROLLBACK");
  const unchanged = await t.run(async ctx => ({
    customer: await ctx.db.get(alice.customerId),
    row: await ctx.db.get(caseId),
    sessions: await ctx.runQuery(components.auth.public.listSessions, { userId: alice.userId }),
    oldPassword: await ctx.runMutation(components.authPassword.public.verifyPassword, { userId: alice.userId, password }),
  }));
  expect(unchanged.customer).toEqual(snapshot.customer);
  expect(unchanged.sessions).toHaveLength(status === "active" ? 1 : 0);
  expect(unchanged.oldPassword).toEqual({ success: true });
  expect(unchanged.row?.completedAt).toBeUndefined();

  const replay = await Promise.allSettled([replace(), replace()]);
  expect(replay.filter(result => result.status === "fulfilled")).toEqual([{ status: "fulfilled", value: { success: true, customerId: alice.customerId } }]);
  await expect(replace()).rejects.toThrow("RESTORE_CASE_UNAVAILABLE");
  expect(await t.run(async ctx => ({
    customer: await ctx.db.get(alice.customerId),
    ticket: await ctx.db.get(ticket._id),
    case: await ctx.db.get(caseId),
    audit: (await ctx.db.query("identityAudit").collect()).filter(row => row.restoreCaseId === caseId),
  }))).toMatchObject({
    customer: { status, userId: alice.userId, generation: snapshot.customer.generation + 1, credentialEpoch: epoch, recoveryEnrollmentRequired: true },
    ticket: { ownerCustomerId: alice.customerId },
    case: { verifierId, reviewerId, completedAt: expect.any(Number) },
    audit: [{ action: "customer_restore.verified" }, { action: "customer_restore.approved" }, { action: "customer_restore.replaced" }],
  });

  await t.run(ctx => ctx.db.patch(snapshot.releaseId, { epoch, previousEpoch: previous, ticketDisposalDeadline: Date.now() + 86_400_000 }));
  await expect(verify()).rejects.toThrow("IDENTITY_RESTORE_QUARANTINE_REQUIRED");
  vi.stubEnv("TICKET_PILOT_TRAFFIC", "open");
  await expect(verify()).rejects.toThrow("PILOT_MAINTENANCE_REQUIRED");
  expect(await oldPasswordRpc()).toMatchObject({ userError: { error: "INVALID_CREDENTIALS" } });
  expect(await oldSavedCodeRpc()).toEqual({ success: false, error: "RECOVERY_FAILED" });
  expect(await refresh(alice.refreshToken)).toEqual({ kind: "noSession" });
  expect(await refresh(bob.refreshToken)).toEqual({ kind: "noSession" });
  await expect(read(alice.session)).rejects.toThrow("SESSION_EXPIRED");
  expect(await t.action(api.auth.signInWithPassword, { username: "bob", password })).toMatchObject({ status: "error" });

  if (status === "disabled") {
    expect(await t.action(api.auth.signInWithPassword, { username: "alice", password: newPassword })).toMatchObject({ status: "error" });
    await t.run(ctx => ctx.db.patch(owner.staffId, { pilotEpoch: epoch }));
    const currentOwner = await t.mutation(fixtures.staff, {});
    await t.mutation(api.identity.setCustomerAccess, { token: currentOwner.session, customerId: alice.customerId, status: "active" });
  }
  const signedIn = await t.action(api.auth.signInWithPassword, { username: "alice", password: newPassword });
  if (signedIn.status !== "complete") throw new Error("fresh sign-in did not complete");
  const token = accessTokenSessionId(signedIn.tokens.accessToken);
  expect(await t.query(api.identity.viewer, { token })).toMatchObject({ customerId: alice.customerId, recoveryEnrollmentRequired: true, needsRecoveryCode: true });
  await expect(read(token)).rejects.toThrow("RECOVERY_ENROLLMENT_REQUIRED");
  const code = await t.mutation(api.identity.createRecoveryCode, { token });
  if (!code.ok) throw new Error("new recovery code unavailable");
  await expect(read(token)).rejects.toThrow("RECOVERY_ENROLLMENT_REQUIRED");
  expect(await t.mutation(api.identity.createRecoveryCode, { token })).toEqual({ ok: false, error: "PROOF_REQUIRED" });
  const replacement = await t.mutation(api.identity.createRecoveryCode, { token, currentPassword: newPassword });
  if (!replacement.ok) throw new Error("replacement recovery code unavailable");
  expect(await t.mutation(api.identity.confirmRecoveryEnrollment, { token, code: code.code })).toEqual({ ok: false, error: "RECOVERY_FAILED" });
  expect(await t.mutation(api.identity.confirmRecoveryEnrollment, { token, code: replacement.code })).toEqual({ ok: true });
  expect(await read(token)).toMatchObject({ _id: ticket._id });
  expect(await read(token, other.ticket._id)).toBeNull();
});
