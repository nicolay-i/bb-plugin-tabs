import { describe, expect, it } from "vitest";
import {
  addTabCandidates,
  closeTab,
  closeTabs,
  movePinnedTab,
  normalizeTabsState,
  openTabCandidate,
  setTabPinned,
} from "./tabs-model";

describe("Chat Tabs", () => {
  it("handles behavior 1", () => {
    const state = normalizeTabsState({
      version: 1,
      entries: [
        {
          threadId: "thr_1",
          projectId: "proj_1",
          title: "First label",
          pinned: true,
          openedAt: 10,
        },
        {
          threadId: "thr_1",
          projectId: "proj_1",
          title: "New label",
          pinned: false,
          openedAt: 20,
        },
        { threadId: "", projectId: "proj_bad", title: "bad", pinned: false },
      ],
    });

    expect(state.entries).toEqual([
      {
        threadId: "thr_1",
        projectId: "proj_1",
        title: "New label",
        pinned: true,
        openedAt: 10,
      },
    ]);
  });

  it("handles behavior 2", () => {
    const state = normalizeTabsState({
      version: 1,
      entries: [
        {
          threadId: "thr_old",
          projectId: "proj_a",
          title: "Old",
          pinned: false,
          openedAt: 10,
        },
        {
          threadId: "thr_fixed",
          projectId: "proj_a",
          title: "Pinned",
          pinned: true,
          openedAt: 11,
        },
        {
          threadId: "thr_new",
          projectId: "proj_b",
          title: "New",
          pinned: false,
          openedAt: 20,
        },
      ],
    });

    expect(state.entries.map((entry) => entry.threadId)).toEqual([
      "thr_fixed",
      "thr_new",
    ]);
  });

  it("handles behavior 3", () => {
    const preview = addTabCandidates(
      { version: 1, entries: [] },
      [
        { threadId: "thr_a", projectId: "proj_a", title: "Build" },
        { threadId: "thr_b", projectId: "proj_a", title: "Check" },
      ],
      100,
    );
    expect(preview.entries).toEqual([
      {
        threadId: "thr_b",
        projectId: "proj_a",
        title: "Check",
        pinned: false,
        openedAt: 100,
      },
    ]);

    const pinned = setTabPinned(preview, "thr_b", true);
    const nextPreview = addTabCandidates(
      pinned,
      [{ threadId: "thr_a", projectId: "proj_a", title: "API build" }],
      200,
    );
    const refreshedPinned = addTabCandidates(
      nextPreview,
      [{ threadId: "thr_b", projectId: "proj_a", title: "Release check" }],
      300,
    );

    expect(refreshedPinned.entries).toEqual([
      {
        threadId: "thr_b",
        projectId: "proj_a",
        title: "Release check",
        pinned: true,
        openedAt: 100,
      },
      {
        threadId: "thr_a",
        projectId: "proj_a",
        title: "API build",
        pinned: false,
        openedAt: 200,
      },
    ]);
  });

  it("handles behavior 4", () => {
    const preview = addTabCandidates(
      { version: 1, entries: [] },
      [{ threadId: "thr_a", projectId: "proj_a", title: "Build" }],
      100,
    );
    const fixed = openTabCandidate(
      preview,
      { threadId: "thr_a", projectId: "proj_a", title: "Build" },
      101,
    );
    const next = addTabCandidates(
      fixed,
      [{ threadId: "thr_b", projectId: "proj_b", title: "Review" }],
      102,
    );

    expect(next.entries).toEqual([
      expect.objectContaining({ threadId: "thr_a", pinned: true }),
      expect.objectContaining({ threadId: "thr_b", pinned: false }),
    ]);
  });

  it("handles behavior 5", () => {
    const state = normalizeTabsState({
      version: 1,
      entries: Array.from({ length: 101 }, (_, index) => ({
        threadId: `thr_${index}`,
        projectId: "proj_a",
        title: `Chat ${index}`,
        pinned: true,
        openedAt: index,
      })),
    });

    expect(state.entries).toHaveLength(100);
    expect(state.entries.some((entry) => entry.threadId === "thr_0")).toBe(false);
  });

  it("handles behavior 6", () => {
    const state = {
      version: 1 as const,
      entries: [
        {
          threadId: "thr_a",
          projectId: "proj_a",
          title: "A",
          pinned: true,
          openedAt: 1,
        },
        {
          threadId: "thr_other",
          projectId: "proj_b",
          title: "Other project",
          pinned: true,
          openedAt: 2,
        },
        {
          threadId: "thr_b",
          projectId: "proj_a",
          title: "B",
          pinned: true,
          openedAt: 3,
        },
        {
          threadId: "thr_preview",
          projectId: "proj_a",
          title: "Preview",
          pinned: false,
          openedAt: 4,
        },
        {
          threadId: "thr_c",
          projectId: "proj_a",
          title: "C",
          pinned: true,
          openedAt: 5,
        },
      ],
    };

    const moved = movePinnedTab(state, "thr_c", "thr_a", "before");
    expect(moved.entries.map((entry) => entry.threadId)).toEqual([
      "thr_c",
      "thr_a",
      "thr_other",
      "thr_preview",
      "thr_b",
    ]);
    expect(
      movePinnedTab(state, "thr_a", "thr_preview", "before"),
    ).toEqual(state);
    expect(
      movePinnedTab(state, "thr_a", "thr_other", "after").entries.map(
        (entry) => entry.threadId,
      ),
    ).toEqual(["thr_other", "thr_a", "thr_b", "thr_preview", "thr_c"]);
  });

  it("handles behavior 7", () => {
    const state = closeTabs(
      {
        version: 1,
        entries: [
          {
            threadId: "thr_pinned",
            projectId: "proj_a",
            title: "Pinned",
            pinned: true,
            openedAt: 1,
          },
          {
            threadId: "thr_preview",
            projectId: "proj_a",
            title: "Preview",
            pinned: false,
            openedAt: 2,
          },
          {
            threadId: "thr_kept",
            projectId: "proj_b",
            title: "Keep",
            pinned: true,
            openedAt: 3,
          },
        ],
      },
      ["thr_pinned", "thr_preview", "thr_missing"],
    );

    expect(state.entries.map((entry) => entry.threadId)).toEqual(["thr_kept"]);
  });

  it("handles behavior 8", () => {
    const state = closeTab(
      {
        version: 1,
        entries: [
          {
            threadId: "thr_a",
            projectId: "proj_a",
            title: "A",
            pinned: true,
            openedAt: 1,
          },
          {
            threadId: "thr_b",
            projectId: "proj_b",
            title: "B",
            pinned: false,
            openedAt: 2,
          },
        ],
      },
      "thr_a",
    );

    expect(state.entries.map((entry) => entry.threadId)).toEqual(["thr_b"]);
  });
});
