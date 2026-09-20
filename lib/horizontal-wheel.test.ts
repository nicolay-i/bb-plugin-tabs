import { describe, expect, it } from "vitest";
import { consumeHorizontalWheel } from "./horizontal-wheel";

describe("прокрутка полосы вкладок колесом", () => {
  it("превращает обычное вертикальное колесо в горизонтальную прокрутку", () => {
    const strip = { clientWidth: 100, scrollLeft: 20, scrollWidth: 400 };

    expect(
      consumeHorizontalWheel(strip, {
        ctrlKey: false,
        deltaMode: 0,
        deltaX: 0,
        deltaY: 48,
        metaKey: false,
      }),
    ).toBe(true);
    expect(strip.scrollLeft).toBe(68);
  });

  it("игнорирует остаточный deltaX при смене направления обычного колеса", () => {
    const strip = { clientWidth: 100, scrollLeft: 150, scrollWidth: 400 };

    expect(
      consumeHorizontalWheel(strip, {
        ctrlKey: false,
        deltaMode: 0,
        // Остаток предыдущего горизонтального жеста не должен перебить новый
        // более сильный вертикальный wheel в противоположную сторону.
        deltaX: 8,
        deltaY: -48,
        metaKey: false,
      }),
    ).toBe(true);
    expect(strip.scrollLeft).toBe(102);

    expect(
      consumeHorizontalWheel(strip, {
        ctrlKey: false,
        deltaMode: 0,
        deltaX: -8,
        deltaY: 48,
        metaKey: false,
      }),
    ).toBe(true);
    expect(strip.scrollLeft).toBe(150);
  });

  it("сохраняет Ctrl/⌘+wheel для браузера и системных shortcut'ов", () => {
    const strip = { clientWidth: 100, scrollLeft: 20, scrollWidth: 400 };

    expect(
      consumeHorizontalWheel(strip, {
        ctrlKey: true,
        deltaMode: 0,
        deltaX: 0,
        deltaY: 48,
        metaKey: false,
      }),
    ).toBe(false);
    expect(strip.scrollLeft).toBe(20);

    expect(
      consumeHorizontalWheel(strip, {
        ctrlKey: false,
        deltaMode: 0,
        deltaX: 48,
        deltaY: 0,
        metaKey: true,
      }),
    ).toBe(false);
    expect(strip.scrollLeft).toBe(20);
  });

});
