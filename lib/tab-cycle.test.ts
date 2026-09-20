import { describe, expect, it } from "vitest";
import { cycleTab } from "./tab-cycle";

const tabs = [
  { threadId: "thr_first" },
  { threadId: "thr_second" },
  { threadId: "thr_third" },
] as const;

describe("циклическое переключение вкладок", () => {
  it("переходит вперёд и назад по представленному горизонтальному порядку", () => {
    expect(cycleTab(tabs, "thr_second", "next")?.threadId).toBe("thr_third");
    expect(cycleTab(tabs, "thr_second", "previous")?.threadId).toBe(
      "thr_first",
    );
  });

  it("зацикливается на границах", () => {
    expect(cycleTab(tabs, "thr_third", "next")?.threadId).toBe("thr_first");
    expect(cycleTab(tabs, "thr_first", "previous")?.threadId).toBe(
      "thr_third",
    );
  });

  it("не перехватывает shortcut без текущей или с единственной вкладкой", () => {
    expect(cycleTab(tabs, null, "next")).toBeNull();
    expect(cycleTab(tabs, "thr_missing", "next")).toBeNull();
    expect(cycleTab([{ threadId: "thr_only" }], "thr_only", "next")).toBeNull();
  });
});
