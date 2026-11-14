import assert from "node:assert/strict";
import test from "node:test";
import { ConvexError } from "convex/values";
import { createUploadApp } from "../server/app";
import { cancelUploadHandler } from "../server/handlers/cancel-upload";
import { createStorage } from "../server/storage";
import { StorageConfigurationError } from "../shared/storage";

function request(body: string, authorized = true) {
  return new Request("http://local.test/api/uploads/cancel", { method: "POST", body,
    headers: authorized ? { authorization: "Bearer actor" } : {} });
}
const valid = JSON.stringify({ intentId: "intent", secret: "secret" });

test("both HTTP adapters share cancellation decoding, authorization, acknowledgement and safe failures", async () => {
  let cancelled = 0;
  const handler = cancelUploadHandler({
    cancel: async input => { assert.equal(input.token, "actor"); cancelled++; return { keys: ["fake"] }; },
    storage: () => ({ deleteFiles: async keys => { assert.deepEqual(keys, ["fake"]); return { outcome: "deleted" }; } }),
  });
  const hono = createUploadApp({ cancelUpload: handler }, async () => new Response());
  for (const adapter of [handler, (request: Request) => hono.request(request)]) {
    const before = cancelled;
    assert.equal((await adapter(request(valid, false))).status, 401);
    for (const body of ["not-json", "null", "[]", '{}', '{"intentId":2,"secret":"x"}']) {
      assert.equal((await adapter(request(body))).status, 400);
    }
    assert.equal(cancelled, before);
    assert.deepEqual(await (await adapter(request(valid))).json(), { ok: true, deleted: 1 });
  }
  const denied = cancelUploadHandler({ cancel: async () => { throw new ConvexError({ code: "SESSION_EXPIRED" }); }, storage: () => ({ deleteFiles: async () => ({ outcome: "deleted" }) }) });
  assert.equal((await denied(request(valid))).status, 401);
  const unknown = cancelUploadHandler({ cancel: async () => ({ keys: ["fake"] }), storage: () => ({ deleteFiles: async () => ({ outcome: "unknown" }) }) });
  const response = await unknown(request(valid));
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "UPLOAD_CLEANUP_UNKNOWN" });
  const failed = cancelUploadHandler({ cancel: async () => { throw new Error("provider secret and Ticket content"); }, storage: () => ({ deleteFiles: async () => ({ outcome: "deleted" }) }) });
  assert.deepEqual(await (await failed(request(valid))).json(), { error: "UPLOAD_CLEANUP_FAILED" });
});

test("missing provider configuration is a typed failure before cancellation commits", async () => {
  for (const create of [createStorage]) {
    assert.throws(() => create(undefined), error => error instanceof StorageConfigurationError && error.code === "STORAGE_NOT_CONFIGURED");
  }
  let cancelled = false;
  const handler = cancelUploadHandler({ cancel: async () => { cancelled = true; return { keys: ["fake"] }; }, storage: () => createStorage(undefined) });
  const response = await handler(request(valid));
  assert.equal(response.status, 503);
  assert.equal(cancelled, false);
  assert.deepEqual(await response.json(), { error: "STORAGE_NOT_CONFIGURED" });
});
