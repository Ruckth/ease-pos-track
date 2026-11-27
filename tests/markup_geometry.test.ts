import assert from "node:assert/strict";
import test from "node:test";
import { isResizeWheel, nextSizeStep, scaleLimits, scaleRect, SIZE_STEP, stepLimits, WHEEL_MAX_STEPS, WHEEL_STEP_PX, wheelSteps } from "../src/lib/markup-geometry";

const circle = { id: 7, kind: "circle" as const, stroke: 4, x: 400, y: 300, width: 200, height: 100 };
const wheel = { deltaX: 0, deltaY: -100, deltaMode: 0, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };

test("circle scaling keeps the centre, proportions, id and stroke", () => {
  const grown = scaleRect(circle, 1.5, 6000, 6000, 8);
  assert.deepEqual(grown, { ...circle, x: 350, y: 275, width: 300, height: 150 });
  const shrunk = scaleRect(circle, 0.5, 6000, 6000, 8);
  assert.equal(shrunk.x + shrunk.width / 2, 500);
  assert.equal(shrunk.y + shrunk.height / 2, 350);
  assert.equal(shrunk.width / shrunk.height, 2);
});

test("circle scaling stops at the nearest image edge and the minimum size", () => {
  // Centre (500, 350): the left edge is 500 px away, so width can reach 1000 (factor 5).
  assert.deepEqual(scaleLimits(circle, 6000, 6000, 8), { min: 0.08, max: 5 });
  assert.deepEqual(scaleRect(circle, 100, 6000, 6000, 8), { ...circle, x: 0, y: 100, width: 1000, height: 500 });
  const tiny = scaleRect(circle, 0.001, 6000, 6000, 8);
  assert.deepEqual([tiny.width, tiny.height], [16, 8]);
  const limits = stepLimits(circle, 6000, 6000, 8);
  assert.ok(Math.abs(SIZE_STEP ** limits.max - 5) < 1e-9);
});

test("a circle already at an edge or the minimum keeps a valid range around 1", () => {
  const edge = { ...circle, x: 0, y: 0 };
  assert.deepEqual(scaleLimits(edge, 6000, 6000, 8).max, 1);
  assert.deepEqual(scaleRect(edge, 2, 6000, 6000, 8), edge);
  const small = { ...circle, width: 4, height: 4 };
  assert.equal(scaleLimits(small, 6000, 6000, 8).min, 1);
});

test("only plain vertical wheel input resizes", () => {
  assert.equal(isResizeWheel(wheel), true);
  assert.equal(isResizeWheel({ ...wheel, ctrlKey: true }), false, "pinch zoom");
  assert.equal(isResizeWheel({ ...wheel, shiftKey: true }), false);
  assert.equal(isResizeWheel({ ...wheel, metaKey: true }), false);
  assert.equal(isResizeWheel({ ...wheel, altKey: true }), false);
  assert.equal(isResizeWheel({ ...wheel, deltaX: 80 }), false, "diagonal");
  assert.equal(isResizeWheel({ ...wheel, deltaY: 0, deltaX: 40 }), false, "sideways");
});

test("wheel deltas accumulate into capped steps; up grows", () => {
  let rest = 0, total = 0;
  for (let i = 0; i < 4; i++) {
    const r = wheelSteps(rest, { deltaY: -16, deltaMode: 0 });
    rest = r.rest; total += r.steps;
  }
  assert.equal(total, 1, "64 px of trackpad travel is one step");
  assert.deepEqual(wheelSteps(0, { deltaY: WHEEL_STEP_PX, deltaMode: 0 }), { steps: -1, rest: 0 });
  assert.deepEqual(wheelSteps(0, { deltaY: -3, deltaMode: 1 }), { steps: 1, rest: 0 }, "one Firefox line notch");
  assert.deepEqual(wheelSteps(0, { deltaY: -1, deltaMode: 2 }, 600), { steps: WHEEL_MAX_STEPS, rest: 0 }, "a page is capped");
  assert.deepEqual(wheelSteps(0, { deltaY: 10, deltaMode: 0 }), { steps: 0, rest: -10 });
});

test("separate scroll gestures do not walk the centre across the image", () => {
  let mark = circle;
  for (let i = 0; i < 20; i++) {
    mark = scaleRect(mark, SIZE_STEP ** 2, 6000, 6000, 4);
    mark = scaleRect(mark, SIZE_STEP ** -2, 6000, 6000, 4);
  }
  assert.equal(mark.x + mark.width / 2, circle.x + circle.width / 2);
  assert.equal(mark.y + mark.height / 2, circle.y + circle.height / 2);
});

test("a single size step can grow and shrink a tiny circle", () => {
  const tiny = { ...circle, width: 2, height: 2 };
  const up = nextSizeStep(tiny, 0, 1);
  assert.equal(scaleRect(tiny, SIZE_STEP ** up, 640, 480, 1).width, 3);
  const back = nextSizeStep(tiny, up, -1);
  assert.equal(scaleRect(tiny, SIZE_STEP ** back, 640, 480, 1).width, 2);
});
