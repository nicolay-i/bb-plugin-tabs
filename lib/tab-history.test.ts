import { describe, expect, it } from "vitest";
import {
  MAX_TAB_HISTORY_ENTRIES,
  normalizeTabHistory,
  setTabHistoryAvailability,
  tabHistoriesEqual,
  visitTabHistory,
  type TabHistoryState,
} from "./tab-history";

const candidate = (id: string) => ({
  threadId: `thr_${id}`,
  projectId: `proj_${id}`,
  title: `Чат ${id}`,
});

describe("история вкладок", () => {
  it("нормализует записи, оставляя последнее посещение каждого чата", () => {
    const history = normalizeTabHistory({
      version: 1,
      entries: [
        { ...candidate("old"), visitedAt: 10 },
        { ...candidate("new"), visitedAt: 30 },
        { ...candidate("old"), title: "Новое имя", visitedAt: 40 },
        { threadId: "", projectId: "proj_bad", title: "Плохая", visitedAt: 50 },
      ],
    });

    expect(history.entries).toEqual([
      {
        threadId: "thr_old",
        projectId: "proj_old",
        title: "Новое имя",
        visitedAt: 40,
      },
      { ...candidate("new"), visitedAt: 30 },
    ]);
  });

  it("переносит повторно открытый чат в начало без дубликата", () => {
    const history: TabHistoryState = {
      version: 1,
      entries: [
        { ...candidate("first"), visitedAt: 30 },
        { ...candidate("second"), visitedAt: 20 },
      ],
    };

    const visited = visitTabHistory(history, {
      ...candidate("second"),
      title: "Обновлённый второй",
    }, 40);

    expect(visited.entries).toEqual([
      {
        threadId: "thr_second",
        projectId: "proj_second",
        title: "Обновлённый второй",
        visitedAt: 40,
      },
      { ...candidate("first"), visitedAt: 30 },
    ]);
    expect(tabHistoriesEqual(visited, { ...visited, entries: [...visited.entries] })).toBe(
      true,
    );
  });

  it("оставляет в истории archive/delete tombstone и снимает его при доступности", () => {
    const history: TabHistoryState = {
      version: 1,
      entries: [
        { ...candidate("archive"), visitedAt: 30 },
        { ...candidate("delete"), visitedAt: 20 },
        { ...candidate("live"), visitedAt: 10 },
      ],
    };
    const marked = setTabHistoryAvailability(
      history,
      new Map([
        ["thr_archive", "archived" as const],
        ["thr_delete", "deleted" as const],
      ]),
    );

    expect(marked.entries).toEqual([
      expect.objectContaining({
        threadId: "thr_archive",
        unavailableReason: "archived",
      }),
      expect.objectContaining({
        threadId: "thr_delete",
        unavailableReason: "deleted",
      }),
      expect.not.objectContaining({ unavailableReason: expect.anything() }),
    ]);

    const restored = setTabHistoryAvailability(
      marked,
      new Map([["thr_archive", null]]),
    );
    expect(restored.entries[0]).toEqual(
      expect.not.objectContaining({ unavailableReason: expect.anything() }),
    );
    // Нормальный новый визит также очищает старую причину недоступности.
    expect(
      visitTabHistory(marked, candidate("delete"), 40).entries[0],
    ).toEqual(
      expect.not.objectContaining({ unavailableReason: expect.anything() }),
    );
  });

  it("ограничивает persistent историю безопасным размером", () => {
    let history: TabHistoryState = { version: 1, entries: [] };
    for (let index = 0; index < MAX_TAB_HISTORY_ENTRIES + 3; index += 1) {
      history = visitTabHistory(history, candidate(String(index)), index);
    }

    expect(history.entries).toHaveLength(MAX_TAB_HISTORY_ENTRIES);
    expect(history.entries[0]?.threadId).toBe(`thr_${MAX_TAB_HISTORY_ENTRIES + 2}`);
    expect(history.entries.at(-1)?.threadId).toBe("thr_3");
  });
});
