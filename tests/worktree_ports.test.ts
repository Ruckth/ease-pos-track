import assert from "node:assert/strict";
import test from "node:test";
import { FETCH_BLOCKED_PORTS, portsForSlot, slotUsable } from "../scripts/worktree-ports.mjs";

test("worktree slots never include a port that fetch refuses", () => {
  assert.equal(slotUsable(19), false, "slot 19 owns 4190 (ManageSieve)");
  for (let slot = 1; slot < 100; slot++) {
    if (!slotUsable(slot)) continue;
    for (const port of Object.values(portsForSlot(slot))) assert.ok(!FETCH_BLOCKED_PORTS.has(port));
  }
});
