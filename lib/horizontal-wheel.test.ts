import { describe, expect, it } from "vitest";
import { consumeHorizontalWheel } from "./horizontal-wheel";

describe("Chat Tabs", () => {
  it("handles behavior 1", () => {
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

  it("handles behavior 2", () => {
    const strip = { clientWidth: 100, scrollLeft: 150, scrollWidth: 400 };

    expect(
      consumeHorizontalWheel(strip, {
        ctrlKey: false,
        deltaMode: 0,
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

  it("handles behavior 3", () => {
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
