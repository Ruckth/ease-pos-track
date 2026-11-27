import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { inventory, reset, resetReadiness, resume, type Manifest, type ResetBackend, type ResetProvider, type Snapshot } from "../scripts/dev-reset/core";
import { fakeResetProvider, uploadthingResetProvider } from "../scripts/dev-reset/provider";
import { readSnapshot } from "../scripts/dev-reset/snapshot";
import { localDeploymentName, localResetTarget } from "../scripts/dev-reset-target.mjs";

const config = { deployment: "dev:disposable-123", uploadthingAppId: "dev-app" };
/** A development target ready for the post-clear Owner bootstrap. */
const ready = {
  MEDIA_CLEANUP_ENABLED: "false", TICKET_DEPLOYMENT_MODE: "legacy", CLERK_OAUTH_CLIENT_ID: "client", CLERK_OAUTH_CLIENT_SECRET: "secret",
  OWNER_BOOTSTRAP_GOOGLE_SUBJECT: "google-owner", AUTH_REDIRECT_ORIGINS: "https://app.example, http://127.0.0.1:4271",
};
const owner = { _id: "owner", userId: "user", googleSubject: ready.OWNER_BOOTSTRAP_GOOGLE_SUBJECT, email: "owner@example.invalid", role: "owner", status: "active", generation: 1 };
const bootstrapped: Snapshot = {
  staff: [owner],
  users: [{ _id: "user", kind: "staff", staffId: owner._id, googleSubject: owner.googleSubject, googleEmail: owner.email, googleEmailVerified: true }],
  identityAudit: [{ _id: "audit", action: "owner.bootstrapped", staffId: owner._id }],
  googleFlows: [{ _id: "flow", consumedAt: 1 }],
  sessionAdmissions: [{ _id: "admission", userId: "user", authSessionId: "pending-session", principal: "pending", method: "google", generation: 0, revokedAt: 2 }],
  "_components/auth/createdUserIds": [{ _id: "created", userId: "user" }],
  "_components/authGoogle/accounts": [{ _id: "account", providerAccountId: owner.googleSubject, userId: "user" }],
};
const oldData: Snapshot = { sessions: [{ _id: "old-session" }], tickets: [{ _id: "old-ticket", media: [{ key: "owned", url: "https://example.invalid/f/owned" }] }] };
/** The backend's rows: clearing erases them, including every session. */
function fixture(data: Snapshot = oldData) {
  const calls: string[] = [];
  const saved: Manifest[] = [];
  const state = { data };
  const backend: ResetBackend = {
    environment: async () => { calls.push("environment"); return { ...ready }; },
    snapshot: async () => { calls.push("inventory"); return structuredClone(state.data); },
    clear: async () => { calls.push("clear"); state.data = {}; }, push: async () => { calls.push("push"); },
    configure: async () => { calls.push("configure"); },
    bootstrapOwner: async () => { calls.push("bootstrap"); state.data = { ...state.data, ...structuredClone(bootstrapped) }; },
    seedAndVerify: async () => { calls.push("seed-and-verify"); },
  };
  const provider: ResetProvider = {
    kind: "uploadthing", appId: async () => { calls.push("app"); return "dev-app"; },
    ownedKeys: async keys => { calls.push("list"); return new Set(keys); }, delete: async () => { calls.push("delete"); return { outcome: "deleted" }; },
  };
  return { calls, saved, state, backend, provider, save: async (manifest: Manifest) => { saved.push(structuredClone(manifest)); } };
}
const reviewed = inventory(oldData, config.deployment);
const execute = { mode: "execute" as const, local: false, deployment: config.deployment, confirm: config.deployment, expect: reviewed, config };

test("reset refuses missing, production, production-marked and mismatched targets before backend I/O", async () => {
  for (const deployment of [undefined, "prod:disposable-123", "dev:production-123", "dev:live-123", "dev:other-123"]) {
    const deps = fixture();
    await assert.rejects(reset({ ...execute, deployment }, deps), /RESET_TARGET_REFUSED/);
    assert.deepEqual(deps.calls, []);
  }
});
test("reset missing or inexact confirmation refuses before I/O", async () => {
  for (const confirm of [undefined, "disposable-123", "dev:other-123"]) {
    const deps = fixture();
    await assert.rejects(reset({ ...execute, confirm }, deps), /RESET_CONFIRM_REQUIRED/);
    assert.deepEqual(deps.calls, []);
  }
});
test("inspect inventories all source paths and counts without any backend/provider writes", async () => {
  const deps = fixture();
  const manifest = await reset({ ...execute, mode: "inspect", confirm: undefined }, deps);
  assert.deepEqual(deps.calls, ["environment", "inventory"]);
  assert.deepEqual(manifest.counts, { sessions: 1, tickets: 1 });
  assert.deepEqual(manifest.unresolved, [{ key: "owned", sources: ["tickets/old-ticket.media[0].key"], outcome: "unverified" }]);
  assert.equal(deps.saved.length, 1);
});
test("provider app mismatch refuses before ownership lookup, deletion or clearing", async () => {
  const deps = fixture(); deps.provider.appId = async () => "wrong-app";
  await assert.rejects(reset(execute, deps), /RESET_PROVIDER_APP_MISMATCH/);
  assert.deepEqual(deps.calls, ["environment", "inventory"]);
  assert.equal(deps.saved[0].unresolved[0].key, "owned");
  assert.throws(() => uploadthingResetProvider(Buffer.from(JSON.stringify({ appId: "wrong-app" })).toString("base64"), config.uploadthingAppId), /RESET_PROVIDER_APP_MISMATCH/);
});
test("provider identity comes from authenticated app info; a forged token appId cannot authorize deletion", async () => {
  const deps = fixture();
  const token = Buffer.from(JSON.stringify({ appId: config.uploadthingAppId, apiKey: "fake-key-only" })).toString("base64");
  deps.provider = uploadthingResetProvider(token, config.uploadthingAppId, {
    fetch: async (url, options) => {
      assert.equal(url, "https://api.uploadthing.com/v7/getAppInfo");
      assert.equal(options?.method, "POST");
      return new Response(JSON.stringify({ appId: "production-app" }));
    },
    client: () => ({ listFiles: async () => { throw new Error("must not list"); }, deleteFiles: async () => { throw new Error("must not delete"); } }),
  });
  await assert.rejects(reset(execute, deps), /RESET_PROVIDER_APP_UNVERIFIED/);
  assert.equal(deps.calls.includes("clear"), false);
  assert.equal(deps.saved[0].unresolved[0].key, "owned");
});
test("provider scopes inventory to authenticated uploaded files and checks deletion counts (fake requests only)", async () => {
  const token = Buffer.from(JSON.stringify({ appId: config.uploadthingAppId, apiKey: "fake-key-only" })).toString("base64");
  const deletes: unknown[] = [];
  const provider = uploadthingResetProvider(token, config.uploadthingAppId, {
    fetch: async () => new Response(JSON.stringify({ appId: config.uploadthingAppId })),
    client: () => ({
      listFiles: async () => ({ files: [{ key: "owned", id: "id", name: "example", size: 1, customId: null, status: "Uploaded", uploadedAt: 0 }], hasMore: false }),
      deleteFiles: async keys => { deletes.push(keys); return { success: true, deletedCount: 0 }; },
    }),
  });
  await assert.rejects(provider.ownedKeys(["owned"]), /RESET_PROVIDER_APP_UNVERIFIED/);
  assert.equal(await provider.appId(), config.uploadthingAppId);
  const owned = await provider.ownedKeys(["owned", "other-app-key"]);
  assert.equal(owned.has("owned"), true);
  assert.equal(owned.has("other-app-key"), false);
  assert.deepEqual(await provider.delete("owned"), { outcome: "unknown" });
  assert.deepEqual(deletes, [["owned"]]);
});
test("provider failure and uncertain acknowledgements retain unresolved keys before old rows clear", async () => {
  for (const outcome of ["throws", "unknown", "failed_retryable", "failed_permanent"] as const) {
    const deps = fixture();
    deps.provider.delete = async () => { if (outcome === "throws") throw new Error("private provider body"); return { outcome }; };
    deps.backend.clear = async () => {
      assert.equal(deps.saved.at(-1)!.unresolved[0].key, "owned");
      assert.notEqual(deps.saved.at(-1)!.unresolved[0].outcome, "deleted");
      deps.state.data = {};
    };
    const manifest = await reset(execute, deps);
    assert.equal(manifest.unresolved.length, 1);
    assert.equal(manifest.media[0].outcome, outcome === "throws" ? "unknown" : outcome);
  }
});
test("only proven scoped media is deleted; re-export precedes clear and configuration precedes push", async () => {
  const deps = fixture();
  const result = await reset(execute, deps);
  assert.deepEqual(deps.calls, ["environment", "inventory", "app", "list", "delete", "environment", "inventory", "clear", "inventory", "configure", "inventory", "push", "inventory", "bootstrap", "seed-and-verify"]);
  assert.deepEqual(deps.saved.slice(-5).map(item => item.stage), ["rows-cleared", "configured", "pushed", "owner-ready", "verified"]);
  assert.equal(result.unresolved.length, 0);
  assert.equal(deps.saved[1].media[0].outcome, "unknown");
  assert.equal(result.stage, "verified");
  const unowned = fixture(); unowned.provider.ownedKeys = async () => new Set();
  assert.equal((await reset(execute, unowned)).unresolved[0].outcome, "unverified");
  assert.equal(unowned.calls.includes("delete"), false);
});
test("reset rejects enabled or malformed scheduler flags and stops on failed verification", async () => {
  for (const flag of [undefined, "true", "TRUE", "1", "", "FALSE", " false ", "false "]) {
    const deps = fixture(); deps.backend.environment = async () => { const env: Record<string, string> = {}; if (flag !== undefined) env.MEDIA_CLEANUP_ENABLED = flag; return env; };
    await assert.rejects(reset(execute, deps), /RESET_SCHEDULERS_NOT_PAUSED/);
    assert.equal(deps.saved.length, 0);
  }
  const deps = fixture(); deps.backend.seedAndVerify = async () => { throw new Error("verification failed"); };
  await assert.rejects(reset(execute, deps), /verification failed/);
  assert.equal(deps.saved.at(-1)!.stage, "owner-ready");
});
test("local target requires fake provider and leaves non-fixture keys unresolved", async () => {
  const cwd = process.cwd();
  const directory = mkdtempSync(join(tmpdir(), "ticket-reset-local-"));
  try {
    mkdirSync(join(directory, ".convex/local/default"), { recursive: true });
    writeFileSync(join(directory, ".convex/local/default/config.json"), JSON.stringify({ deploymentName: "anonymous-agent" }));
    process.chdir(directory);
    const deps = fixture();
    const target = localResetTarget();
    const local = { ...execute, local: true, confirm: target, expect: { ...reviewed, target } };
    await assert.rejects(reset({ ...local, confirm: "anonymous:anonymous-track-ease-pos" }, deps), /RESET_CONFIRM_REQUIRED/);
    await assert.rejects(reset({ ...local, expect: { ...reviewed, target: "anonymous:anonymous-track-ease-pos" } }, deps), /RESET_INSPECT_MANIFEST_REQUIRED/);
    await assert.rejects(reset(local, deps), /LOCAL_PROVIDER_MUST_BE_FAKE/);
    assert.deepEqual(deps.calls, []);
    deps.provider = fakeResetProvider();
    const result = await reset(local, deps);
    assert.equal(result.target, "anonymous:anonymous-agent");
    assert.equal(result.unresolved[0].outcome, "unverified");
  } finally { process.chdir(cwd); rmSync(directory, { recursive: true, force: true }); }
});

test("local reset identities require this checkout's configured anonymous backend", () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-reset-target-"));
  try {
    assert.equal(localDeploymentName(directory), null);
    assert.throws(() => localResetTarget(directory), /RESET_LOCAL_TARGET_UNAVAILABLE/);
    mkdirSync(join(directory, ".convex/local/default"), { recursive: true });
    const file = join(directory, ".convex/local/default/config.json");
    for (const name of ["anonymous-agent", "anonymous-track-ease-pos", "anonymous-other-checkout"]) {
      writeFileSync(file, JSON.stringify({ deploymentName: name }));
      assert.equal(localResetTarget(directory), `anonymous:${name}`);
    }
    for (const config of ["malformed", "null", "{}", ...["dev:shared", "prod:never", "shared", "anonymous:anonymous-agent", "anonymous-agent\n"].map(deploymentName => JSON.stringify({ deploymentName }))]) {
      writeFileSync(file, config);
      assert.throws(() => localResetTarget(directory), /LOCAL_DEPLOYMENT_REFUSED/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("inventory deduplicates registry, nested old media, upload receipts and job snapshots without counting Project keys", () => {
  const manifest = inventory({ projects: [{ _id: "project", key: "POS" }], mediaAssets: [{ _id: "asset", key: "same", metadata: { key: "same", url: "https://example.invalid" } }], uploadIntents: [{ _id: "intent", uploadedFiles: [{ key: "same", url: "https://example.invalid" }] }], mediaJobs: [{ _id: "job", keys: ["same", "uncertain"] }] }, "dev:fixture");
  assert.deepEqual(manifest.media.map(item => item.key), ["same", "uncertain"]);
  assert.equal(manifest.media[0].sources.length, 4);
});

test("snapshot inventory reads root and nested component rows and skips table metadata", () => {
  const zip = new AdmZip();
  for (const [table, id] of [["_tables", "metadata"], ["_components/auth/_tables", "metadata"], ["sessions", "app"], ["_components/auth/sessions", "auth"], ["_components/authPassword/_components/rateLimiter/rateLimits", "rate"]]) {
    zip.addFile(`${table}/documents.jsonl`, Buffer.from(JSON.stringify({ _id: id }) + "\n"));
  }
  assert.deepEqual(inventory(readSnapshot(zip), config.deployment).rowIds, {
    sessions: ["app"], "_components/auth/sessions": ["auth"], "_components/authPassword/_components/rateLimiter/rateLimits": ["rate"],
  });
  zip.addFile("projects/documents.jsonl", Buffer.from('{"name":"Missing ID"}\n'));
  assert.throws(() => readSnapshot(zip), /RESET_SNAPSHOT_UNPARSEABLE/);
  assert.throws(() => readSnapshot(new AdmZip()), /RESET_SNAPSHOT_UNPARSEABLE/);
});

test("execute requires a reviewed inspect manifest for the exact target before I/O", async () => {
  for (const expect of [undefined, { ...reviewed, target: "dev:other" }, { ...reviewed, stage: "verified" }, { ...reviewed, rowIds: undefined }, { ...reviewed, stage: "execution-inventoried" }]) {
    const deps = fixture();
    await assert.rejects(reset({ ...execute, expect }, deps), /RESET_INSPECT_MANIFEST_REQUIRED/);
    assert.deepEqual(deps.calls, []);
  }
});

test("inventory growth since reviewed inspection aborts before provider I/O or clearing", async () => {
  const deps = fixture();
  await assert.rejects(reset({ ...execute, expect: { ...reviewed, media: [] } }, deps), /RESET_INVENTORY_GREW/);
  assert.deepEqual(deps.calls, ["environment", "inventory"]);
  assert.equal(deps.saved[0].unresolved[0].key, "owned");
});

test("new keys in the last export abort clearing and preserve old outcomes plus new unresolved sources", async () => {
  const deps = fixture();
  const deleteKey = deps.provider.delete;
  deps.provider.delete = async key => {
    deps.state.data = { ...oldData, mediaAssets: [{ _id: "new-asset", key: "new-key" }] };
    return await deleteKey(key);
  };
  await assert.rejects(reset(execute, deps), /RESET_INVENTORY_GREW/);
  assert.equal(deps.calls.includes("delete"), true);
  assert.equal(deps.calls.includes("clear"), false);
  assert.equal(deps.saved.at(-1)!.stage, "inventory-grew-before-clear");
  assert.deepEqual(deps.saved.at(-1)!.media.map(item => [item.key, item.outcome]), [["owned", "deleted"], ["new-key", "unverified"]]);
  assert.equal(deps.saved.at(-1)!.unresolved[0].key, "new-key");
});

test("rows added since inspection or before clear require fresh authorization even when counts and keys match", async () => {
  const old = fixture();
  const replacement: Snapshot = { ...oldData, sessions: [{ _id: "replacement-session" }] };
  const beforeProvider = fixture(replacement);
  await assert.rejects(reset(execute, beforeProvider), /RESET_ROWS_ADDED/);
  assert.deepEqual(beforeProvider.calls, ["environment", "inventory"]);
  assert.equal(beforeProvider.saved[0].stage, "execution-inventoried");

  old.provider.delete = async () => { old.state.data = replacement; return { outcome: "deleted" }; };
  await assert.rejects(reset(execute, old), /RESET_ROWS_ADDED/);
  assert.equal(old.calls.includes("clear"), false);
  assert.equal(old.saved.at(-1)!.stage, "inventory-grew-before-clear");
  assert.equal(old.saved.at(-1)!.media[0].outcome, "deleted");

  const newInspection = await reset({ ...execute, mode: "inspect" }, old);
  old.provider.delete = async () => ({ outcome: "absent_verified" });
  assert.equal((await reset({ ...execute, expect: newInspection }, old)).stage, "verified");
});

test("a named pilot installed during media settlement refuses the final clear and retains discovered keys", async () => {
  const deps = fixture();
  deps.provider.delete = async () => {
    deps.state.data = { ...oldData, pilotRelease: [{ _id: "release" }], mediaAssets: [{ _id: "late", key: "pilot-key" }] };
    return { outcome: "deleted" };
  };
  await assert.rejects(reset(execute, deps), /RESET_PILOT_INSTALLED/);
  assert.equal(deps.calls.includes("clear"), false);
  assert.deepEqual(deps.saved.at(-1)!.unresolved.map(item => item.key), ["pilot-key"]);
});

test("execution rechecks deployment mode and cleanup before the authorized clear", async () => {
  for (const [change, error] of [
    [{ TICKET_DEPLOYMENT_MODE: "named-pilot" }, /RESET_LEGACY_MODE_REQUIRED/],
    [{ MEDIA_CLEANUP_ENABLED: "true" }, /RESET_SCHEDULERS_NOT_PAUSED/],
    [{ UPLOADTHING_TOKEN: "restored" }, /RESET_PROVIDER_TOKEN_MUST_BE_REMOVED/],
  ] as const) {
    const deps = fixture();
    let reads = 0;
    deps.backend.environment = async () => ({ ...ready, ...(reads++ > 0 ? change : {}) });
    await assert.rejects(reset(execute, deps), error);
    assert.equal(deps.calls.includes("clear"), false);
    assert.equal(deps.saved.at(-1)!.stage, "media-settled");
  }
});

test("old cron token must be removed, including an empty token, before inventory", async () => {
  for (const token of ["old-secret", ""]) {
    const deps = fixture();
    deps.backend.environment = async () => ({ ...ready, UPLOADTHING_TOKEN: token });
    await assert.rejects(reset(execute, deps), /RESET_PROVIDER_TOKEN_MUST_BE_REMOVED/);
    assert.deepEqual(deps.calls, []);
    assert.equal(deps.saved.length, 0);
  }
});

test("failed, partial or malformed provider listing aborts all deletion and clearing, even on an empty backend", async () => {
  const token = Buffer.from(JSON.stringify({ appId: config.uploadthingAppId, apiKey: "fake" })).toString("base64");
  for (const failure of ["first", "second", "empty", "malformed", "duplicate"]) {
    const deps = fixture();
    let lists = 0;
    let deletes = 0;
    deps.provider = uploadthingResetProvider(token, config.uploadthingAppId, {
      fetch: async () => new Response(JSON.stringify({ appId: config.uploadthingAppId })),
      client: () => ({
        listFiles: async () => {
          lists++;
          if (failure === "first" || (lists === 2 && failure === "second")) throw new Error("list failed");
          if (lists === 2 && failure === "empty") return { files: [], hasMore: true };
          if (lists === 2 && failure === "malformed") return JSON.parse('{"files":[]}');
          return { files: [{ key: "owned", id: "id", name: "example", size: 1, customId: null, status: "Uploaded", uploadedAt: 0 }], hasMore: true };
        },
        deleteFiles: async () => { deletes++; return { success: true, deletedCount: 1 }; },
      }),
    });
    await assert.rejects(reset(execute, deps), /list failed|RESET_PROVIDER_INCOMPLETE_INVENTORY/);
    assert.equal(deletes, 0);
    assert.equal(deps.calls.includes("clear"), false);
    // A failed list must not expose even its successfully fetched first page.
    await assert.rejects(deps.provider.delete("owned"), /RESET_PROVIDER_OWNERSHIP_UNVERIFIED/);
  }
  const empty = fixture();
  empty.backend.snapshot = async () => ({});
  empty.provider.ownedKeys = async () => { throw new Error("listing failed"); };
  await assert.rejects(reset({ ...execute, expect: { ...reviewed, media: [] } }, empty), /listing failed/);
  assert.equal(empty.calls.includes("clear"), false);
});

test("execution requires explicit legacy mode and the Owner bootstrap settings before inventory; inspection does not", async () => {
  const cases: [Record<string, string | undefined>, RegExp][] = [
    [{ OWNER_BOOTSTRAP_GOOGLE_SUBJECT: undefined }, /RESET_OWNER_BOOTSTRAP_NOT_READY/],
    [{ OWNER_BOOTSTRAP_GOOGLE_SUBJECT: "  " }, /RESET_OWNER_BOOTSTRAP_NOT_READY/],
    [{ AUTH_REDIRECT_ORIGINS: undefined }, /RESET_OWNER_BOOTSTRAP_NOT_READY/],
    [{ AUTH_REDIRECT_ORIGINS: "http://localhost:5173,http://127.0.0.1:42710" }, /RESET_OWNER_BOOTSTRAP_NOT_READY/],
    [{ CLERK_OAUTH_CLIENT_SECRET: undefined }, /RESET_IDENTITY_SETTINGS_REQUIRED/],
    [{ TICKET_DEPLOYMENT_MODE: undefined }, /RESET_LEGACY_MODE_REQUIRED/],
    [{ TICKET_DEPLOYMENT_MODE: "named-pilot" }, /RESET_LEGACY_MODE_REQUIRED/],
    [{ TICKET_PILOT_TRAFFIC: "closed" }, /RESET_LEGACY_MODE_REQUIRED/],
  ];
  for (const [change, error] of cases) {
    const deps = fixture();
    const env: Record<string, string> = { ...ready };
    for (const [key, value] of Object.entries(change)) { if (value === undefined) delete env[key]; else env[key] = value; }
    deps.backend.environment = async () => { deps.calls.push("environment"); return env; };
    await assert.rejects(reset(execute, deps), error);
    assert.deepEqual(deps.calls, ["environment"]);
    assert.equal(deps.saved.length, 0);
    assert.equal((await reset({ ...execute, mode: "inspect", confirm: undefined }, deps)).stage, "inventoried");
  }
  // The disposable backend defaults to legacy and configures its own fixture Owner subject.
  assert.equal(resetReadiness({ CLERK_OAUTH_CLIENT_ID: "placeholder", CLERK_OAUTH_CLIENT_SECRET: "placeholder" }, true), undefined);
  assert.equal(resetReadiness({ CLERK_OAUTH_CLIENT_ID: "placeholder", CLERK_OAUTH_CLIENT_SECRET: "placeholder", TICKET_DEPLOYMENT_MODE: "named-pilot" }, true), "RESET_LEGACY_MODE_REQUIRED");
  assert.equal(resetReadiness({}, true), "RESET_IDENTITY_SETTINGS_REQUIRED");
});

test("an installed named pilot is never reset: refusal follows the saved inventory and precedes provider I/O", async () => {
  const deps = fixture({ pilotRelease: [{ _id: "release" }] });
  await assert.rejects(reset({ ...execute, expect: { ...reviewed, media: [] } }, deps), /RESET_PILOT_INSTALLED/);
  assert.deepEqual(deps.calls, ["environment", "inventory"]);
  assert.equal(deps.saved[0].counts.pilotRelease, 1);
});

/** Executes until `failAt` throws once, then returns the run's latest manifest and the shared backend state. */
async function interrupted(failAt: "configure" | "push" | "bootstrapOwner" | "seedAndVerify") {
  const deps = fixture();
  const original = deps.backend[failAt];
  deps.backend[failAt] = async () => { throw new Error(`${failAt} interrupted`); };
  await assert.rejects(reset(execute, deps), new RegExp(`${failAt} interrupted`));
  deps.backend[failAt] = original;
  return { manifest: deps.saved.at(-1)!, state: deps.state };
}
function resumed(manifest: Manifest, state: { data: Snapshot }) {
  const deps = fixture(state.data);
  return { deps, run: () => resume({ local: false, deployment: config.deployment, confirm: config.deployment, manifest: structuredClone(manifest), config }, deps) };
}

test("cleared runs inspect before writes, then resume from their saved stage without provider I/O or clearing", async () => {
  const expected = {
    configure: ["rows-cleared", ["environment", "inventory", "configure", "inventory", "push", "inventory", "bootstrap", "seed-and-verify"]],
    push: ["configured", ["environment", "inventory", "push", "inventory", "bootstrap", "seed-and-verify"]],
    // The erased Owner session is replaced: bootstrap again only while no Owner exists.
    bootstrapOwner: ["pushed", ["environment", "inventory", "bootstrap", "seed-and-verify"]],
    seedAndVerify: ["owner-ready", ["environment", "inventory", "seed-and-verify"]],
  } as const;
  for (const [failAt, [stage, calls]] of Object.entries(expected)) {
    const { manifest, state } = await interrupted(failAt as keyof typeof expected);
    assert.equal(manifest.stage, stage);
    assert.equal(manifest.unresolved.length, 0);
    const { deps, run } = resumed(manifest, state);
    const result = await run();
    assert.deepEqual(deps.calls, calls, failAt);
    assert.equal(result.stage, "verified");
    assert.deepEqual(result.media, manifest.media);
    assert.deepEqual(deps.saved.at(-1)!.stage, "verified");
  }
});

test("a committed Owner bootstrap is reusable at pushed even if the owner-ready stage was not saved", async () => {
  const { manifest } = await interrupted("bootstrapOwner");
  for (const data of [bootstrapped, { ...bootstrapped, "_components/auth/refreshTokens": [{ _id: "token", sessionId: "pending-session", state: "issued" }] }]) {
    const { deps, run } = resumed(manifest, { data });
    assert.equal((await run()).stage, "verified");
    assert.deepEqual(deps.calls, ["environment", "inventory", "seed-and-verify"]);
  }
});

test("unexpected rows and installed pilots block resume before any writes and require a fresh inspection", async () => {
  const { manifest } = await interrupted("seedAndVerify");
  const cases: [Snapshot, RegExp][] = [
    [{ ...bootstrapped, projects: [{ _id: "POS" }], tickets: [{ _id: "seeded", title: "Printer calibration" }] }, /RESET_POST_CLEAR_ROWS_FOUND/],
    [{ projectInvitations: [{ _id: "invitation" }] }, /RESET_POST_CLEAR_ROWS_FOUND/],
    [{ "_components/auth/sessions": [{ _id: "unexpected" }] }, /RESET_POST_CLEAR_ROWS_FOUND/],
    [{ ...bootstrapped, _unknown: [{ _id: "unexpected" }] }, /RESET_POST_CLEAR_ROWS_FOUND/],
    [{ pilotRelease: [{ _id: "release" }] }, /RESET_PILOT_INSTALLED/],
  ];
  for (const stage of ["rows-cleared", "configured", "pushed", "owner-ready"]) {
    for (const [data, error] of cases) {
      const { deps, run } = resumed({ ...manifest, stage }, { data });
      await assert.rejects(run(), error);
      assert.deepEqual(deps.calls, ["environment", "inventory"]);
      assert.deepEqual(deps.state.data, data);
      assert.equal(deps.saved.at(-1)!.stage, "post-clear-blocked");
      const blocked = resumed(deps.saved.at(-1)!, { data: {} });
      await assert.rejects(blocked.run(), /RESET_RESUME_REQUIRES_INSPECTION/);
      assert.deepEqual(blocked.deps.calls, []);
    }
  }
});

test("a row installed during resumed configuration prevents the schema push", async () => {
  const { manifest, state } = await interrupted("configure");
  const { deps, run } = resumed(manifest, state);
  const configure = deps.backend.configure;
  deps.backend.configure = async () => {
    await configure();
    deps.state.data = { pilotRelease: [{ _id: "release" }] };
  };
  await assert.rejects(run(), /RESET_PILOT_INSTALLED/);
  assert.deepEqual(deps.calls, ["environment", "inventory", "configure", "inventory"]);
  assert.equal(deps.saved.at(-1)!.stage, "post-clear-blocked");
});

test("an Owner-shaped snapshot without bootstrap proof cannot bypass the resume guard", async () => {
  const { manifest } = await interrupted("seedAndVerify");
  const cases: Snapshot[] = [
    { staff: [owner] },
    { ...bootstrapped, staff: [owner, { ...owner, _id: "second" }] },
    { ...bootstrapped, staff: [{ ...owner, generation: 2 }] },
    { ...bootstrapped, staff: [{ ...owner, status: "disabled" }] },
    { ...bootstrapped, staff: [{ ...owner, googleSubject: "other" }] },
    { ...bootstrapped, identityAudit: [{ ...bootstrapped.identityAudit[0], staffId: "other" }] },
    { ...bootstrapped, users: [{ ...bootstrapped.users[0], staffId: "other" }] },
    { ...bootstrapped, "_components/authGoogle/accounts": [{ ...bootstrapped["_components/authGoogle/accounts"][0], userId: "other" }] },
    { ...bootstrapped, sessionAdmissions: [{ ...bootstrapped.sessionAdmissions[0], revokedAt: undefined }] },
    { ...bootstrapped, "_components/auth/refreshTokens": [{ _id: "token", sessionId: "other-session", state: "issued" }] },
  ];
  for (const data of cases) {
    const { deps, run } = resumed(manifest, { data });
    await assert.rejects(run(), /RESET_POST_CLEAR_ROWS_FOUND/);
    assert.deepEqual(deps.calls, ["environment", "inventory"]);
  }
});

test("post-clear media blocks resume and preserves prior outcomes and new unresolved sources", async () => {
  const { manifest } = await interrupted("seedAndVerify");
  const media = resumed(manifest, { data: { ...bootstrapped, tickets: [{ _id: "late", media: [
    { key: "late-key", url: "https://example.invalid/late" }, { key: "owned", url: "https://example.invalid/owned" },
  ] }] } });
  await assert.rejects(media.run(), /RESET_POST_CLEAR_MEDIA_FOUND/);
  assert.deepEqual(media.deps.calls, ["environment", "inventory"]);
  const saved = media.deps.saved.at(-1)!;
  assert.equal(saved.stage, "post-clear-blocked");
  assert.equal(saved.media[0].outcome, "deleted");
  assert.deepEqual(saved.unresolved.map(item => [item.key, item.sources]), [
    ["late-key", ["tickets/late.media[0].key"]], ["owned", ["tickets/late.media[1].key", "tickets/old-ticket.media[0].key"]],
  ]);
});

test("resume refuses another identity, a foreign or uncleared manifest, a verified run and resumed cleanup before writes", async () => {
  const { manifest, state } = await interrupted("bootstrapOwner");
  const cases: [Partial<Parameters<typeof resume>[0]>, RegExp][] = [
    [{ confirm: undefined }, /RESET_CONFIRM_REQUIRED/],
    [{ confirm: "dev:other-123" }, /RESET_CONFIRM_REQUIRED/],
    [{ deployment: "prod:disposable-123" }, /RESET_TARGET_REFUSED/],
    [{ manifest: undefined }, /RESET_RUN_MANIFEST_REQUIRED/],
    [{ manifest: { ...manifest, target: "dev:other-123" } }, /RESET_RUN_MANIFEST_REQUIRED/],
    [{ manifest: { ...manifest, stage: "verified" } }, /RESET_ALREADY_VERIFIED/],
    ...["inventoried", "execution-inventoried", "media-settled", "inventory-grew-before-clear"].map(stage => [{ manifest: { ...manifest, stage } }, /RESET_RESUME_REQUIRES_CLEARED_RUN/] as [Partial<Parameters<typeof resume>[0]>, RegExp]),
  ];
  for (const [change, error] of cases) {
    const deps = fixture(state.data);
    await assert.rejects(resume({ local: false, deployment: config.deployment, confirm: config.deployment, manifest, config, ...change }, deps), error);
    assert.deepEqual(deps.calls, []);
    assert.equal(deps.saved.length, 0);
  }
  for (const flag of ["true", ""]) {
    const deps = fixture(state.data);
    deps.backend.environment = async () => { deps.calls.push("environment"); return { ...ready, MEDIA_CLEANUP_ENABLED: flag }; };
    await assert.rejects(resume({ local: false, deployment: config.deployment, confirm: config.deployment, manifest, config }, deps), /RESET_SCHEDULERS_NOT_PAUSED/);
    assert.deepEqual(deps.calls, ["environment"]);
  }
});
