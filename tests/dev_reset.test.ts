import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inventory, reset, type Manifest, type ResetBackend, type ResetProvider } from "../scripts/dev-reset/core";
import { fakeResetProvider, uploadthingResetProvider } from "../scripts/dev-reset/provider";
import { localDeploymentName, localResetTarget } from "../scripts/dev-reset-target.mjs";

const config = { deployment: "dev:disposable-123", uploadthingAppId: "dev-app" };
function fixture() {
  const calls: string[] = [];
  const saved: Manifest[] = [];
  const backend: ResetBackend = {
    environment: async () => { calls.push("environment"); return { MEDIA_CLEANUP_ENABLED: "false" }; },
    snapshot: async () => { calls.push("inventory"); return { sessions: [{ _id: "old-session" }], tickets: [{ _id: "old-ticket", media: [{ key: "owned", url: "https://example.invalid/f/owned" }] }] }; },
    clear: async () => { calls.push("clear"); }, push: async () => { calls.push("push"); },
    configure: async () => { calls.push("configure"); }, seedAndVerify: async () => { calls.push("seed-and-verify"); },
  };
  const provider: ResetProvider = {
    kind: "uploadthing", appId: async () => { calls.push("app"); return "dev-app"; },
    ownedKeys: async keys => { calls.push("list"); return new Set(keys); }, delete: async () => { calls.push("delete"); return { outcome: "deleted" }; },
  };
  return { calls, saved, backend, provider, save: async (manifest: Manifest) => { saved.push(structuredClone(manifest)); } };
}
const reviewed = inventory({ tickets: [{ media: [{ key: "owned", url: "https://example.invalid" }] }] }, config.deployment);
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
    };
    const manifest = await reset(execute, deps);
    assert.equal(manifest.unresolved.length, 1);
    assert.equal(manifest.media[0].outcome, outcome === "throws" ? "unknown" : outcome);
  }
});
test("only proven scoped media is deleted; re-export precedes clear and configuration precedes push", async () => {
  const deps = fixture();
  const result = await reset(execute, deps);
  assert.deepEqual(deps.calls, ["environment", "inventory", "app", "list", "delete", "inventory", "clear", "configure", "push", "seed-and-verify"]);
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
  assert.equal(deps.saved.at(-1)!.stage, "rows-cleared");
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
  const manifest = inventory({ projects: [{ key: "POS" }], mediaAssets: [{ _id: "asset", key: "same", metadata: { key: "same", url: "https://example.invalid" } }], uploadIntents: [{ uploadedFiles: [{ key: "same", url: "https://example.invalid" }] }], mediaJobs: [{ keys: ["same", "uncertain"] }] }, "dev:fixture");
  assert.deepEqual(manifest.media.map(item => item.key), ["same", "uncertain"]);
  assert.equal(manifest.media[0].sources.length, 4);
});

test("execute requires a reviewed inspect manifest for the exact target before I/O", async () => {
  for (const expect of [undefined, { ...reviewed, target: "dev:other" }, { ...reviewed, stage: "verified" }]) {
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
  let exports = 0;
  deps.backend.snapshot = async () => ({ mediaAssets: [{ key: "owned" }, ...(exports++ ? [{ key: "new-key" }] : [])] });
  await assert.rejects(reset(execute, deps), /RESET_INVENTORY_GREW/);
  assert.equal(deps.calls.includes("delete"), true);
  assert.equal(deps.calls.includes("clear"), false);
  assert.equal(deps.saved.at(-1)!.stage, "inventory-grew-before-clear");
  assert.deepEqual(deps.saved.at(-1)!.media.map(item => [item.key, item.outcome]), [["owned", "deleted"], ["new-key", "unverified"]]);
  assert.equal(deps.saved.at(-1)!.unresolved[0].key, "new-key");
});

test("old cron token must be removed, including an empty token, before inventory", async () => {
  for (const token of ["old-secret", ""]) {
    const deps = fixture();
    deps.backend.environment = async () => ({ MEDIA_CLEANUP_ENABLED: "false", UPLOADTHING_TOKEN: token });
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
