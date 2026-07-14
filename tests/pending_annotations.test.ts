import assert from "node:assert/strict";
import test from "node:test";
import {
  pendingAnnotationsForCreate,
  pendingAnnotationsForViewer,
  withoutPendingAnnotationsForMedia,
  type PendingAnnotation,
} from "../src/lib/pending-annotations";

const annotations: PendingAnnotation[] = [
  { id: "a1", mediaId: "first", kind: "point", x: 0.2, y: 0.4, text: "First", createdAt: 1 },
  { id: "a2", mediaId: "second", kind: "time", x: 0.5, y: 0.6, time: 8, text: "Second", createdAt: 2 },
];

test("draft annotations follow stable media IDs through reorder", () => {
  const reordered = [{ id: "second" }, { id: "first" }];
  const viewer = pendingAnnotationsForViewer(reordered, annotations);
  const create = pendingAnnotationsForCreate(reordered, annotations);

  assert.deepEqual(viewer.map((annotation) => annotation.mediaIndex), [1, 0]);
  assert.deepEqual(viewer.map((annotation) => annotation.label), [1, 2]);
  assert.deepEqual(create.map((annotation) => annotation.mediaIndex), [1, 0]);
});

test("removing media removes only its draft annotations", () => {
  assert.deepEqual(
    withoutPendingAnnotationsForMedia(annotations, "first").map((annotation) => annotation.id),
    ["a2"],
  );
});
