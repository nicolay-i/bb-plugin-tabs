import { describe, expect, it } from "vitest";
import {
  addTabCandidates,
  closeTab,
  closeTabs,
  movePinnedTab,
  normalizeTabsState,
  openTabCandidate,
  restoreClosedTab,
  setTabPinned,
  setTabFavorite,
  tabsStatesEqual,
  MAX_TAB_ENTRIES,
} from "./tabs-model";

describe("Chat Tabs", () => {
  it("restores original position/time/pin without replacing a preview, duplicating tabs or evicting at capacity", () => {
    const entry = {
      threadId: "closed",
      projectId: "project",
      title: "Closed",
      pinned: false,
      openedAt: 5,
    };
    const pinned = { ...entry, threadId: "pin", pinned: true };
    const preview = { ...entry, threadId: "preview", openedAt: 10 };
    const state = { version: 1 as const, entries: [pinned, preview], favorites: [entry] };
    const restored = restoreClosedTab(state, entry, 1);
    expect(restored.entries.map((item) => item.threadId)).toEqual(["pin", "closed", "preview"]);
    expect(restored.entries[1]).toEqual({ ...entry, pinned: true });
    expect(restored.favorites).toEqual([entry]);
    expect(restoreClosedTab(restored, entry, 0)).toEqual(restored);
    expect(restoreClosedTab({ version: 1, entries: [] }, entry, 1).entries).toEqual([entry]);
    const full = {
      version: 1 as const,
      entries: Array.from({ length: 100 }, (_, i) => ({ ...pinned, threadId: `full-${i}` })),
    };
    expect(() => restoreClosedTab(full, entry, 0)).toThrow("100 chats");
    expect(full.entries).toHaveLength(100);
  });

  it("normalizes favorite snapshots without treating them as open previews", () => {
    const entry = {
      threadId: "thr_saved",
      projectId: "proj_api",
      title: "Saved",
      pinned: false,
      openedAt: 1,
    };
    const state = normalizeTabsState({
      version: 1,
      entries: [],
      favorites: [entry, null, { ...entry, title: "Latest" }, { threadId: "" }],
    });
    expect(state.entries).toEqual([]);
    expect(state.favorites).toEqual([{ ...entry, title: "Latest" }]);
    expect(tabsStatesEqual(state, { version: 1, entries: [] })).toBe(false);
    expect(tabsStatesEqual(state, normalizeTabsState(state))).toBe(true);
    expect(closeTabs(state, [entry.threadId]).favorites).toEqual(state.favorites);
    expect(normalizeTabsState(closeTabs(state, [entry.threadId], true)).favorites).toBeUndefined();
  });

  it("rejects unknown favorites and overflow without evicting saved chats", () => {
    const entries = Array.from({ length: MAX_TAB_ENTRIES }, (_, index) => ({
      threadId: `thr_${index}`,
      projectId: "proj_api",
      title: "Saved",
      pinned: true,
      openedAt: index,
    }));
    const state = {
      version: 1 as const,
      entries: [{ ...entries[0]!, threadId: "thr_new" }],
      favorites: entries,
    };
    expect(() => setTabFavorite(state, "thr_new", true)).toThrow("100 chats");
    expect(() => setTabFavorite(state, "thr_missing", true)).toThrow("Open the chat");
    expect(state.favorites).toHaveLength(MAX_TAB_ENTRIES);
  });

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

    expect(state.entries.map((entry) => entry.threadId)).toEqual(["thr_fixed", "thr_new"]);
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
    expect(movePinnedTab(state, "thr_a", "thr_preview", "before")).toEqual(state);
    expect(
      movePinnedTab(state, "thr_a", "thr_other", "after").entries.map((entry) => entry.threadId),
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
