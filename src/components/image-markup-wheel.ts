import { isResizeWheel, WHEEL_QUIET_MS, wheelSteps } from "@/lib/markup-geometry";
import { useEffect, useRef, type RefObject } from "react";

export type WheelResize = {
  /** Asked once at the start of a burst: whether this burst resizes or scrolls. */
  owns: (event: WheelEvent) => boolean;
  /** Checked on every event of an owned burst; false hands the rest back to scrolling. */
  active: () => boolean;
  step: (steps: number) => void;
  /** The burst went quiet after at least one step. */
  end: () => void;
};

/**
 * A non-passive wheel listener on `target`. Each burst (events less than WHEEL_QUIET_MS apart)
 * has one owner, so a scroll that starts elsewhere keeps scrolling across the circle.
 * Returns a ref that is true while an owned burst is resizing.
 */
export function useWheelResize(target: RefObject<Element | null>, handlers: WheelResize) {
  const latest = useRef(handlers);
  latest.current = handlers;
  const resizing = useRef(false);

  useEffect(() => {
    const el = target.current;
    if (!el) return;
    let burst: { owned: boolean; rest: number; stepped: boolean } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      const b = burst;
      burst = null;
      resizing.current = false;
      if (b?.owned && b.stepped) latest.current.end();
    };
    const onWheel = (event: Event) => {
      const e = event as WheelEvent;
      clearTimeout(timer);
      timer = setTimeout(finish, WHEEL_QUIET_MS);
      const eligible = e.cancelable && isResizeWheel(e);
      burst ??= { owned: eligible && latest.current.owns(e), rest: 0, stepped: false };
      // Pinch, modified and noncancelable input keeps the platform default, even mid-burst.
      if (!burst.owned) return;
      if (!eligible || !latest.current.active()) {
        burst.owned = false;
        resizing.current = false;
        if (burst.stepped) latest.current.end();
        return;
      }
      e.preventDefault();
      resizing.current = true;
      const { steps, rest } = wheelSteps(burst.rest, e, window.innerHeight);
      burst.rest = rest;
      if (steps) { burst.stepped = true; latest.current.step(steps); }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      // Unmount or a new target discards the pending end; the edits are already in history.
      el.removeEventListener("wheel", onWheel);
      clearTimeout(timer);
      resizing.current = false;
    };
  }, [target]);

  return resizing;
}
