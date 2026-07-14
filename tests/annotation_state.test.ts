import assert from "node:assert/strict";
import test from "node:test";
import {
  activeAnnotations,
  createAnnotationRecord,
  deletedAnnotations,
  restoreAnnotationRecord,
  softDeleteAnnotationRecord,
  updateAnnotationRecord,
  type AnnotationRecord,
} from "../convex/annotation_state";

const imageComment: AnnotationRecord = {
  id: "annotation-1",
  label: 1,
  mediaIndex: 0,
  kind: "point",
  x: 0.25,
  y: 0.5,
  text: "Original comment",
  createdAt: 100,
};

test("updates comment text and clamps a moved image position", () => {
  const updated = updateAnnotationRecord(imageComment, {
    text: "  Updated comment  ",
    x: 1.5,
    y: -0.5,
  }, 200);

  assert.equal(updated.text, "Updated comment");
  assert.equal(updated.x, 1);
  assert.equal(updated.y, 0);
  assert.equal(updated.updatedAt, 200);
  assert.equal(imageComment.text, "Original comment");
});

test("soft deletion is reversible without losing comment data", () => {
  const deleted = softDeleteAnnotationRecord(imageComment, 300);
  const restored = restoreAnnotationRecord(deleted, 400);

  assert.equal(deleted.deletedAt, 300);
  assert.equal(restored.deletedAt, undefined);
  assert.equal(restored.text, imageComment.text);
  assert.equal(restored.x, imageComment.x);
  assert.equal(restored.y, imageComment.y);
  assert.equal(restored.updatedAt, 400);
});

test("active and deleted selectors never show the same comment", () => {
  const deleted = softDeleteAnnotationRecord({ ...imageComment, id: "annotation-2" }, 300);
  const annotations = [imageComment, deleted];

  assert.deepEqual(activeAnnotations(annotations).map((annotation) => annotation.id), ["annotation-1"]);
  assert.deepEqual(deletedAnnotations(annotations).map((annotation) => annotation.id), ["annotation-2"]);
});

test("deleted comments cannot be edited until restored", () => {
  const deleted = softDeleteAnnotationRecord(imageComment, 300);

  assert.throws(
    () => updateAnnotationRecord(deleted, { text: "Should fail" }, 400),
    /must be restored before editing/,
  );
});

test("video comments can move to a new frame and timestamp", () => {
  const videoComment: AnnotationRecord = {
    ...imageComment,
    id: "video-annotation",
    kind: "time",
    time: 12,
  };

  const updated = updateAnnotationRecord(videoComment, { x: 0.75, y: 0.2, time: 18.5 }, 500);

  assert.equal(updated.x, 0.75);
  assert.equal(updated.y, 0.2);
  assert.equal(updated.time, 18.5);
});

test("legacy pin comments keep image-point behavior", () => {
  const legacyPin: AnnotationRecord = { ...imageComment, kind: "pin" };
  assert.throws(
    () => updateAnnotationRecord(legacyPin, { time: 12 }, 500),
    /Image comments cannot have a video timestamp/,
  );
});

test("creates and validates image and video annotations consistently", () => {
  const media = [{ type: "image/png" }, { type: "video/mp4" }];
  const point = createAnnotationRecord(media, {
    mediaIndex: 0,
    kind: "point",
    x: 1.2,
    y: -0.1,
    text: "  Screen is clipped  ",
  }, 1, "point-1", 600);
  const time = createAnnotationRecord(media, {
    mediaIndex: 1,
    kind: "time",
    x: 0.4,
    y: 0.6,
    time: 12.5,
    text: "Button flickers",
  }, 2, "time-1", 600);

  assert.equal(point.text, "Screen is clipped");
  assert.equal(point.x, 1);
  assert.equal(point.y, 0);
  assert.equal(time.time, 12.5);
  assert.throws(() => createAnnotationRecord(media, {
    mediaIndex: 0,
    kind: "time",
    x: 0.5,
    y: 0.5,
    time: 2,
    text: "Invalid",
  }, 3, "bad", 600), /only valid on videos/);
});
