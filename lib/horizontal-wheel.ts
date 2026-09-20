/** Минимальный scroll target, чтобы логику можно было проверить без DOM. */
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
 * Применяет горизонтальный жест к полосе. Ctrl/⌘ намеренно не перехватываются:
 * они принадлежат zoom и системным shortcut'ам.
 */
export function consumeHorizontalWheel(
  target: HorizontalScrollable,
  input: WheelScrollInput,
): boolean {
  if (input.ctrlKey || input.metaKey) return false;
  // Тачпады нередко присылают небольшой остаточный deltaX после прошлого
  // горизонтального жеста. Обычное колесо должно следовать доминирующей
  // дельте, иначе первая прокрутка после смены направления идёт не туда.
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
