import assert from "node:assert/strict";
import test from "node:test";
import { readUploadCancelResponse } from "../src/lib/upload-cancel";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("a JSON acknowledgement is accepted and reports how many files were deleted", async () => {
  assert.deepEqual(await readUploadCancelResponse(json({ ok: true, deleted: 2 })), { deleted: 2 });
  // A missing count is not an error; nothing had been uploaded yet.
  assert.deepEqual(await readUploadCancelResponse(json({ ok: true })), { deleted: 0 });
});

test("a 200 that is not JSON is a failure, not a silent success", async () => {
  // The exact shape a missing Vite dev proxy produces: index.html with a 200.
  const html = new Response("<!doctype html><html><body>app</body></html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });
  await assert.rejects(() => readUploadCancelResponse(html), /UPLOAD_CLEANUP_FAILED/);
});

test("a 200 with no content type or unparseable body is a failure", async () => {
  const bare = new Response("ok", { status: 200 });
  await assert.rejects(() => readUploadCancelResponse(bare), /UPLOAD_CLEANUP_FAILED/);

  const broken = new Response("{not json", { status: 200, headers: { "content-type": "application/json" } });
  await assert.rejects(() => readUploadCancelResponse(broken), /UPLOAD_CLEANUP_FAILED/);
});

test("JSON that does not acknowledge the cancel is a failure", async () => {
  await assert.rejects(() => readUploadCancelResponse(json({ ok: false })), /UPLOAD_CLEANUP_FAILED/);
  await assert.rejects(() => readUploadCancelResponse(json({ deleted: 1 })), /UPLOAD_CLEANUP_FAILED/);
  // A JSON array is not an acknowledgement either.
  await assert.rejects(() => readUploadCancelResponse(json([{ ok: true }])), /UPLOAD_CLEANUP_FAILED/);
});

test("an error response surfaces the server's stable code for localization", async () => {
  await assert.rejects(
    () => readUploadCancelResponse(json({ error: "UPLOAD_INTENT_NOT_FOUND" }, 400)),
    /UPLOAD_INTENT_NOT_FOUND/,
  );
  // A non-JSON error still resolves to the generic cleanup code.
  const gateway = new Response("Bad Gateway", { status: 502, headers: { "content-type": "text/plain" } });
  await assert.rejects(() => readUploadCancelResponse(gateway), /UPLOAD_CLEANUP_FAILED/);
});

test("a JSON content type with parameters is still treated as JSON", async () => {
  const withCharset = new Response(JSON.stringify({ ok: true, deleted: 1 }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
  assert.deepEqual(await readUploadCancelResponse(withCharset), { deleted: 1 });
});
