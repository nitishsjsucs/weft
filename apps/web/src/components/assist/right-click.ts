// The double right-click that wakes the cursor assistant (research/cursor-assistant.md 7.1): two right-clicks within
// DOUBLE_RIGHT_MS and DOUBLE_RIGHT_SLOP px of each other. The first one shows the small Weft menu at once; the
// second closes it and starts listening. A third quick press starts over. Pure, so vitest drives it with times.
export const DOUBLE_RIGHT_MS = 400;
export const DOUBLE_RIGHT_SLOP = 24;

export interface Press { t: number; x: number; y: number }

/** Whether `now` completes a double right-click begun by `prev`. */
export function isDoubleRightClick(prev: Press | null, now: Press, windowMs = DOUBLE_RIGHT_MS, slop = DOUBLE_RIGHT_SLOP): boolean {
  if (!prev) return false;
  const dt = now.t - prev.t;
  return dt >= 0 && dt <= windowMs && Math.hypot(now.x - prev.x, now.y - prev.y) <= slop;
}

/** A detector over a stream of right-clicks: "first" opens the menu, "double" wakes the assistant. */
export function createRightClickDetector(windowMs = DOUBLE_RIGHT_MS, slop = DOUBLE_RIGHT_SLOP): { press(p: Press): "first" | "double"; reset(): void } {
  let last: Press | null = null;
  return {
    press(p) {
      if (isDoubleRightClick(last, p, windowMs, slop)) { last = null; return "double"; }
      last = p;
      return "first";
    },
    reset() { last = null; },
  };
}
