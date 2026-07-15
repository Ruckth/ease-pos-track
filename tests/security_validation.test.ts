import assert from "node:assert/strict";
import test from "node:test";
import { requireCurrentVersion, validateFeedbackText } from "../convex/feedback_state";
import { sameFiles, validateFiles } from "../convex/uploads";

test("feedback text is trimmed and bounded on the server", () => {
  assert.deepEqual(validateFeedbackText("  Printer issue  ", "  Receipt is blank  "), {
    title: "Printer issue",
    description: "Receipt is blank",
  });
  assert.throws(() => validateFeedbackText("x".repeat(101), "description"), /TITLE_TOO_LONG/);
  assert.throws(() => validateFeedbackText("title", "x".repeat(10_001)), /DESCRIPTION_TOO_LONG/);
});

test("optimistic versions reject stale mutations", () => {
  assert.equal(requireCurrentVersion({ version: 3 }, 3), 3);
  assert.equal(requireCurrentVersion({}, 0), 0);
  assert.throws(() => requireCurrentVersion({ version: 4 }, 3), /VERSION_CONFLICT/);
});

test("upload validation rejects unsupported and oversized media", () => {
  assert.doesNotThrow(() => validateFiles([
    { name: "photo.png", size: 1_024, type: "image/png" },
    { name: "clip.mp4", size: 2_048, type: "video/mp4" },
  ]));
  assert.throws(() => validateFiles([{ name: "notes.txt", size: 100, type: "text/plain" }]), /IMAGE_VIDEO_ONLY/);
  assert.throws(() => validateFiles([{ name: "large.png", size: 8 * 1024 * 1024 + 1, type: "image/png" }]), /IMAGE_TOO_LARGE/);
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
