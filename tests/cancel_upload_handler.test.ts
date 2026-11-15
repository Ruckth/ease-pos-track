import assert from "node:assert/strict";
import test from "node:test";
import { ConvexError } from "convex/values";
import { createUploadApp } from "../server/app";
import { cancelUploadHandler } from "../server/handlers/cancel-upload";
import { createStorage } from "../convex/adapters/storage";
import { StorageConfigurationError } from "../shared/storage";

function request(body: string, authorized = true) {
  return new Request("http://local.test/api/uploads/cancel", { method: "POST", body,
    headers: authorized ? { authorization: "Bearer actor" } : {} });
}
const valid = JSON.stringify({ intentId: "intent", secret: "secret" });

test("both HTTP adapters return queued reservations without calling storage or claiming deletion", async () => {
  let cancelled = 0;
  const handler = cancelUploadHandler({
    cancel: async input => { assert.equal(input.token, "actor"); cancelled++; return { state: "queued", jobIds: ["job"] }; },
  });
  const hono = createUploadApp({ cancelUpload: handler }, async () => new Response());
  for (const adapter of [handler, (request: Request) => hono.request(request)]) {
    const before = cancelled;
    assert.equal((await adapter(request(valid, false))).status, 401);
    for (const body of ["not-json", "null", "[]", '{}', '{"intentId":2,"secret":"x"}']) {
      assert.equal((await adapter(request(body))).status, 400);
    }
    assert.equal(cancelled, before);
    assert.deepEqual(await (await adapter(request(valid))).json(), { ok: true, state: "queued", jobIds: ["job"] });
  }
  const denied = cancelUploadHandler({ cancel: async () => { throw new ConvexError({ code: "SESSION_EXPIRED" }); } });
  assert.equal((await denied(request(valid))).status, 401);
  for (const error of [new ConvexError({ code: "secret-key-or-token" })]) {
    const failed = cancelUploadHandler({ cancel: async () => { throw error; } });
    assert.deepEqual(await (await failed(request(valid))).json(), { error: "UPLOAD_CLEANUP_FAILED" });
  }
});

test("typed storage normalizes provider acknowledgements and sanitizes configuration and provider errors", async () => {
  assert.throws(() => createStorage(""), error => error instanceof StorageConfigurationError && error.code === "STORAGE_NOT_CONFIGURED");
  assert.throws(() => createStorage("fake-token", () => { throw new Error("secret provider config"); }), /STORAGE_NOT_CONFIGURED/);
  for (const result of [{ success: true, deletedCount: 2 }, { success: false, deletedCount: 2 }, { success: true, deletedCount: 1 }, { success: true, deletedCount: 0 }]) {
    const storage = createStorage("fake-token", token => {
      assert.equal(token, "fake-token");
      return { deleteFiles: async keys => { assert.deepEqual(keys, ["fake-a", "fake-b"]); return result; } };
    });
    assert.deepEqual(await storage.deleteFiles(["fake-a", "fake-b"]), { outcome: result.success && result.deletedCount === 2 ? "deleted" : "unknown" });
  }
  const storage = createStorage("fake-token", () => ({ deleteFiles: async () => { throw new Error("key/url/token/Ticket content"); } }));
  assert.deepEqual(await storage.deleteFiles(["fake"]), { outcome: "unknown" });
  assert.deepEqual(await storage.deleteFiles([]), { outcome: "deleted" });
});


test("both cancellation adapters distinguish unknown transport outcomes from rejection", async () => {
  const handler = cancelUploadHandler({ cancel: async () => { throw new Error("transport contains private data"); } });
  const hono = createUploadApp({ cancelUpload: handler }, async () => new Response());
  for (const adapter of [handler, (request: Request) => hono.request(request)]) {
    const response = await adapter(request(valid));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "UPLOAD_CLEANUP_UNKNOWN", outcome: "unknown" });
  }
});

test("provider app verification looks up the requested key regardless of app size and fails closed", async () => {
  const lookedUp: string[][] = [];
  const storage = createStorage("fake-token", () => ({
    deleteFiles: async () => { throw new Error("verification must not delete"); },
    getFileUrls: async keys => {
      lookedUp.push(keys);
      return { data: keys[0] === "owned-after-500" ? [{ key: keys[0], url: "https://fake.invalid/file" }] : [] };
    },
  }));
  assert.equal(await storage.verifyAppKey("owned-after-500"), true);
  assert.equal(await storage.verifyAppKey("missing"), false);
  assert.deepEqual(lookedUp, [["owned-after-500"], ["missing"]]);
  for (const provider of [
    { getFileUrls: async () => ({ data: [{ key: "different", url: "https://fake.invalid/file" }] }) },
    { getFileUrls: async () => ({ data: [{ key: "owned", url: "" }] }) },
    { getFileUrls: async () => { throw new Error("private provider body"); } },
    {},
  ]) {
    assert.equal(await createStorage("fake-token", () => ({ ...provider, deleteFiles: async () => ({ success: true, deletedCount: 0 }) })).verifyAppKey("owned"), false);
  }
});

test("both cancellation adapters expose failed jobs without a false queued or completed acknowledgement", async () => {
  const handler = cancelUploadHandler({ cancel: async () => ({ state: "failed", jobIds: ["job"] }) });
  const hono = createUploadApp({ cancelUpload: handler }, async () => new Response());
  for (const adapter of [handler, (request: Request) => hono.request(request)]) {
    const response = await adapter(request(valid));
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "UPLOAD_CLEANUP_FAILED", jobIds: ["job"] });
  }
});
