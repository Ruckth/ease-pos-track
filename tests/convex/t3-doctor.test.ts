import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { verify } from "../../convex/t3_doctor";
import { T3_DOCTOR_PATH, t3BearerPattern, t3ProofIntent } from "../../shared/t3-doctor";
import type { T3Change } from "../../shared/t3-doctor";
import { fixtures, identityTest, whoami } from "./identity-harness";
import { modules } from "./modules";

// The real named identity adapter (convex/t3_identity.ts): admitted Convex Auth
// sessions, live `staff` rows and action-bound proof from the shared identity
// sender, which records codes locally on the disposable backend.
const release = {
  id: "fixture", publicationUrl: "https://downloads.example.test/releases/fixture",
  releaseOrigin: "https://downloads.example.test", gatewayOrigin: "https://some.convex.site",
  deployment: "disposable-fixture",
  combinations: [{
    id: "fixture-codex", provider: "codex", macOS: "26.0", architecture: "arm64",
    t3: "1.0.0", cli: "0.1.0", skill: "0.1.0", bootstrapSha256: "a".repeat(64),
    downloadUrl: "https://downloads.example.test/releases/fixture/codex.zip",
  }],
};
beforeEach(() => {
  vi.stubEnv("T3_DOCTOR_ENABLED", "true");
  vi.stubEnv("T3_DOCTOR_ISSUANCE_ENABLED", "true");
  vi.stubEnv("T3_DOCTOR_EPOCH", "a".repeat(64));
  vi.stubEnv("T3_DOCTOR_RELEASE", JSON.stringify(release));
  vi.stubEnv("UPLOAD_CALLBACK_SECRET", "fixture-callback");
  vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3212");
  vi.stubEnv("LOCAL_FIXTURES_ENABLED", "true");
  vi.stubEnv("IDENTITY_SENDER", "local");
  vi.stubEnv("IDENTITY_CODE_KEY", "local-only-identity-code-key-0123456789abcdef");
});
afterEach(() => vi.unstubAllEnvs());

async function fixture() {
  const t = identityTest(modules);
  const { project, other } = await t.run(async ctx => {
    async function addProject(key: string, archivedAt?: number) {
      return await ctx.db.insert("projects", { key, name: key + " Project", createdAt: Date.now(), updatedAt: Date.now(), archivedAt });
    }
    // An archived Project is outside every staff member's current entitlement.
    return { project: await addProject("POS"), other: await addProject("OPS", Date.now()) };
  });
  async function addStaff(role: "owner" | "staff", account: string) {
    const created = await t.mutation(fixtures.staff, { email: account, name: account, role });
    return { staffId: created.staffId as string, session: created.session, account };
  }
  const staff = await addStaff("staff", "ticket-staff@example.test");
  const peer = await addStaff("staff", "peer@example.test");
  const owner = await addStaff("owner", "owner@example.test");
  const customer = await t.mutation(fixtures.customer, { username: "fixturecustomer", projectIds: [project] });
  function as(user: { session: string }) {
    return t.withIdentity({ subject: user.session });
  }
  function input(host = 1) {
    return {
      kind: "issue" as const, projectId: project, machineLabel: "Staff Mac", hostId: host.toString(16).padStart(64, "0"),
      days: 30, releaseId: release.id, combinationId: release.combinations[0].id,
    };
  }
  /** Requests action-bound proof as the browser does, then reads the locally delivered code. */
  async function proof(change: T3Change, user = staff) {
    const { action, intendedChange } = t3ProofIntent(change);
    const { challengeId } = await as(user).action(api.identity.sendChallengeCode, { purpose: action, target: intendedChange });
    const delivery = await t.query(internal.identity.readLocalDelivery, { to: user.account });
    return { challengeId: challengeId as string, code: delivery!.code };
  }
  async function issue(change = input(), user = staff) {
    const result = await as(user).mutation(api.t3_keys.change, { change, proof: await proof(change, user) });
    if (!("bearer" in result)) throw new Error("Fixture issuance failed");
    return result;
  }
  function doctor(bearer: string, init: RequestInit = {}, path = T3_DOCTOR_PATH) {
    const headers = new Headers(init.headers);
    if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${bearer}`);
    return t.fetch(path, { method: "POST", ...init, headers });
  }
  return { t, project, other, staff, peer, owner, customer: { session: customer.session }, as, input, proof, issue, doctor };
}

test("named staff issue a Project-specific doctor credential with no Ticket or upload effects", async () => {
  const f = await fixture();
  const projects = (await f.as(f.staff).query(api.t3_keys.settings, {})).projects;
  expect(projects.map(p => p.key)).toEqual(["POS"]);
  const issued = await f.issue();
  const [_, selector, secret] = issued.bearer.match(t3BearerPattern)!;
  const before = await f.t.run(async ctx => ({
    keys: await ctx.db.query("t3DoctorKeys").collect(),
    tickets: await ctx.db.query("tickets").collect(),
    intents: await ctx.db.query("uploadIntents").collect(),
  }));
  expect(before.keys[0]).toMatchObject({ selector, staffId: f.staff.staffId, projectId: f.project, generation: 1 });
  expect(JSON.stringify(before)).not.toContain(secret);
  const result = await f.doctor(issued.bearer, { body: "" });
  expect(result.status).toBe(200);
  expect(result.headers.get("Cache-Control")).toBe("no-store");
  const { bootstrapSha256, downloadUrl, ...compatibility } = release.combinations[0];
  expect(await result.json()).toEqual({
    deployment: release.deployment, releaseId: release.id, account: { id: f.staff.staffId, name: f.staff.account },
    projects: [{ key: "POS", name: "POS Project" }], scope: "doctor:read", expiresAt: issued.expiresAt,
    host: { id: f.input().hostId, label: "Staff Mac" }, compatibility,
  });
  expect(await f.t.run(async ctx => ({
    keys: await ctx.db.query("t3DoctorKeys").collect(),
    tickets: await ctx.db.query("tickets").collect(),
    intents: await ctx.db.query("uploadIntents").collect(),
  }))).toEqual(before);
});

test("the doctor bearer is rejected by RPC, callback and all other HTTP operations", async () => {
  const f = await fixture();
  const { bearer } = await f.issue();
  await expect(f.t.query(api.projects.listProjects, { token: bearer })).rejects.toThrow("SESSION_EXPIRED");
  await expect(f.t.query(api.t3_keys.settings, {})).rejects.toThrow("NAMED_STAFF_REQUIRED");
  await expect(f.as(f.customer).query(api.t3_keys.settings, {})).rejects.toThrow("NAMED_STAFF_REQUIRED");
  // convex-test deliberately permits internal function calls from its harness.
  expect(verify).toHaveProperty("isInternal", true);
  expect(verify).toHaveProperty("isQuery", true);
  expect(verify).not.toHaveProperty("isPublic", true);
  const { admissionId } = await whoami(f.t, f.staff.session);
  const intentId = await f.t.run(ctx => ctx.db.insert("uploadIntents", {
    sessionId: admissionId, secret: "fixture", idempotencyKey: "fixture", expectedFiles: [], uploadedFiles: [],
    status: "pending", actorRole: "staff", actorStaffId: f.staff.staffId as Id<"staff">, expiresAt: 0, createdAt: 0, updatedAt: 0,
  }));
  await expect(f.t.mutation(api.uploads.recordUploadedFile, {
    callbackToken: bearer, secret: "fixture", intentId, file: { key: "k", name: "f", size: 1, type: "image/png", url: "https://example.test/f" },
  })).rejects.toThrow("TRUSTED_CALLBACK_REQUIRED");
  expect((await f.doctor(bearer, { method: "GET" })).status).toBe(404);
  expect((await f.doctor(bearer, {}, "/integrations/t3/tickets")).status).toBe(404);
  const invalidRequests: RequestInit[] = [
    { headers: { Cookie: "session=fixture" } }, { headers: { Origin: release.gatewayOrigin } },
    { body: "{}" },
  ];
  for (const init of invalidRequests) expect((await f.doctor(bearer, init)).status).toBe(400);
  expect((await f.doctor(bearer, { headers: { Authorization: `Bearer ${bearer}, Bearer session` } })).status).toBe(401);
  expect((await f.doctor(bearer, {}, `${T3_DOCTOR_PATH}?token=x`)).status).toBe(400);
  expect((await f.doctor(f.staff.session)).status).toBe(401);
  expect((await f.doctor(bearer.slice(0, -1) + (bearer.endsWith("0") ? "1" : "0"))).status).toBe(401);
});

test("proof is bound to admitted session, exact intent and one successful transaction", async () => {
  const f = await fixture();
  const change = f.input();
  const proof = await f.proof(change);
  const args = { change, proof };
  const request = (p = proof, c = change) => f.as(f.staff).mutation(api.t3_keys.change, { change: c, proof: p });
  expect(await request(proof, { ...change, machineLabel: "Other Mac" })).toEqual({ ok: false });
  expect(await f.as(f.peer).mutation(api.t3_keys.change, args)).toEqual({ ok: false });
  expect(await request({ ...proof, code: "wrong" })).toEqual({ ok: false });
  const attempted = await f.t.run(ctx => ctx.db.get(proof.challengeId as Id<"identityChallenges">));
  expect(attempted?.failedAttempts).toBe(1);
  expect(attempted?.consumedAt).toBeUndefined();
  const race = await Promise.allSettled([request(), request()]);
  expect(race.filter(r => r.status === "fulfilled" && r.value.ok)).toHaveLength(1);
  expect(await request()).toEqual({ ok: false });
  expect(await f.t.run(ctx => ctx.db.query("t3DoctorKeys").collect())).toHaveLength(1);
  const outside = { ...f.input(2), projectId: f.other };
  await expect(request(await f.proof(outside), outside)).rejects.toThrow("PROJECT_NOT_FOUND");
  const tooLong = { ...f.input(2), days: 91 };
  await expect(request(await f.proof(tooLong), tooLong)).rejects.toThrow("DOCTOR_INVALID_EXPIRY");
});

test("rotation keeps host, scope and expiry bounded, and an Owner can only revoke a peer key", async () => {
  const f = await fixture();
  const original = await f.issue();
  const rotate = { kind: "rotate" as const, keyId: original.keyId, days: 7 };
  await expect(f.as(f.owner).mutation(api.t3_keys.change, { change: rotate, proof: await f.proof(rotate, f.owner) }))
    .rejects.toThrow("DOCTOR_KEY_UNAVAILABLE");
  const wider = { ...rotate, days: 31 };
  await expect(f.as(f.staff).mutation(api.t3_keys.change, { change: wider, proof: await f.proof(wider) })).rejects.toThrow("DOCTOR_INVALID_EXPIRY");
  const rotated = await f.as(f.staff).mutation(api.t3_keys.change, { change: rotate, proof: await f.proof(rotate) });
  if (!("bearer" in rotated)) throw new Error("Fixture rotation failed");
  expect((await f.doctor(original.bearer)).status).toBe(401);
  expect((await f.doctor(rotated.bearer)).status).toBe(200);
  expect(rotated.expiresAt).toBeLessThan(original.expiresAt);
  expect(await f.t.run(ctx => ctx.db.get(original.keyId))).toMatchObject({ replacedKeyId: rotated.keyId, revokedBy: f.staff.staffId });
  const paginationOpts = { cursor: null, numItems: 10 };
  await expect(f.as(f.peer).query(api.t3_keys.keys, { team: true, paginationOpts })).rejects.toThrow("OWNER_REQUIRED");
  const team = await f.as(f.owner).query(api.t3_keys.keys, { team: true, paginationOpts });
  expect(team.page.map(row => row.state)).toEqual(["available", "revoked"]);
  expect(JSON.stringify(team)).not.toContain(rotated.bearer);
  const revoke = { kind: "revoke" as const, keyId: rotated.keyId };
  await expect(f.as(f.peer).mutation(api.t3_keys.change, { change: revoke, proof: await f.proof(revoke, f.peer) }))
    .rejects.toThrow("DOCTOR_KEY_UNAVAILABLE");
  vi.stubEnv("T3_DOCTOR_ENABLED", "false");
  expect(await f.as(f.owner).mutation(api.t3_keys.change, { change: revoke, proof: await f.proof(revoke, f.owner) })).toEqual({ ok: true });
  vi.stubEnv("T3_DOCTOR_ENABLED", "true");
  expect((await f.doctor(rotated.bearer)).status).toBe(401);
  expect(await f.t.run(ctx => ctx.db.get(rotated.keyId))).toMatchObject({ revokedBy: f.owner.staffId });
});

test("expiry, live staff role, generation, Project access, release gating and external epoch are checked on every doctor", async () => {
  const f = await fixture();
  const { bearer, keyId } = await f.issue();
  const check = async (status: number) => expect((await f.doctor(bearer)).status).toBe(status);
  await check(200);
  const expiresAt = (await f.t.run(ctx => ctx.db.get(keyId)))!.expiresAt;
  await f.t.run(ctx => ctx.db.patch(keyId, { expiresAt: Date.now() }));
  await check(401);
  await f.t.run(ctx => ctx.db.patch(keyId, { expiresAt }));
  const staffId = f.staff.staffId as Id<"staff">;
  // Disable and re-enable advance the generation: the key stays dead and the session too.
  await f.t.run(ctx => ctx.db.patch(staffId, { status: "disabled" }));
  await check(401);
  await f.t.run(ctx => ctx.db.patch(staffId, { status: "active", generation: 2 }));
  await check(401);
  await expect(f.as(f.staff).query(api.t3_keys.settings, {})).rejects.toThrow("NAMED_STAFF_REQUIRED");
  await f.t.run(ctx => ctx.db.patch(staffId, { generation: 1 }));
  await check(200);
  await f.t.run(ctx => ctx.db.patch(f.project, { archivedAt: Date.now() }));
  await check(401);
  await f.t.run(ctx => ctx.db.patch(f.project, { archivedAt: undefined }));
  vi.stubEnv("T3_DOCTOR_ISSUANCE_ENABLED", "false");
  await check(200);
  const newKey = f.input(2);
  await expect(f.as(f.staff).mutation(api.t3_keys.change, { change: newKey, proof: await f.proof(newKey) })).rejects.toThrow("DOCTOR_ISSUANCE_UNAVAILABLE");
  vi.stubEnv("T3_DOCTOR_EPOCH", "b".repeat(64));
  await check(401);
  vi.stubEnv("T3_DOCTOR_RELEASE", JSON.stringify({ ...release, releaseOrigin: "https://other.example.test" }));
  await check(404);
});

test("one active key per host and three active keys per named staff are enforced in the issuance transaction", async () => {
  const f = await fixture();
  await f.issue();
  await expect(f.issue()).rejects.toThrow("DOCTOR_HOST_ALREADY_ENROLLED");
  await f.issue(f.input(2));
  // A new challenge replaces the session's outstanding one, so the racing request uses a second browser.
  const second = { ...f.staff, session: await f.t.mutation(fixtures.session, { staffId: f.staff.staffId as Id<"staff"> }) };
  const racers = [[f.input(3), f.staff], [f.input(4), second]] as const;
  const proofs = [await f.proof(racers[0][0], racers[0][1]), await f.proof(racers[1][0], racers[1][1])];
  const attempt = await Promise.allSettled(racers.map(async ([change, user], index) => {
    const result = await f.as(user).mutation(api.t3_keys.change, { change, proof: proofs[index] });
    if (!("bearer" in result)) throw new Error("Fixture issuance failed");
  }));
  expect(attempt.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(attempt.find(result => result.status === "rejected")).toMatchObject({ reason: expect.objectContaining({ message: expect.stringContaining("DOCTOR_KEY_LIMIT") }) });
});
