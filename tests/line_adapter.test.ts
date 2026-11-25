import assert from "node:assert/strict";
import test from "node:test";
import { createLine } from "../convex/adapters/line";

test("leaving an absent LINE chat succeeds without accepting other provider failures", async () => {
  const missing = createLine("test-token", async () => new Response(null, { status: 404 }));
  await missing.leave("group", "group-id");
  await missing.leave("room", "room-id");
  await assert.rejects(() => missing.count("group", "group-id"), /LINE_API_REQUEST_FAILED/);

  const unavailable = createLine("test-token", async () => new Response(null, { status: 503 }));
  await assert.rejects(() => unavailable.leave("group", "group-id"), /LINE_API_REQUEST_FAILED/);
});

test("push records provider acceptance, including a retry of an accepted request", async () => {
  const responses = [
    new Response(null, { status: 200 }),
    new Response(null, { status: 409, headers: { "x-line-accepted-request-id": "accepted" } }),
    new Response(null, { status: 409 }),
    new Response(null, { status: 503 }),
  ];
  const line = createLine("test-token", async (url, options) => {
    assert.equal(url, "https://api.line.me/v2/bot/message/push");
    assert.equal(options?.redirect, "error");
    assert.equal(new Headers(options?.headers).get("X-Line-Retry-Key"), "stable-key");
    assert.deepEqual(JSON.parse(String(options?.body)), {
      to: "group-id", messages: [{ type: "text", text: "Ticket is ready" }],
    });
    return responses.shift()!;
  });
  for (const expected of ["accepted", "accepted", "rejected", "unknown"]) {
    assert.equal(await line.push("group-id", "Ticket is ready", "stable-key"), expected);
  }
});

test("LINE content uses its dedicated host and rejects an oversized stream", async () => {
  const line = createLine("test-token", async (url, options) => {
    assert.equal(url, "https://api-data.line.me/v2/bot/message/file%2Fid/content");
    assert.equal(options?.redirect, "error");
    assert.equal(new Headers(options?.headers).get("Authorization"), "Bearer test-token");
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/png" } });
  });
  assert.deepEqual(await line.getContent("file/id"), { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" });
  const oversized = createLine("test-token", async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(8 * 1024 * 1024));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    },
  })));
  await assert.rejects(() => oversized.getContent("oversized"), /LINE_CONTENT_TOO_LARGE/);
  const expired = createLine("test-token", async () => new Response(null, { status: 410 }));
  await assert.rejects(() => expired.getContent("expired"), /LINE_CONTENT_EXPIRED/);
});
