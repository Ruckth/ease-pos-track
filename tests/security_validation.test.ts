import assert from "node:assert/strict";
import test from "node:test";
import { requireCurrentVersion, validateFeedbackText } from "../convex/feedback_state";
import { sameFiles, validateFiles } from "../convex/uploads";

test("feedback text is trimmed and bounded on the server", () => {
  assert.deepEqual(validateFeedbackText("  Printer issue  ", "  Receipt is blank  "), {
    title: "Printer issue",
    description: "Receipt is blank",
  });
  assert.throws(() => validateFeedbackText("x".repeat(101), "description"), /100 characters/);
  assert.throws(() => validateFeedbackText("title", "x".repeat(10_001)), /10,000 characters/);
});

test("optimistic versions reject stale mutations", () => {
  assert.equal(requireCurrentVersion({ version: 3 }, 3), 3);
  assert.equal(requireCurrentVersion({}, 0), 0);
  assert.throws(() => requireCurrentVersion({ version: 4 }, 3), /changed in another session/);
});

test("upload validation rejects unsupported and oversized media", () => {
  assert.doesNotThrow(() => validateFiles([
    { name: "photo.png", size: 1_024, type: "image/png" },
    { name: "clip.mp4", size: 2_048, type: "video/mp4" },
  ]));
  assert.throws(() => validateFiles([{ name: "notes.txt", size: 100, type: "text/plain" }]), /Only images and videos/);
  assert.throws(() => validateFiles([{ name: "large.png", size: 8 * 1024 * 1024 + 1, type: "image/png" }]), /no more than 8MB/);
});

test("upload intent comparison detects metadata tampering", () => {
  const expected = [
    { name: "a.png", size: 100, type: "image/png" },
    { name: "b.mp4", size: 200, type: "video/mp4" },
  ];
  assert.equal(sameFiles(expected, [...expected].reverse()), true);
  assert.equal(sameFiles(expected, [{ ...expected[0], size: 101 }, expected[1]]), false);
  assert.equal(sameFiles(expected, [expected[0]]), false);
});
