import assert from "node:assert/strict";
import test from "node:test";
import { requireCurrentVersion, validateFeedbackText } from "../convex/feedback_state";
import { sameFiles, validateFiles, validateMediaItems } from "../convex/uploads";

test("feedback text is trimmed and bounded on the server", () => {
  assert.deepEqual(validateFeedbackText("  Printer issue  ", "  Receipt is blank  "), {
    title: "Printer issue",
    description: "Receipt is blank",
  });
  assert.deepEqual(validateFeedbackText("  Printer issue  ", "   "), {
    title: "Printer issue",
    description: "",
  });
  assert.throws(() => validateFeedbackText("   ", "optional description"), /REQUIRED_FEEDBACK/);
  assert.throws(() => validateFeedbackText("x".repeat(101), "description"), /TITLE_TOO_LONG/);
  assert.throws(() => validateFeedbackText("title", "x".repeat(10_001)), /DESCRIPTION_TOO_LONG/);
});

test("optimistic versions reject stale mutations", () => {
  assert.equal(requireCurrentVersion({ version: 3 }, 3), 3);
  assert.equal(requireCurrentVersion({}, 0), 0);
  assert.throws(() => requireCurrentVersion({ version: 4 }, 3), /VERSION_CONFLICT/);
});

test("upload validation rejects unsupported and oversized media", () => {
  assert.doesNotThrow(() => validateFiles([]));
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

test("stored media references require verified HTTPS uploads and obey combined limits", () => {
  const image = {
    key: "upload-key",
    name: "evidence.png",
    size: 1_024,
    type: "image/png",
    url: "https://cdn.example.com/evidence.png",
  };

  assert.doesNotThrow(() => validateMediaItems([image]));
  assert.throws(() => validateMediaItems([{ ...image, key: "" }]), /INVALID_MEDIA_REFERENCE/);
  assert.throws(() => validateMediaItems([{ ...image, url: "http://cdn.example.com/evidence.png" }]), /INVALID_MEDIA_REFERENCE/);
  assert.throws(
    () => validateMediaItems(Array.from({ length: 11 }, (_, index) => ({ ...image, key: `key-${index}` }))),
    /MEDIA_LIMIT_EXCEEDED/,
  );
});
