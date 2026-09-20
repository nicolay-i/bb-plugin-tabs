import { describe, expect, it } from "vitest";
import { threadLinkUrl } from "./thread-link";

describe("threadLinkUrl", () => {
  it("сохраняет фактический route текущего чата", () => {
    expect(
      threadLinkUrl(
        { projectId: "proj_personal", threadId: "thr_current" },
        "thr_current",
        {
          href: "https://bb.test/threads/thr_current?panel=files#message",
          origin: "https://bb.test",
        },
      ),
    ).toBe("https://bb.test/threads/thr_current");
  });

  it("кодирует project и thread id для неактивной вкладки", () => {
    expect(
      threadLinkUrl(
        { projectId: "proj / api", threadId: "thr / next" },
        "thr_current",
        { href: "https://bb.test/", origin: "https://bb.test" },
      ),
    ).toBe(
      "https://bb.test/projects/proj%20%2F%20api/threads/thr%20%2F%20next",
    );
  });
});
