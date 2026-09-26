import { describe, expect, it } from "vitest";
import { cycleTab } from "./tab-cycle";

const tabs = [
  { threadId: "thr_first" },
  { threadId: "thr_second" },
  { threadId: "thr_third" },
] as const;

describe("Chat Tabs", () => {
  it("handles behavior 1", () => {
    expect(cycleTab(tabs, "thr_second", "next")?.threadId).toBe("thr_third");
    expect(cycleTab(tabs, "thr_second", "previous")?.threadId).toBe(
      "thr_first",
    );
  });

  it("handles behavior 2", () => {
    expect(cycleTab(tabs, "thr_third", "next")?.threadId).toBe("thr_first");
    expect(cycleTab(tabs, "thr_first", "previous")?.threadId).toBe(
      "thr_third",
    );
  });

  it("handles behavior 3", () => {
    expect(cycleTab(tabs, null, "next")).toBeNull();
    expect(cycleTab(tabs, "thr_missing", "next")).toBeNull();
    expect(cycleTab([{ threadId: "thr_only" }], "thr_only", "next")).toBeNull();
  });
});
