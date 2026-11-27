import type { MarkupRect } from "./image-markup";

/** One proportional size step (wheel notch, slider arrow); Smaller/Larger take two. */
export const SIZE_STEP = 1.07;
/** CSS px of wheel travel per size step, the per-event step cap, and the quiet time that ends a burst. */
export const WHEEL_STEP_PX = 48;
export const WHEEL_MAX_STEPS = 2;
export const WHEEL_QUIET_MS = 240;
const LINE_PX = 16;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Proportional scale range that keeps `rect` centred inside a W×H image and at least `min` px
 * on each side. Always includes 1, so the current size stays valid.
 */
export function scaleLimits(rect: MarkupRect, W: number, H: number, min: number) {
  const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
  const max = Math.min((2 * cx) / rect.width, (2 * (W - cx)) / rect.width, (2 * cy) / rect.height, (2 * (H - cy)) / rect.height);
  return { min: Math.min(1, Math.max(min / rect.width, min / rect.height)), max: Math.max(1, max) };
}

/** Scales around the centre in whole pixels; id, stroke and other fields are kept. */
export function scaleRect<T extends MarkupRect>(rect: T, factor: number, W: number, H: number, min: number): T {
  const limits = scaleLimits(rect, W, H, min);
  const f = clamp(factor, limits.min, limits.max);
  const width = clamp(Math.round(rect.width * f), Math.min(min, rect.width), W);
  const height = clamp(Math.round(rect.height * f), Math.min(min, rect.height), H);
  const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
  // Anchor both odd and even sizes to the same source pixel across separate gestures.
  return { ...rect, width, height, x: clamp(Math.floor(cx) - Math.floor(width / 2), 0, W - width), y: clamp(Math.floor(cy) - Math.floor(height / 2), 0, H - height) };
}

/** A discrete step must move even a one-pixel mark when room remains. */
export function nextSizeStep(rect: MarkupRect, exponent: number, steps: number) {
  const longest = Math.max(rect.width, rect.height);
  const current = longest * SIZE_STEP ** exponent;
  const target = current * SIZE_STEP ** steps;
  if (Math.abs(target - current) >= 1) return exponent + steps;
  return Math.log(Math.max(1, current + Math.sign(steps)) / longest) / Math.log(SIZE_STEP);
}

/** Step exponent range for `scaleLimits`, so reversing direction at a limit responds at once. */
export function stepLimits(rect: MarkupRect, W: number, H: number, min: number) {
  const { min: lo, max: hi } = scaleLimits(rect, W, H, min);
  return { min: Math.log(lo) / Math.log(SIZE_STEP), max: Math.log(hi) / Math.log(SIZE_STEP) };
}

type Wheel = Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">;

/** Plain vertical scrolling only: pinch (ctrl), modified, sideways and diagonal input keep their default. */
export function isResizeWheel(event: Wheel) {
  return !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
    && event.deltaY !== 0 && Math.abs(event.deltaY) >= 2 * Math.abs(event.deltaX);
}

/**
 * Accumulates wheel travel into whole steps (positive grows: wheel up). Pixel, line and page
 * deltas are normalized; a burst of large deltas is capped and drops its remainder.
 */
export function wheelSteps(rest: number, event: Pick<WheelEvent, "deltaY" | "deltaMode">, pagePx = 600) {
  const unit = event.deltaMode === 1 ? LINE_PX : event.deltaMode === 2 ? pagePx : 1;
  const total = rest - event.deltaY * unit;
  const steps = Math.trunc(total / WHEEL_STEP_PX) || 0;
  const capped = clamp(steps, -WHEEL_MAX_STEPS, WHEEL_MAX_STEPS);
  return { steps: capped, rest: capped === steps ? total - steps * WHEEL_STEP_PX : 0 };
}
