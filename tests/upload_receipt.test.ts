import assert from "node:assert/strict";
import test from "node:test";
import { ConvexError } from "convex/values";
import { ConvexHttpClient } from "convex/browser";
import type { Id } from "../convex/_generated/dataModel";
import { definitiveUploadRejection, reconcileUploadWrite } from "../shared/upload-receipt";
import { recordUploadHandler } from "../server/handlers/record-upload";
import { createUploadRouter } from "../server/uploadthing";
import { internalError, remoteError } from "../scripts/ticket/errors";

test("any coded Convex rejection is definitive, including INTERNAL_ERROR and new codes", async () => {
  for (const code of ["INTERNAL_ERROR", "NEW_SERVER_REJECTION"]) {
    const error = new ConvexError({ code });
    let calls = 0;
    assert.equal(definitiveUploadRejection(error), true);
    await assert.rejects(reconcileUploadWrite(async () => { calls++; throw error; }), value => value === error);
    assert.equal(calls, 1);
  }
  let calls = 0;
  try {
    await reconcileUploadWrite(async () => { calls++; throw new Error("Transport failed"); });
    assert.fail("Expected unknown outcome");
  } catch (error) {
    assert.match(String(error), /UPLOAD_WRITE_UNKNOWN/);
    assert.equal(definitiveUploadRejection(error), false);
  }
  assert.equal(calls, 2);
});

test("local CLI errors, capitalized messages and unknown server codes never prove rollback", async () => {
  for (const error of [
    remoteError("Image upload outcome is unknown"), internalError("Unexpected local failure"),
    new Error("VERSION_CONFLICT"), { code: "VERSION_CONFLICT" },
    new ConvexError({ code: "UPLOAD_RECORDING_UNKNOWN" }), new ConvexError("UPLOAD_WRITE_UNKNOWN"),
    { data: { code: "UPLOAD_WRITE_UNKNOWN" } },
  ]) {
    assert.equal(definitiveUploadRejection(error), false);
    let calls = 0;
    await assert.rejects(reconcileUploadWrite(async () => { calls++; throw error; }), /UPLOAD_WRITE_UNKNOWN/);
    assert.equal(calls, 2);
  }
  assert.equal(definitiveUploadRejection({ data: { code: "VERSION_CONFLICT" } }), true);
  assert.equal(definitiveUploadRejection(new ConvexError("Rejected")), true);
});

test("callback recording preserves configuration codes and logs only one bounded code", async () => {
  const original = console.error;
  const logs: unknown[][] = [];
  console.error = (...args) => { logs.push(args); };
  const receipt = { intentId: "intent" as Id<"uploadIntents">, secret: "private-intent",
    file: { key: "private-key", url: "https://private.invalid", name: "private-name", type: "image/png", size: 1 } };
  try {
    for (const code of ["UPLOAD_CALLBACK_NOT_CONFIGURED", "TRUSTED_CALLBACK_REQUIRED"]) {
      let calls = 0;
      const callback = recordUploadHandler(async () => { calls++; throw new ConvexError({ code, private: "private-content" }); }, "callback");
      await assert.rejects(callback(receipt), new RegExp(code));
      assert.equal(calls, 1);
      assert.deepEqual(logs.pop(), [code]);
    }
    const missing = recordUploadHandler(async () => { assert.fail("Must not record"); }, undefined);
    await assert.rejects(missing(receipt), /UPLOAD_CALLBACK_NOT_CONFIGURED/);
    assert.deepEqual(logs.pop(), ["UPLOAD_CALLBACK_NOT_CONFIGURED"]);
    const unknown = recordUploadHandler(async () => { throw new Error("private transport details"); }, "callback");
    await assert.rejects(unknown(receipt), /UPLOAD_RECORDING_UNKNOWN/);
    assert.deepEqual(logs.pop(), ["UPLOAD_RECORDING_UNKNOWN"]);
    const queued = recordUploadHandler(async () => ({ state: "queued", jobIds: [] }), "callback");
    await assert.rejects(queued(receipt), /UPLOAD_INTENT_INVALID/);
    assert.deepEqual(logs.pop(), ["UPLOAD_INTENT_INVALID"]);
    assert.equal(logs.length, 0);
  } finally { console.error = original; }
});

test("upload middleware verifies the server callback credential before accepting files", async () => {
  const client = new ConvexHttpClient("https://fixture.convex.cloud");
  const original = console.error;
  const logs: unknown[][] = [];
  console.error = (...args) => { logs.push(args); };
  let checks = 0;
  const input = { intentId: "intent", secret: "s".repeat(48) };
  const req = new Request("https://fixture.invalid", { headers: { authorization: "Bearer customer" } });
  const files = [{ name: "fixture.png", size: 1, type: "image/png", lastModified: 1 }];
  // The browser's access token selects a per-request client; it is never an argument.
  const forUser = (accessToken: string) => { assert.equal(accessToken, "customer"); return client; };
  try {
    for (const code of ["UPLOAD_CALLBACK_NOT_CONFIGURED", "TRUSTED_CALLBACK_REQUIRED"]) {
      client.query = async (_reference, ...args) => {
        checks++;
        assert.deepEqual(args[0], { callbackToken: "server-secret", ...input, files: [{ name: "fixture.png", size: 1, type: "image/png" }] });
        throw new ConvexError({ code, private: "private-content" });
      };
      const route = createUploadRouter(client, "server-secret", forUser).ticketMedia;
      await assert.rejects(async () => route.middleware({ req, input, files }), new RegExp(code));
      assert.deepEqual(logs.pop(), [code]);
    }
    const route = createUploadRouter(client, undefined).ticketMedia;
    await assert.rejects(async () => route.middleware({ req, input, files }), /UPLOAD_CALLBACK_NOT_CONFIGURED/);
    assert.deepEqual(logs.pop(), ["UPLOAD_CALLBACK_NOT_CONFIGURED"]);
    assert.equal(checks, 2);
    client.query = async () => true as never;
    assert.deepEqual(await createUploadRouter(client, "server-secret", forUser).ticketMedia.middleware({ req, input, files }), input);
    client.query = async () => false as never;
    await assert.rejects(async () => createUploadRouter(client, "server-secret", forUser).ticketMedia.middleware({ req, input, files }),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "FORBIDDEN");
    assert.equal(logs.length, 0);
  } finally { console.error = original; }
});
