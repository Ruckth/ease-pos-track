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
