import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, components, internal } from "../../convex/_generated/api";
import { customerCredentialSelector, recoveryAttemptKey } from "../../convex/domain/identity";
import { accessTokenSessionId } from "../../convex/identity_rules";
import { staffInvitationIntent } from "../../shared/staff-invitation-intent";
import * as argon2 from "./fixtures/argon2-stub";
import { fixtures, identityTest, whoami, type IdentityTest } from "./identity-harness";

beforeEach(() => {
  vi.stubEnv("LOCAL_FIXTURES_ENABLED", "true");
  vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3212");
  vi.stubEnv("IDENTITY_SENDER", "local");
  vi.stubEnv("IDENTITY_CODE_KEY", "test-only-identity-code-key-0123456789abcdef");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const PASSWORD = "correct horse battery staple";
const INVALID_CREDENTIALS = { status: "error", userError: { error: "INVALID_CREDENTIALS" } };
const session = (result: { status: string; tokens?: { accessToken: string } }) => {
  if (result.status !== "complete" || !result.tokens) throw new Error(`expected a session: ${JSON.stringify(result)}`);
  return accessTokenSessionId(result.tokens.accessToken);
};

async function world() {
  const t = identityTest();
  const owner = await t.mutation(fixtures.staff, { email: "owner@fixture.test", role: "owner" });
  const pos = await t.mutation(api.projects.createProject, { token: owner.session, key: "POS", name: "Point of Sale" });
  const app = await t.mutation(api.projects.createProject, { token: owner.session, key: "APP", name: "Customer App" });
  const invite = async (projectId = pos._id) => (await t.mutation(api.identity.createCustomerInvitation, { eligibilityConfirmed: true, token: owner.session, projectId })).secret;
  const enroll = async (username: string, password = PASSWORD, projectId = pos._id) =>
    await t.mutation(api.auth.signUpWithInvitation, { invitation: await invite(projectId), username, displayName: username, password });
  return { t, owner, pos, app, invite, enroll };
}

async function sessionCount(t: IdentityTest, userId: string) {
  return (await t.run(ctx => ctx.runQuery(components.auth.public.listSessions, { userId }))).length;
}

function pauseNextPasswordVerification() {
  let begin!: () => void;
  const started = new Promise<void>(resolve => { begin = resolve; });
  let release!: () => void;
  const resume = new Promise<void>(resolve => { release = resolve; });
  const verifyPassword = argon2.verifyPassword;
  const verify = vi.spyOn(argon2, "verifyPassword").mockImplementationOnce(async (...args) => {
    begin();
    await resume;
    return await verifyPassword(...args);
  });
  return { started, release, verify };
}

async function beforeVerificationFinishes<T>(result: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("The other operation must finish while verification is pending")), 5_000);
    });
    return await Promise.race([result, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function saveRecoveryCode(t: IdentityTest, token: string) {
  const issued = await t.mutation(api.identity.createRecoveryCode, { token });
  if (!issued.ok) throw new Error(issued.error);
  expect(await t.mutation(api.identity.confirmRecoveryEnrollment, { token, code: issued.code })).toEqual({ ok: true });
  return issued;
}

test("invitation signup commits credential, customer, membership, admission and invite together", async () => {
  const { t, pos, app, invite, enroll } = await world();
  const preview = await invite();
  expect(await t.query(api.identity.previewCustomerInvitation, { invitation: preview })).toMatchObject({ status: "ready", projectKey: "POS", viewer: null });
  // Opening or previewing never consumes.
  expect(await t.query(api.identity.previewCustomerInvitation, { invitation: preview })).toMatchObject({ status: "ready" });
  const result = await t.mutation(api.auth.signUpWithInvitation, { invitation: preview, username: "  Alice_1 ", displayName: " สมชาย  ใจดี ", password: PASSWORD });
  const alice = session(result);
  expect(await t.query(api.identity.viewer, { token: alice })).toMatchObject({
    kind: "customer", username: "alice_1", displayName: "สมชาย ใจดี", needsRecoveryCode: true, recoveryEnrollmentRequired: true,
  });
  const appInvite = await invite(app._id);
  await expect(t.query(api.projects.listProjects, { token: alice })).rejects.toThrow("RECOVERY_ENROLLMENT_REQUIRED");
  await expect(t.mutation(api.identity.joinWithInvitation, { token: alice, invitation: appInvite })).rejects.toThrow("RECOVERY_ENROLLMENT_REQUIRED");
  const issued = await t.mutation(api.identity.createRecoveryCode, { token: alice });
  if (!issued.ok) throw new Error(issued.error);
  await expect(t.query(api.projects.listProjects, { token: alice })).rejects.toThrow("RECOVERY_ENROLLMENT_REQUIRED");
  const reopened = session(await t.action(api.auth.signInWithPassword, { username: "Alice_1", password: PASSWORD }));
  await expect(t.mutation(api.tickets.createTextTicket, {
    token: reopened, projectKey: "POS", requestId: "blocked", title: "Mine", description: "",
  })).rejects.toThrow("RECOVERY_ENROLLMENT_REQUIRED");
  expect(await t.mutation(api.identity.confirmRecoveryEnrollment, { token: reopened, code: "invalid" })).toEqual({ ok: false, error: "RECOVERY_FAILED" });
  expect(await t.mutation(api.identity.confirmRecoveryEnrollment, { token: reopened, code: issued.code })).toEqual({ ok: true });
  expect(await t.query(api.projects.listProjects, { token: alice })).toEqual([expect.objectContaining({ _id: pos._id })]);
  expect(await t.query(api.identity.previewCustomerInvitation, { invitation: preview })).toEqual({ status: "INVITE_USED" });
  await expect(t.mutation(api.auth.signUpWithInvitation, { invitation: preview, username: "other", displayName: "Other", password: PASSWORD })).rejects.toThrow("INVITE_USED");
  // Normalized username collision and the reserved list.
  expect(await enroll("ALICE_1")).toEqual({ status: "error", userError: { error: "USERNAME_TAKEN" } });
  expect(await enroll("admin")).toEqual({ status: "error", userError: { error: "USERNAME_UNAVAILABLE" } });
  expect(await enroll("ab")).toEqual({ status: "error", userError: { error: "INVALID_USERNAME" } });
  // A signed-in session must switch account; a returning customer joins instead.
  expect(await t.mutation(api.auth.signUpWithInvitation, { token: alice, invitation: await invite(app._id), username: "second", displayName: "x", password: PASSWORD }))
    .toEqual({ status: "error", userError: { error: "SIGN_OUT_REQUIRED" } });
  expect(await t.query(api.identity.previewCustomerInvitation, { token: alice, invitation: appInvite })).toMatchObject({ viewer: { kind: "customer", username: "alice_1", alreadyMember: false } });
  expect(await t.mutation(api.identity.joinWithInvitation, { token: alice, invitation: appInvite })).toMatchObject({ status: "joined" });
  const again = await invite(app._id);
  expect(await t.mutation(api.identity.joinWithInvitation, { token: alice, invitation: again })).toMatchObject({ status: "already_member" });
  expect(await t.query(api.identity.previewCustomerInvitation, { invitation: again })).toMatchObject({ status: "ready" });
  // A lost signup response is recovered by signing in with the chosen credentials.
  expect(session(await t.action(api.auth.signInWithPassword, { username: "Alice_1", password: PASSWORD }))).toBeTruthy();
});

test("one password policy: NFC, 15–100 code points, no surrounding whitespace, common passwords refused with full rollback", async () => {
  const { t, enroll } = await world();
  const fourteen = "abcdefghijklmn";
  expect(await enroll("short", fourteen)).toEqual({ status: "error", userError: { error: "PASSWORD_TOO_SHORT" } });
  expect(await enroll("long", "a".repeat(101))).toEqual({ status: "error", userError: { error: "PASSWORD_TOO_LONG" } });
  expect(await enroll("space", ` ${PASSWORD}`)).toEqual({ status: "error", userError: { error: "PASSWORD_HAS_SURROUNDING_WHITESPACE" } });
  await expect(enroll("common", "123456789qwerty")).rejects.toThrow("PASSWORD_TOO_COMMON");
  expect(await t.run(ctx => ctx.db.query("customers").collect())).toEqual([]);
  expect(await t.run(ctx => ctx.db.query("users").collect())).toHaveLength(1);
  expect((await t.run(ctx => ctx.db.query("projectInvitations").collect())).every(i => i.status === "pending")).toBe(true);
  // Thai, astral emoji and canonical equivalence: 15 code points after NFC.
  const decomposed = "cafe\u0301 ไทย 🙂 pass";
  expect([...decomposed.normalize("NFC")].length).toBe(15);
  session(await enroll("unicode", decomposed));
  session(await t.action(api.auth.signInWithPassword, { username: "unicode", password: decomposed.normalize("NFC") }));
  session(await enroll("hundred", "x".repeat(99) + "y"));
});

test("sign-in gives normalized known and unknown usernames the same verification budget and failure", async () => {
  vi.useFakeTimers();
  const { t, owner, enroll } = await world();
  const alice = session(await enroll("alice"));
  session(await enroll("bob"));
  const generic = { status: "error", userError: { error: "INVALID_CREDENTIALS" } };
  expect(await t.action(api.auth.signInWithPassword, { username: "x", password: PASSWORD })).toEqual(generic);
  const verify = vi.spyOn(argon2, "verifyPassword");
  for (let attempt = 0; attempt < 5; attempt++) {
    for (const name of ["alice", "nobody"]) {
      const username = attempt % 2 === 0 ? name : `  ${name.toUpperCase()} `;
      expect(await t.action(api.auth.signInWithPassword, { username, password: "wrong wrong wrong" })).toEqual(generic);
    }
  }
  expect(verify).toHaveBeenCalledTimes(10);
  for (const username of [" ALICE ", " NOBODY "]) {
    expect(await t.action(api.auth.signInWithPassword, { username, password: PASSWORD })).toEqual(generic);
  }
  expect(verify).toHaveBeenCalledTimes(10);
  session(await t.action(api.auth.signInWithPassword, { username: "bob", password: PASSWORD }));
  vi.advanceTimersByTime(61_000);
  session(await t.action(api.auth.signInWithPassword, { username: "alice", password: PASSWORD }));
  session(await t.action(api.auth.signInWithPassword, { username: "alice", password: PASSWORD }));
  const { customerId } = await whoami(t, alice);
  await t.mutation(api.identity.setCustomerAccess, { token: owner.session, customerId: customerId!, status: "disabled" });
  vi.advanceTimersByTime(60_000);
  expect(await t.action(api.auth.signInWithPassword, { username: "alice", password: PASSWORD })).toEqual(generic);
});

test("simultaneous unknown selectors spend the last committed slot on one verification", async () => {
  const { t, enroll } = await world();
  session(await enroll("alice"));
  const now = Date.now();
  const budgetId = await t.run(ctx => ctx.db.insert("identityAttempts", {
    key: "signin:unrecognized", attempts: 199, firstAttemptAt: now, updatedAt: now,
  }));
  const { started, release, verify } = pauseNextPasswordVerification();
  const signIn = (username: string) => t.action(api.auth.signInWithPassword, { username, password: PASSWORD });
  const generic = { status: "error", userError: { error: "INVALID_CREDENTIALS" } };
  const concurrent = [signIn("firstunused"), signIn("secondunused")];
  try {
    const [, denied] = await beforeVerificationFinishes(Promise.all([started, Promise.race(concurrent)]));
    expect(denied).toEqual(generic);
    expect(await t.run(ctx => ctx.db.get(budgetId))).toMatchObject({ attempts: 200, lockedUntil: expect.any(Number) });
    expect(verify).toHaveBeenCalledTimes(1);
  } finally {
    release();
    await Promise.allSettled(concurrent);
  }
  expect(await Promise.all(concurrent)).toEqual([generic, generic]);
  expect(await signIn("thirdunused")).toEqual(generic);
  expect(verify).toHaveBeenCalledTimes(1);
  session(await signIn("alice"));
  expect(verify).toHaveBeenCalledTimes(2);
});

test("simultaneous recognized sign-ins spend the selector's last committed slot on one verification", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { t, enroll } = await world();
  const { userId } = await whoami(t, session(await enroll("alice")));
  const signIn = (username: string, password = PASSWORD) => t.action(api.auth.signInWithPassword, { username, password });
  for (let attempt = 0; attempt < 4; attempt++) {
    expect(await signIn("alice", "wrong wrong wrong")).toEqual(INVALID_CREDENTIALS);
  }
  const { started, release, verify } = pauseNextPasswordVerification();
  const concurrent = [signIn("alice"), signIn(" ALICE ")];
  try {
    const [, denied] = await beforeVerificationFinishes(Promise.all([started, Promise.race(concurrent)]));
    expect(denied).toEqual(INVALID_CREDENTIALS);
    expect(verify).toHaveBeenCalledExactlyOnceWith(PASSWORD, expect.any(String));
    expect(await sessionCount(t, userId)).toBe(1);
  } finally {
    release();
    await Promise.allSettled(concurrent);
  }
  const results = await Promise.all(concurrent);
  expect(results.filter(result => result.status === "error")).toEqual([INVALID_CREDENTIALS]);
  const admitted = results.find(result => result.status === "complete");
  expect(admitted).toBeDefined();
  expect(await t.query(api.identity.viewer, { token: session(admitted!) })).toMatchObject({ kind: "customer", username: "alice" });
  expect(await sessionCount(t, userId)).toBe(2);
  expect(verify).toHaveBeenCalledTimes(1);
});

test("changing the password while sign-in verifies the old hash prevents admission", async () => {
  const { t, enroll } = await world();
  const alice = session(await enroll("alice"));
  await saveRecoveryCode(t, alice);
  const { userId } = await whoami(t, alice);
  const newPassword = "a brand new passphrase";
  const { started, release, verify } = pauseNextPasswordVerification();
  const pending = t.action(api.auth.signInWithPassword, { username: "alice", password: PASSWORD });
  try {
    await beforeVerificationFinishes(started);
    const changed = t.mutation(api.auth.changePassword, { token: alice, currentPassword: PASSWORD, newPassword });
    expect(await beforeVerificationFinishes(changed)).toEqual({ success: true });
  } finally {
    release();
    await Promise.allSettled([pending]);
  }
  await expect(verify.mock.results[0].value).resolves.toBe(true);
  expect(await pending).toEqual(INVALID_CREDENTIALS);
  expect(await sessionCount(t, userId)).toBe(1);
  session(await t.action(api.auth.signInWithPassword, { username: "alice", password: newPassword }));
});

test.each([false, true])("disabling during sign-in prevents admission after verification (re-enabled: %s)", async reenable => {
  const { t, owner, enroll } = await world();
  const { customerId, userId } = await whoami(t, session(await enroll("alice")));
  const { started, release, verify } = pauseNextPasswordVerification();
  const signIn = () => t.action(api.auth.signInWithPassword, { username: "alice", password: PASSWORD });
  const pending = signIn();
  try {
    await beforeVerificationFinishes(started);
    const setAccess = (status: "active" | "disabled") => t.mutation(api.identity.setCustomerAccess, {
      token: owner.session, customerId: customerId!, status,
    });
    await beforeVerificationFinishes(setAccess("disabled"));
    if (reenable) await beforeVerificationFinishes(setAccess("active"));
  } finally {
    release();
    await Promise.allSettled([pending]);
  }
  await expect(verify.mock.results[0].value).resolves.toBe(true);
  expect(await pending).toEqual(INVALID_CREDENTIALS);
  expect(await sessionCount(t, userId)).toBe(0);
  if (reenable) session(await signIn());
});

test("live disable denies the open session and its refresh; re-enable needs a fresh sign-in", async () => {
  const { t, owner, pos, enroll } = await world();
  const signedUp = await enroll("alice");
  const alice = session(signedUp);
  const { code } = await saveRecoveryCode(t, alice);
  const recovery = { username: "alice", recoveryCode: code, newPassword: "replacement after re-enable" };
  const refreshToken = signedUp.status === "complete" ? signedUp.tokens.refreshToken : "";
  const created = await t.mutation(api.tickets.createTextTicket, { token: alice, projectKey: "POS", requestId: "r1", title: "Mine", description: "" });
  const { customerId, userId } = await whoami(t, alice);
  // An already-issued code from before the issuance generation field also survives.
  await t.run(ctx => ctx.db.patch(customerId!, { recoveryCodeGeneration: undefined }));
  await t.mutation(api.identity.setCustomerAccess, { token: owner.session, customerId: customerId!, status: "disabled" });
  await expect(t.query(api.tickets.getTicket, { token: alice, id: created.ticket._id })).rejects.toThrow("SESSION_EXPIRED");
  expect(await t.query(api.identity.viewer, { token: alice })).toBeNull();
  expect(await t.mutation(api.auth.refreshSession, { refreshToken })).toEqual({ kind: "noSession" });
  expect(await sessionCount(t, userId)).toBe(0);
  expect(await t.mutation(api.auth.recoverWithCode, recovery)).toEqual({ success: false, error: "RECOVERY_FAILED" });
  await t.mutation(api.identity.setCustomerAccess, { token: owner.session, customerId: customerId!, status: "active" });
  await expect(t.query(api.tickets.getTicket, { token: alice, id: created.ticket._id })).rejects.toThrow("SESSION_EXPIRED");
  expect(await t.mutation(api.auth.recoverWithCode, recovery)).toEqual({ success: true });
  const fresh = session(await t.action(api.auth.signInWithPassword, { username: "alice", password: recovery.newPassword }));
  await saveRecoveryCode(t, fresh);
  expect(await t.query(api.tickets.getTicket, { token: fresh, id: created.ticket._id })).toMatchObject({ _id: created.ticket._id });
  // Staff remain global; a stale generation admission is refused even if its core session lived.
  await t.run(async ctx => {
    const admission = (await ctx.db.query("sessionAdmissions").withIndex("by_auth_session", q => q.eq("authSessionId", fresh)).unique())!;
    await ctx.db.patch(admission._id, { generation: admission.generation - 1 });
  });
  await expect(t.query(api.projects.listProjects, { token: fresh })).rejects.toThrow("SESSION_EXPIRED");
  void pos;
});

test("a completion that skips admission rolls back its session", async () => {
  const { t, enroll } = await world();
  const alice = session(await enroll("alice"));
  const { userId } = await whoami(t, alice);
  const before = await sessionCount(t, userId);
  await expect(t.mutation(fixtures.signInWithoutAdmission, { userId })).rejects.toThrow("ADMISSION_REQUIRED");
  expect(await sessionCount(t, userId)).toBe(before);
});

test("saved-code recovery resets once, revokes every session and keeps ownership; failures change nothing", async () => {
  const { t, owner, enroll } = await world();
  const alice = session(await enroll("alice"));
  const issued = await saveRecoveryCode(t, alice);
  const ticket = await t.mutation(api.tickets.createTextTicket, { token: alice, projectKey: "POS", requestId: "r1", title: "Mine", description: "" });
  expect(issued.code).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{1,5}){5}$/);
  expect(await t.query(api.identity.viewer, { token: alice })).toMatchObject({ needsRecoveryCode: false });
  // Replacing a code needs the current password.
  expect(await t.mutation(api.identity.createRecoveryCode, { token: alice })).toEqual({ ok: false, error: "PROOF_REQUIRED" });
  const failed = { success: false, error: "RECOVERY_FAILED" };
  expect(await t.mutation(api.auth.recoverWithCode, { username: "alice", recoveryCode: "0".repeat(26), newPassword: "a brand new passphrase" })).toEqual(failed);
  expect(await t.mutation(api.auth.recoverWithCode, { username: "nobody", recoveryCode: issued.code, newPassword: "a brand new passphrase" })).toEqual(failed);
  // A rejected new password leaves the old password, code, sessions and ownership intact.
  expect(await t.mutation(api.auth.recoverWithCode, { username: "alice", recoveryCode: issued.code, newPassword: "short" })).toEqual({ success: false, error: "PASSWORD_TOO_SHORT" });
  expect(await t.mutation(api.auth.recoverWithCode, { username: "alice", recoveryCode: issued.code, newPassword: PASSWORD }))
    .toEqual({ success: false, error: "PASSWORD_REUSE" });
  expect(await t.query(api.tickets.getTicket, { token: alice, id: ticket.ticket._id })).toBeTruthy();
  // Lowercase and separators are ignored on entry.
  const entered = issued.code.toLowerCase().replace(/-/g, " ");
  const [first, second] = await Promise.allSettled([
    t.mutation(api.auth.recoverWithCode, { username: "ALICE", recoveryCode: entered, newPassword: "a brand new passphrase" }),
    t.mutation(api.auth.recoverWithCode, { username: "alice", recoveryCode: issued.code, newPassword: "another new passphrase" }),
  ]);
  const outcomes = [first, second].map(result => result.status === "fulfilled" ? result.value.success : false);
  expect(outcomes.filter(Boolean)).toHaveLength(1);
  await expect(t.query(api.tickets.getTicket, { token: alice, id: ticket.ticket._id })).rejects.toThrow("SESSION_EXPIRED");
  const winner = outcomes[0] ? "a brand new passphrase" : "another new passphrase";
  expect(await t.action(api.auth.signInWithPassword, { username: "alice", password: PASSWORD })).toMatchObject({ status: "error" });
  const fresh = session(await t.action(api.auth.signInWithPassword, { username: "alice", password: winner }));
  expect(await t.query(api.identity.viewer, { token: fresh })).toMatchObject({ needsRecoveryCode: true, recoveryEnrollmentRequired: true });
  await expect(t.query(api.tickets.getTicket, { token: fresh, id: ticket.ticket._id })).rejects.toThrow("RECOVERY_ENROLLMENT_REQUIRED");
  // The consumed code never works again.
  expect(await t.mutation(api.auth.recoverWithCode, { username: "alice", recoveryCode: issued.code, newPassword: "yet another passphrase" })).toEqual(failed);
  // A disabled customer cannot recover.
  const code = await saveRecoveryCode(t, fresh);
  expect(await t.query(api.tickets.getTicket, { token: fresh, id: ticket.ticket._id })).toMatchObject({ _id: ticket.ticket._id });
  const { customerId } = await whoami(t, fresh);
  await t.mutation(api.identity.setCustomerAccess, { token: owner.session, customerId: customerId!, status: "disabled" });
  expect(await t.mutation(api.auth.recoverWithCode, { username: "alice", recoveryCode: code.ok ? code.code : "", newPassword: "yet another passphrase" })).toEqual(failed);
});

test("saved-code proof can recover a customer through exhausted recovery and sign-in budgets", async () => {
  vi.useFakeTimers();
  const { t, enroll } = await world();
  const alice = session(await enroll("alice"));
  const issued = await saveRecoveryCode(t, alice);
  const bob = await saveRecoveryCode(t, session(await enroll("bob")));
  const newPassword = "a brand new passphrase";
  const rejected = { success: false, error: "RECOVERY_FAILED" };
  const recover = (username: string, recoveryCode: string) =>
    t.mutation(api.auth.recoverWithCode, { username, recoveryCode, newPassword });
  const verify = vi.spyOn(argon2, "verifyPassword");
  for (let attempt = 0; attempt < 11; attempt++) {
    for (const name of ["alice", "nobody"]) {
      const username = attempt % 2 === 0 ? name : `  ${name.toUpperCase()} `;
      expect(await recover(username, "1".repeat(26))).toEqual(rejected);
    }
  }
  expect(verify).not.toHaveBeenCalled();
  const attemptKey = async (username: string) => recoveryAttemptKey(await customerCredentialSelector(username));
  const attemptRow = async (key: string) => await t.run(ctx =>
    ctx.db.query("identityAttempts").withIndex("by_key", q => q.eq("key", key)).unique());
  const aliceKey = await attemptKey("alice");
  const unknownKey = await attemptKey("nobody");
  for (const key of [aliceKey, unknownKey]) {
    const row = (await attemptRow(key))!;
    expect(row).toMatchObject({ attempts: 10, lockedUntil: row.updatedAt + 60 * 60 * 1000 });
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    await t.action(api.auth.signInWithPassword, { username: "alice", password: "incorrect customer password" });
  }
  expect(await t.action(api.auth.signInWithPassword, { username: "alice", password: PASSWORD }))
    .toEqual({ status: "error", userError: { error: "INVALID_CREDENTIALS" } });
  const ingress = (await attemptRow("recover:invalid-rpc"))!;
  const lockedUntil = Date.now() + 60_000;
  await t.run(async ctx => {
    await ctx.db.patch(ingress._id, { lockedUntil });
  });
  for (const username of ["alice", "bob", "nobody", "unknown"]) expect(await recover(username, "invalid")).toEqual(rejected);
  session(await t.action(api.auth.signInWithPassword, { username: "bob", password: PASSWORD }));
  expect(await recover(" ALICE ", issued.code)).toEqual({ success: true });
  expect(await attemptRow(aliceKey)).toBeNull();
  expect(await attemptRow(unknownKey)).toMatchObject({ attempts: 10 });
  expect(await attemptRow("recover:invalid-rpc")).toMatchObject({ lockedUntil });
  session(await t.action(api.auth.signInWithPassword, { username: "alice", password: newPassword }));
  expect(await recover("bob", bob.code)).toEqual({ success: true });
});

test("password change verifies the old password and revokes only other sessions", async () => {
  const { t, enroll } = await world();
  const first = session(await enroll("alice"));
  await saveRecoveryCode(t, first);
  const second = session(await t.action(api.auth.signInWithPassword, { username: "alice", password: PASSWORD }));
  expect(await t.mutation(api.auth.changePassword, { token: second, currentPassword: "wrong wrong wrong", newPassword: "a brand new passphrase" }))
    .toEqual({ success: false, error: "INVALID_CREDENTIALS" });
  expect(await t.mutation(api.auth.changePassword, { token: second, currentPassword: PASSWORD, newPassword: "a brand new passphrase" })).toEqual({ success: true });
  expect(await t.query(api.identity.viewer, { token: first })).toBeNull();
  expect(await t.query(api.identity.viewer, { token: second })).toMatchObject({ kind: "customer" });
  await expect(t.mutation(api.auth.changePassword, { currentPassword: PASSWORD, newPassword: "a brand new passphrase" })).rejects.toThrow("SESSION_EXPIRED");
});

test("staff invitation needs the exact verified Google mailbox and a fresh mailbox code; activation needs a new sign-in", async () => {
  const { t, owner } = await world();
  const staffOnly = await t.mutation(fixtures.staff, { email: "staff@fixture.test", role: "staff" });
  const email = " New.Person@Fixture.test ";
  const role = "staff" as const;
  await expect(t.mutation(api.identity.inviteStaff, { token: staffOnly.session, email, role, proof: { code: "" } })).rejects.toThrow("OWNER_ONLY");
  await t.action(api.identity.sendChallengeCode, { token: owner.session, purpose: "staff-invite-create", target: staffInvitationIntent(email, role) });
  const ownerCode = (await t.query(internal.identity.readLocalDelivery, { to: "owner@fixture.test" }))!.code;
  const invitation = await t.mutation(api.identity.inviteStaff, { token: owner.session, email, role, proof: { code: ownerCode } });
  if (!invitation.ok) throw new Error(invitation.error);
  const wrong = await t.mutation(fixtures.pending, { email: "someone@else.test", subject: "google-wrong" });
  expect(await t.query(api.identity.previewStaffInvitation, { token: wrong.session, invitation: invitation.secret })).toMatchObject({ status: "WRONG_GOOGLE_ACCOUNT" });
  await expect(t.action(api.identity.sendChallengeCode, { token: wrong.session, purpose: "staff-invite", invitation: invitation.secret })).rejects.toThrow("WRONG_GOOGLE_ACCOUNT");
  // A pending identity has no workspace access.
  await expect(t.query(api.projects.listProjects, { token: wrong.session })).rejects.toThrow("IDENTITY_PENDING");
  const person = await t.mutation(fixtures.pending, { email: "new.person@fixture.test", subject: "google-new", name: "New Person" });
  expect(await t.query(api.identity.previewStaffInvitation, { token: person.session, invitation: invitation.secret })).toMatchObject({ status: "ready", role: "staff" });
  expect(await t.mutation(api.identity.acceptStaffInvitation, { token: person.session, invitation: invitation.secret, code: "00000000" })).toEqual({ ok: false, error: "PROOF_REQUIRED" });
  await t.action(api.identity.sendChallengeCode, { token: person.session, purpose: "staff-invite", invitation: invitation.secret });
  const delivered = (await t.query(internal.identity.readLocalDelivery, { to: "new.person@fixture.test" }))!;
  expect(delivered.code).toMatch(/^\d{8}$/);
  expect(await t.mutation(api.identity.acceptStaffInvitation, { token: person.session, invitation: invitation.secret, code: "12345678" === delivered.code ? "87654321" : "12345678" }))
    .toEqual({ ok: false, error: "INVALID_CODE" });
  expect(await t.mutation(api.identity.acceptStaffInvitation, { token: person.session, invitation: invitation.secret, code: delivered.code })).toEqual({ ok: true });
  // The pending session is revoked; staff authority needs a fresh Google sign-in.
  await expect(t.query(api.projects.listProjects, { token: person.session })).rejects.toThrow("SESSION_EXPIRED");
  await t.mutation(fixtures.recordFlow, { state: "fresh-flow" });
  const staffSession = await t.mutation(fixtures.googleCompletion, { userId: person.userId, state: "fresh-flow" });
  expect(await t.query(api.identity.viewer, { token: staffSession })).toMatchObject({ kind: "staff", role: "staff", name: "New Person" });
  expect(await t.query(api.identity.listStaffDirectory, { token: staffSession })).toEqual(expect.arrayContaining([expect.objectContaining({ name: "New Person", role: "staff" })]));
  // Reuse and replay fail.
  const again = await t.mutation(fixtures.pending, { email: "new.person@fixture.test", subject: "google-new-2" });
  expect(await t.query(api.identity.previewStaffInvitation, { token: again.session, invitation: invitation.secret })).toEqual({ status: "INVITE_USED" });
  await expect(t.mutation(fixtures.googleCompletion, { userId: person.userId, state: "fresh-flow" })).rejects.toThrow("SIGN_IN_RESTART_REQUIRED");
});

test("Owner invitation creation and reissue require separate single-use proof for the exact email, role and original invitation", async () => {
  vi.useFakeTimers();
  const { t, owner } = await world();
  const email = "new.owner@fixture.test";
  const role = "owner" as const;
  const invite = { token: owner.session, email, role };
  const required = { ok: false, error: "PROOF_REQUIRED" };
  const send = async (purpose: "staff-invite-create" | "staff-invite-reissue", target: string) => {
    await t.action(api.identity.sendChallengeCode, { token: owner.session, purpose, target });
    return (await t.query(internal.identity.readLocalDelivery, { to: "owner@fixture.test" }))!.code;
  };
  expect(await t.mutation(api.identity.inviteStaff, { ...invite, proof: { code: "00000000" } })).toEqual(required);
  const code = await send("staff-invite-create", staffInvitationIntent(email, role));
  const proof = { code };
  for (const changes of [{ email: "different@fixture.test" }, { role: "staff" as const }]) {
    expect(await t.mutation(api.identity.inviteStaff, { ...invite, ...changes, proof })).toEqual(required);
  }
  const first = await t.mutation(api.identity.inviteStaff, { ...invite, proof });
  if (!first.ok) throw new Error(first.error);
  expect(await t.mutation(api.identity.inviteStaff, { ...invite, proof })).toEqual(required);
  const reissue = { invitationId: first.invitationId, token: owner.session };
  expect(await t.mutation(api.identity.reissueStaffInvitation, { ...reissue, proof })).toEqual(required);

  const createCode = await send("staff-invite-create", staffInvitationIntent(email, role, first.invitationId));
  expect(await t.mutation(api.identity.reissueStaffInvitation, { ...reissue, proof: { code: createCode } })).toEqual(required);
  const mismatched = await send("staff-invite-reissue", staffInvitationIntent(email, "staff", first.invitationId));
  expect(await t.mutation(api.identity.reissueStaffInvitation, { ...reissue, proof: { code: mismatched } })).toEqual(required);
  const reissueCode = await send("staff-invite-reissue", staffInvitationIntent(email, role, first.invitationId));
  const wrong = reissueCode === "00000000" ? "11111111" : "00000000";
  expect(await t.mutation(api.identity.reissueStaffInvitation, { ...reissue, proof: { code: wrong } })).toEqual({ ok: false, error: "INVALID_CODE" });
  expect(await t.run(ctx => ctx.db.get(first.invitationId))).toMatchObject({ status: "pending", email, role });
  expect((await t.run(ctx => ctx.db.query("identityChallenges").collect())).at(-1)).toMatchObject({ failedAttempts: 1 });
  const replacement = await t.mutation(api.identity.reissueStaffInvitation, { ...reissue, proof: { code: reissueCode } });
  if (!replacement.ok) throw new Error(replacement.error);
  expect(replacement.secret).not.toBe(first.secret);
  expect(await t.run(ctx => ctx.db.get(first.invitationId))).toMatchObject({ status: "revoked" });
  expect(await t.mutation(api.identity.reissueStaffInvitation, { ...reissue, invitationId: replacement.invitationId, proof: { code: reissueCode } })).toEqual(required);
});

test("proof email budget spans purposes and sessions and retains the last committed challenge on denial", async () => {
  vi.useFakeTimers();
  const { t, owner } = await world();
  const secondSession = await t.mutation(fixtures.session, { staffId: owner.staffId });
  const other = await t.mutation(fixtures.staff, { email: "other-owner@fixture.test" });
  const email = "owner@fixture.test";
  for (const token of [owner.session, secondSession]) {
    for (const purpose of ["staff-enable", "staff-role"] as const) {
      await t.action(api.identity.sendChallengeCode, { token, purpose, target: "fixture" });
      vi.advanceTimersByTime(1);
    }
  }
  const target = staffInvitationIntent("recipient@fixture.test", "owner");
  const args = { purpose: "staff-invite-create" as const, target };
  await t.action(api.identity.sendChallengeCode, { ...args, token: secondSession });
  const last = await t.query(internal.identity.readLocalDelivery, { to: email });
  const attempts = () => t.run(ctx => ctx.db.query("identityAttempts").collect());
  const committedBudget = await attempts();
  expect(committedBudget).toHaveLength(2);
  expect(committedBudget.every(row => row.attempts === 5 && row.lockedUntil !== undefined)).toBe(true);
  for (const token of [owner.session, secondSession]) {
    await expect(t.action(api.identity.sendChallengeCode, { ...args, token })).rejects.toThrow("RATE_LIMITED");
  }
  expect(await attempts()).toEqual(committedBudget);
  expect(await t.query(internal.identity.readLocalDelivery, { to: email })).toEqual(last);
  expect(await t.mutation(api.identity.inviteStaff, {
    token: secondSession, email: "recipient@fixture.test", role: "owner", proof: { code: last!.code },
  })).toMatchObject({ ok: true });
  expect(await t.action(api.identity.sendChallengeCode, { ...args, token: other.session })).toMatchObject({ sent: true });
  vi.advanceTimersByTime(15 * 60_000 + 1);
  expect(await t.action(api.identity.sendChallengeCode, { ...args, token: owner.session })).toMatchObject({ sent: true });
});

test("Google completion requires its own unconsumed flow started after the principal's last transition", async () => {
  vi.useFakeTimers();
  const { t, owner } = await world();
  const member = await t.mutation(fixtures.staff, { email: "member@fixture.test", role: "staff" });
  await expect(t.mutation(fixtures.googleCompletion, { userId: member.userId, state: "never-started" })).rejects.toThrow("SIGN_IN_RESTART_REQUIRED");
  await t.mutation(fixtures.recordFlow, { state: "before-disable" });
  vi.advanceTimersByTime(1000);
  await t.action(api.identity.sendChallengeCode, { token: owner.session, purpose: "staff-disable", target: member.staffId });
  const disable = (await t.query(internal.identity.readLocalDelivery, { to: "owner@fixture.test" }))!.code;
  expect(await t.mutation(api.identity.setStaffAccess, { token: owner.session, staffId: member.staffId, status: "disabled", proof: { code: disable } })).toEqual({ ok: true });
  await expect(t.query(api.projects.listProjects, { token: member.session })).rejects.toThrow("SESSION_EXPIRED");
  vi.advanceTimersByTime(1000);
  await t.action(api.identity.sendChallengeCode, { token: owner.session, purpose: "staff-enable", target: member.staffId });
  const enable = (await t.query(internal.identity.readLocalDelivery, { to: "owner@fixture.test" }))!.code;
  expect(await t.mutation(api.identity.setStaffAccess, { token: owner.session, staffId: member.staffId, status: "active", proof: { code: enable } })).toEqual({ ok: true });
  // A flow that started before disable and finishes after re-enable must restart.
  await expect(t.mutation(fixtures.googleCompletion, { userId: member.userId, state: "before-disable" })).rejects.toThrow("ACCESS_UNAVAILABLE");
  vi.advanceTimersByTime(1000);
  await t.mutation(fixtures.recordFlow, { state: "after-enable" });
  const fresh = await t.mutation(fixtures.googleCompletion, { userId: member.userId, state: "after-enable" });
  expect(await t.query(api.identity.viewer, { token: fresh })).toMatchObject({ kind: "staff" });
  // The stock start/callback need component httpPrefix routing, which convex-test
  // lacks; local_smoke:run exercises them on the disposable backend.
});

test("sensitive staff changes consume intent-bound proof; the last active Owner is protected", async () => {
  const { t, owner } = await world();
  const member = await t.mutation(fixtures.staff, { email: "member@fixture.test", role: "staff" });
  vi.stubEnv("IDENTITY_SENDER", "");
  await expect(t.action(api.identity.sendChallengeCode, { token: owner.session, purpose: "staff-role", target: `${member.staffId}:owner` })).rejects.toThrow("IDENTITY_SENDER_UNAVAILABLE");
  vi.stubEnv("IDENTITY_SENDER", "local");
  await expect(t.action(api.identity.sendChallengeCode, { token: member.session, purpose: "staff-role", target: `${member.staffId}:owner` })).rejects.toThrow("OWNER_ONLY");
  await t.action(api.identity.sendChallengeCode, { token: owner.session, purpose: "staff-role", target: `${member.staffId}:staff` });
  const code = (await t.query(internal.identity.readLocalDelivery, { to: "owner@fixture.test" }))!.code;
  // Proof for one intended change cannot authorize another.
  expect(await t.mutation(api.identity.setStaffRole, { token: owner.session, staffId: member.staffId, role: "owner", proof: { code } })).toEqual({ ok: false, error: "PROOF_REQUIRED" });
  await t.action(api.identity.sendChallengeCode, { token: owner.session, purpose: "staff-disable", target: owner.staffId });
  const selfDisable = (await t.query(internal.identity.readLocalDelivery, { to: "owner@fixture.test" }))!.code;
  await expect(t.mutation(api.identity.setStaffAccess, { token: owner.session, staffId: owner.staffId, status: "disabled", proof: { code: selfDisable } })).rejects.toThrow("LAST_OWNER");
  await t.action(api.identity.sendChallengeCode, { token: owner.session, purpose: "staff-role", target: `${member.staffId}:owner` });
  const promote = (await t.query(internal.identity.readLocalDelivery, { to: "owner@fixture.test" }))!.code;
  expect(await t.mutation(api.identity.setStaffRole, { token: owner.session, staffId: member.staffId, role: "owner", proof: { code: promote } })).toEqual({ ok: true });
  // Replay of consumed proof fails.
  expect(await t.mutation(api.identity.setStaffRole, { token: owner.session, staffId: member.staffId, role: "owner", proof: { code: promote } })).toEqual({ ok: false, error: "PROOF_REQUIRED" });
  expect(await t.query(api.identity.listTeam, { token: member.session })).toMatchObject({ staff: expect.arrayContaining([expect.objectContaining({ role: "owner" })]) });
});

test("Owner bootstrap is internal, exact-subject, one-use and needs a fresh sign-in", async () => {
  const t = identityTest();
  vi.stubEnv("OWNER_BOOTSTRAP_GOOGLE_SUBJECT", "google-owner");
  const pending = await t.mutation(fixtures.pending, { email: "owner@company.test", subject: "google-owner", name: "First Owner" });
  await expect(t.mutation(internal.identity.bootstrapOwner, { googleSubject: "google-other" })).rejects.toThrow("BOOTSTRAP_NOT_AUTHORIZED");
  const { staffId } = await t.mutation(internal.identity.bootstrapOwner, { googleSubject: "google-owner" });
  await expect(t.mutation(internal.identity.bootstrapOwner, { googleSubject: "google-owner" })).rejects.toThrow("BOOTSTRAP_ALREADY_USED");
  expect(await t.query(api.identity.viewer, { token: pending.session })).toBeNull();
  await t.mutation(fixtures.recordFlow, { state: "owner-flow" });
  const owner = await t.mutation(fixtures.googleCompletion, { userId: pending.userId, state: "owner-flow" });
  expect(await t.query(api.identity.viewer, { token: owner })).toMatchObject({ kind: "staff", role: "owner", staffId });
});

test("customer isolation: same-Project peers and removed members get the same unavailable answer", async () => {
  const { t, owner, pos, enroll } = await world();
  const alice = session(await enroll("alice"));
  const bob = session(await enroll("bob"));
  await saveRecoveryCode(t, alice);
  await saveRecoveryCode(t, bob);
  const created = await t.mutation(api.tickets.createTextTicket, { token: alice, projectKey: "POS", requestId: "a1", title: "Alice only", description: "" });
  expect(await t.query(api.tickets.getTicket, { token: bob, id: created.ticket._id })).toBeNull();
  const search = await t.query(api.tickets.searchTickets, { token: bob, projectId: pos._id, lifecycle: "active", search: "Alice" });
  expect(search.matches).toEqual([]);
  const { customerId } = await whoami(t, alice);
  await t.mutation(api.projects.removeProjectMember, { token: owner.session, projectId: pos._id, customerId: customerId! });
  expect(await t.query(api.tickets.getTicket, { token: alice, id: created.ticket._id })).toBeNull();
  await expect(t.mutation(api.tickets.createTextTicket, { token: alice, projectKey: "POS", requestId: "a2", title: "Denied", description: "" })).rejects.toThrow("PROJECT_NOT_FOUND");
});

test("older invitations without business eligibility confirmation cannot enroll a customer", async () => {
  const { t, pos, invite } = await world();
  const secret = await invite();
  await t.run(async ctx => {
    const row = await ctx.db.query("projectInvitations").withIndex("by_project", q =>
      q.eq("projectId", pos._id).eq("status", "pending")).unique();
    expect(row?.eligibilityConfirmed).toBe(true);
    await ctx.db.patch(row!._id, { eligibilityConfirmed: undefined });
  });
  expect(await t.query(api.identity.previewCustomerInvitation, { invitation: secret })).toEqual({ status: "INVITE_NOT_FOUND" });
  await expect(t.mutation(api.auth.signUpWithInvitation, {
    invitation: secret, username: "invite_case", displayName: "Fixture", password: PASSWORD,
  })).rejects.toThrow("INVITE_NOT_FOUND");
  expect(await t.run(ctx => ctx.db.query("customers").collect())).toHaveLength(0);
});

test("Join replay requires the invitation redeemer's current membership in an active Project", async () => {
  const { t, owner, pos, app, invite, enroll } = await world();
  const alice = session(await enroll("alice"));
  const bob = session(await enroll("bob", PASSWORD, app._id));
  await saveRecoveryCode(t, alice);
  await saveRecoveryCode(t, bob);
  const invitation = await invite(app._id);
  const join = (token: string, secret = invitation) => t.mutation(api.identity.joinWithInvitation, { token, invitation: secret });
  expect(await join(alice)).toEqual({ status: "joined", projectId: app._id });
  expect(await join(alice)).toEqual({ status: "already_member", projectId: app._id });
  await expect(join(bob)).rejects.toThrow("INVITE_USED");
  await t.run(ctx => ctx.db.patch(app._id, { archivedAt: Date.now() }));
  await expect(join(alice)).rejects.toThrow("INVITE_NOT_FOUND");
  await t.run(ctx => ctx.db.patch(app._id, { archivedAt: undefined }));
  const { customerId } = await whoami(t, alice);
  await t.mutation(api.projects.removeProjectMember, { token: owner.session, projectId: app._id, customerId: customerId! });
  await expect(join(alice)).rejects.toThrow("INVITE_USED");

  const pending = await t.mutation(api.identity.createCustomerInvitation, {
    eligibilityConfirmed: true, token: owner.session, projectId: pos._id,
  });
  await t.run(ctx => ctx.db.patch(pending.invitationId, { expiresAt: Date.now() - 1 }));
  await expect(join(alice, pending.secret)).rejects.toThrow("INVITE_EXPIRED");
  await t.mutation(api.identity.revokeCustomerInvitation, { token: owner.session, invitationId: pending.invitationId });
  await expect(join(alice, pending.secret)).rejects.toThrow("INVITE_REVOKED");
});

test("Owner cannot list or revoke a customer invitation when its Project is archived", async () => {
  const { t, owner, pos } = await world();
  const invitation = await t.mutation(api.identity.createCustomerInvitation, { eligibilityConfirmed: true, token: owner.session, projectId: pos._id });
  await t.run(ctx => ctx.db.patch(pos._id, { archivedAt: Date.now() }));
  await expect(t.query(api.identity.listCustomerInvitations, { token: owner.session, projectId: pos._id })).rejects.toThrow("PROJECT_NOT_FOUND");
  await expect(t.mutation(api.identity.revokeCustomerInvitation, { token: owner.session, invitationId: invitation.invitationId })).rejects.toThrow("INVITE_NOT_FOUND");
  expect(await t.run(ctx => ctx.db.get(invitation.invitationId))).toMatchObject({ status: "pending" });
});
