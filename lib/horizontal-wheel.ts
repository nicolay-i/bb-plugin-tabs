/** A minimal scroll target that keeps the logic testable without the DOM. */
export interface HorizontalScrollable {
  clientWidth: number;
  scrollLeft: number;
  scrollWidth: number;
}

export interface WheelScrollInput {
  ctrlKey: boolean;
  deltaMode: number;
  deltaX: number;
  deltaY: number;
  metaKey: boolean;
}

const WHEEL_DELTA_MODE_LINE = 1;
const WHEEL_DELTA_MODE_PAGE = 2;
const WHEEL_LINE_HEIGHT_PX = 16;

function pixelDelta(
  delta: number,
  deltaMode: number,
  pageSize: number,
): number {
  if (deltaMode === WHEEL_DELTA_MODE_LINE) {
    return delta * WHEEL_LINE_HEIGHT_PX;
  }
  if (deltaMode === WHEEL_DELTA_MODE_PAGE) return delta * pageSize;
  return delta;
}

/**
 * Applies a horizontal wheel gesture to the strip. Ctrl/⌘ gestures are left to
 * zoom and operating-system shortcuts.
 */
export function consumeHorizontalWheel(
  target: HorizontalScrollable,
  input: WheelScrollInput,
): boolean {
  if (input.ctrlKey || input.metaKey) return false;
  // Trackpads can retain a small deltaX from the preceding horizontal gesture.
  // Follow the dominant axis so the first scroll after a direction change does
  // not unexpectedly move in the old direction.
  const rawDelta =
    Math.abs(input.deltaX) > Math.abs(input.deltaY)
      ? input.deltaX
      : input.deltaY;
  if (!Number.isFinite(rawDelta) || rawDelta === 0) return false;

  const maximum = Math.max(0, target.scrollWidth - target.clientWidth);
  if (maximum === 0) return false;

  const delta = pixelDelta(rawDelta, input.deltaMode, target.clientWidth);
  const next = Math.min(maximum, Math.max(0, target.scrollLeft + delta));
  if (next === target.scrollLeft) return false;
  target.scrollLeft = next;
  return true;
}
