import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { lineAiReleaseEnabled, openLineAiKey, readLineAiConnection } from "../../convex/domain/line_ai_settings";
import { fixtures, identityTest } from "./identity-harness";
import { modules } from "./modules";

const scan = vi.hoisted(() => vi.fn());
vi.mock("../../convex/adapters/line_ai_provider", async original => ({
  ...await original<typeof import("../../convex/adapters/line_ai_provider")>(), scanLineRequest: scan,
}));

const now = 1_795_656_000_000;
const suggestion = { intent: "create", title: "Printer", description: null, ticketNumber: null, reply: null, evidence: ["E-42"] };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3210");
  vi.stubEnv("LINE_SECRETS_KEY", Buffer.alloc(32, 1).toString("base64"));
  vi.stubEnv("LINE_AI_ENABLED", "true");
  scan.mockResolvedValue(suggestion);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

async function fixture() {
  const t = identityTest(modules);
  const owner = await t.mutation(fixtures.staff, { email: "owner@fixture.test", role: "owner" });
  const staff = await t.mutation(fixtures.staff, { email: "staff@fixture.test", role: "staff" });
  const customer = await t.mutation(fixtures.customer, { username: "member" });
  const projectId = await t.run(({ db }) => db.insert("projects", { key: "POS", name: "POS", createdAt: now, updatedAt: now }));
  const save = (apiKey = "gemini-key-1234", provider: "gemini" | "openrouter" | "claude" | "openai" = "gemini", token = owner.session) =>
    t.action(api.line_ai_settings.testAndSave, { token, projectId, provider, apiKey });
  const row = () => t.run(ctx => readLineAiConnection(ctx, projectId));
  return { t, owner, staff, customer, projectId, save, row };
}

test("an Owner's tested key is sealed, bound to its Project and summarized without secrets", async () => {
  const f = await fixture();
  const saved = await f.save();
  expect(scan).toHaveBeenCalledOnce();
  const [connection, input] = scan.mock.calls[0];
  expect(connection).toEqual({ provider: "gemini", model: "gemini-4-neon", apiKey: "gemini-key-1234" });
  expect(input.files.map((file: { mimeType: string }) => file.mimeType)).toEqual(["image/png", "application/pdf"]);
  expect(saved).toEqual({ provider: "gemini", model: "gemini-4-neon", enabled: true, keyHint: "1234", revision: 1, testedAt: expect.any(Number), updatedAt: expect.any(Number) });
  const row = (await f.row())!;
  expect(row.keyCipher).not.toContain("gemini-key");
  expect(row.updatedBy).toBe(f.owner.staffId);
  expect(await openLineAiKey(row)).toBe("gemini-key-1234");
  // A ciphertext moved into another Project's row does not open.
  await expect(openLineAiKey({ ...row, projectId: "other" as Id<"projects"> })).rejects.toThrow("LINE_AI_KEY_UNREADABLE");
  await expect(openLineAiKey({ ...row, provider: "openai" })).rejects.toThrow("LINE_AI_KEY_UNREADABLE");

  const summary = await f.t.query(api.line_ai_settings.get, { token: f.staff.session, projectId: f.projectId });
  expect(summary).toMatchObject({ releaseEnabled: true, canManage: false, connection: saved });
  expect(summary.models).toEqual({ gemini: "gemini-4-neon", openrouter: "google/gemini-4-neon", claude: "claude-sonnet-5-5", openai: "gpt-6.2-sol" });
  expect(JSON.stringify(summary)).not.toMatch(/keyCipher|gemini-key/);
  expect((await f.t.query(api.line_ai_settings.get, { token: f.owner.session, projectId: f.projectId })).canManage).toBe(true);

  await f.save("sk-openrouter-5678", "openrouter");
  expect(await f.row()).toMatchObject({ provider: "openrouter", model: "google/gemini-4-neon", keyHint: "5678", revision: 2 });
  expect(await openLineAiKey((await f.row())!)).toBe("sk-openrouter-5678");
});

test("a failed test keeps the live key and surfaces only the stable code", async () => {
  const f = await fixture();
  await f.save();
  const before = await f.row();
  scan.mockRejectedValueOnce(new Error("LINE_AI_KEY_REJECTED"));
  await expect(f.save("claude-key-9999", "claude")).rejects.toThrow("LINE_AI_KEY_REJECTED");
  scan.mockRejectedValueOnce(new Error("provider said: customer text and sk-secret"));
  await expect(f.save("claude-key-9999", "claude")).rejects.toThrow(/^\{"code":"INTERNAL_ERROR"\}$/);
  for (const apiKey of ["short", "has space key", "x".repeat(513)]) {
    await expect(f.save(apiKey)).rejects.toThrow("LINE_AI_KEY_INVALID");
  }
  expect(await f.row()).toEqual(before);
});

test("a change made during a test wins and the slower result is discarded", async () => {
  const f = await fixture();
  await f.save();
  scan.mockImplementationOnce(async () => {
    await f.t.mutation(api.line_ai_settings.disable, { token: f.owner.session, projectId: f.projectId });
    return suggestion;
  });
  await expect(f.save("openai-key-2222", "openai")).rejects.toThrow("LINE_AI_CONNECTION_CHANGED");
  expect(await f.row()).toMatchObject({ enabled: false, revision: 2, provider: "gemini" });
  expect((await f.row())!.keyCipher).toBeUndefined();

  scan.mockImplementationOnce(async () => {
    await f.save("claude-key-3333", "claude");
    return suggestion;
  });
  await expect(f.save("openai-key-2222", "openai")).rejects.toThrow("LINE_AI_CONNECTION_CHANGED");
  expect(await f.row()).toMatchObject({ enabled: true, provider: "claude", revision: 3 });
  expect(await openLineAiKey((await f.row())!)).toBe("claude-key-3333");
});

test("disable discards the key; only Owners manage and only staff read", async () => {
  const f = await fixture();
  expect(await f.t.mutation(api.line_ai_settings.disable, { token: f.owner.session, projectId: f.projectId })).toBeNull();
  await f.save();
  await expect(f.save("gemini-key-0000", "gemini", f.staff.session)).rejects.toThrow("OWNER_ONLY");
  await expect(f.t.mutation(api.line_ai_settings.disable, { token: f.staff.session, projectId: f.projectId })).rejects.toThrow("OWNER_ONLY");
  for (const [token, code] of [[f.customer.session, "STAFF_ONLY"], [undefined, "SESSION_EXPIRED"]] as const) {
    await expect(f.t.query(api.line_ai_settings.get, { token, projectId: f.projectId })).rejects.toThrow(code);
    await expect(f.t.action(api.line_ai_settings.testAndSave, { token, projectId: f.projectId, provider: "gemini", apiKey: "gemini-key-0000" })).rejects.toThrow(code);
    await expect(f.t.mutation(api.line_ai_settings.disable, { token, projectId: f.projectId })).rejects.toThrow(code);
  }
  expect(scan).toHaveBeenCalledOnce();
  const disabled = await f.t.mutation(api.line_ai_settings.disable, { token: f.owner.session, projectId: f.projectId });
  expect(disabled).toMatchObject({ enabled: false, keyHint: null, revision: 2 });
  const row = (await f.row())!;
  expect(row.keyCipher).toBeUndefined();
  await expect(openLineAiKey(row)).rejects.toThrow("LINE_AI_NOT_CONFIGURED");
});

test("an Owner can pause and resume the tested connection without another provider call", async () => {
  const f = await fixture();
  await f.save();
  const patch = (paused: boolean, expectedRevision: number, token = f.owner.session) => f.t.mutation(
    api.line_ai_settings.setPaused, { token, projectId: f.projectId, paused, expectedRevision },
  );
  await expect(patch(true, 1, f.staff.session)).rejects.toThrow("OWNER_ONLY");
  const keyCipher = (await f.row())!.keyCipher;
  expect(await patch(true, 1)).toMatchObject({ enabled: false, keyHint: "1234", revision: 2 });
  expect((await f.row())!.keyCipher).toBe(keyCipher);
  await expect(patch(false, 1)).rejects.toThrow("LINE_AI_CONNECTION_CHANGED");
  expect(await patch(false, 2)).toMatchObject({ enabled: true, revision: 3 });
  expect(await openLineAiKey((await f.row())!)).toBe("gemini-key-1234");
  expect(scan).toHaveBeenCalledOnce();
  await patch(true, 3);
  await expect(f.save("gemini-key-9999")).resolves.toMatchObject({ enabled: false, revision: 5, keyHint: "9999" });
  await f.t.mutation(api.line_ai_settings.disable, { token: f.owner.session, projectId: f.projectId });
  const history = await f.t.run(({ db }) => db.query("lineAiConnectionEvents").withIndex("by_project_revision",
    q => q.eq("projectId", f.projectId)).collect());
  expect(history.map(({ action, revision, enabled }) => [action, revision, enabled])).toEqual([
    ["saved", 1, true], ["paused", 2, false], ["resumed", 3, true],
    ["paused", 4, false], ["saved", 5, false], ["disconnected", 6, false],
  ]);
  expect(history.every(row => row.staffId === f.owner.staffId)).toBe(true);
  expect(JSON.stringify(history)).not.toMatch(/keyCipher|keyHint|gemini-key/);
});

test("external calls need LINE_AI_ENABLED exactly true on a legacy deployment", async () => {
  const f = await fixture();
  for (const flag of ["TRUE", "1", ""]) {
    vi.stubEnv("LINE_AI_ENABLED", flag);
    await expect(f.save()).rejects.toThrow("LINE_AI_DISABLED");
    expect((await f.t.query(api.line_ai_settings.get, { token: f.owner.session, projectId: f.projectId })).releaseEnabled).toBe(false);
    expect(await f.t.run(ctx => lineAiReleaseEnabled(ctx))).toBe(false);
  }
  vi.stubEnv("LINE_AI_ENABLED", "true");
  vi.stubEnv("TICKET_DEPLOYMENT_MODE", "pilot");
  expect(await f.t.run(ctx => lineAiReleaseEnabled(ctx))).toBe(false);
  await expect(f.save()).rejects.toThrow("PILOT_UNAVAILABLE");
  await expect(f.t.query(api.line_ai_settings.get, { token: f.owner.session, projectId: f.projectId })).rejects.toThrow("PILOT_UNAVAILABLE");
  expect(scan).not.toHaveBeenCalled();
  expect(await f.row()).toBeNull();
});
