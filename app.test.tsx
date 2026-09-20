// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { movePinnedTab, type TabsState } from "./lib/tabs-model";

const app = await loadPluginApp(() => import("./app"));

function sidebarThread(
  id: string,
  projectId: string,
  title: string,
  overrides: Partial<PluginSidebarThread> = {},
): PluginSidebarThread {
  return {
    id,
    projectId,
    title,
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    createdAt: 1,
    updatedAt: 1,
    lastReadAt: null,
    latestAttentionAt: 0,
    ...overrides,
  };
}

function installMatchMedia(matches: boolean): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(window, "matchMedia");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
  return () => {
    if (descriptor === undefined) {
      delete (window as Window & { matchMedia?: unknown }).matchMedia;
    } else {
      Object.defineProperty(window, "matchMedia", descriptor);
    }
  };
}

interface DesktopBrowserFocusBridge {
  onFocus(listener: (tabId: string) => void): () => void;
}

interface DesktopCloseRequestBridge {
  browser: DesktopBrowserFocusBridge;
  onCloseWindowRequest(listener: () => boolean): () => void;
}

type DesktopHost = typeof globalThis & { bbDesktop?: unknown };

const desktopHost = globalThis as DesktopHost;
let previousDesktopBridge: unknown;

function installDesktopCloseRequestBridge(): {
  dispatch: () => boolean;
  dispatchBrowserViewFocus: (tabId: string) => void;
  browserFocusListenerCount: () => number;
  listenerCount: () => number;
} {
  const listeners = new Set<() => boolean>();
  const browserFocusListeners = new Set<(tabId: string) => void>();
  const bridge: DesktopCloseRequestBridge = {
    browser: {
      onFocus(listener) {
        browserFocusListeners.add(listener);
        return () => browserFocusListeners.delete(listener);
      },
    },
    onCloseWindowRequest(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  desktopHost.bbDesktop = bridge;
  return {
    dispatch: () => {
      let handled = false;
      for (const listener of listeners) {
        handled = listener() || handled;
      }
      return handled;
    },
    dispatchBrowserViewFocus: (tabId) => {
      for (const listener of browserFocusListeners) {
        listener(tabId);
      }
    },
    browserFocusListenerCount: () => browserFocusListeners.size,
    listenerCount: () => listeners.size,
  };
}

beforeEach(() => {
  previousDesktopBridge = desktopHost.bbDesktop;
  desktopHost.bbDesktop = undefined;
  // jsdom/другие test cases могут менять visibility. Каждая UI-проверка
  // начинается как видимая вкладка, кроме теста hidden fallback ниже.
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: false,
  });
});

afterEach(() => {
  cleanup();
  desktopHost.bbDesktop = previousDesktopBridge;
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: false,
  });
});

describe("вкладки чатов", () => {
  it("не добавляет кнопку закрепления в штатную шапку чата", () => {
    expect(app.threadHeaderActions).toHaveLength(0);
  });

  it("не вызывает tabs_sync_activity для уже актуального snapshot activity", async () => {
    const state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_current",
          projectId: "proj_api",
          title: "Текущий чат",
          pinned: true,
          openedAt: 1,
        },
      ],
    };
    let listCalls = 0;
    let syncCalls = 0;
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("Не зарегистрирован app overlay");

    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_current" },
      sidebarThreads: {
        threads: [sidebarThread("thr_current", "proj_api", "Текущий чат")],
        projects: [{ id: "proj_api", name: "API", isPersonal: false }],
      },
      rpc: {
        tabs_list: () => {
          listCalls += 1;
          return { state };
        },
        tabs_sync_activity: () => {
          syncCalls += 1;
          return { state };
        },
        tabs_open: () => ({ state }),
        tabs_set_pinned: () => ({ state }),
        tabs_close: () => ({ state, removed: false }),
        tabs_move: () => ({ state }),
      },
    });

    await slot.findByRole("button", { name: "Текущий чат" });
    await waitFor(() => expect(listCalls).toBe(1));
    expect(syncCalls).toBe(0);
  });

  it("ограничивает idle RPC и приостанавливает revalidation в hidden document", async () => {
    const state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_idle",
          projectId: "proj_api",
          title: "Спокойный чат",
          pinned: true,
          openedAt: 1,
        },
      ],
    };
    const previousHidden = document.hidden;
    let listCalls = 0;
    let syncCalls = 0;
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("Не зарегистрирован app overlay");

    vi.useFakeTimers();
    try {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: false,
      });
      renderSlot<{}, typeof rpcContract>(overlay, {}, {
        context: { projectId: "proj_api", threadId: "thr_idle" },
        sidebarThreads: {
          threads: [sidebarThread("thr_idle", "proj_api", "Спокойный чат")],
          projects: [{ id: "proj_api", name: "API", isPersonal: false }],
        },
        rpc: {
          tabs_list: () => {
            listCalls += 1;
            return { state };
          },
          tabs_sync_activity: () => {
            syncCalls += 1;
            return { state };
          },
          tabs_open: () => ({ state }),
          tabs_set_pinned: () => ({ state }),
          tabs_close: () => ({ state, removed: false }),
          tabs_move: () => ({ state }),
        },
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(listCalls).toBe(1);
      expect(syncCalls).toBe(0);

      // За десять секунд спокойного foreground нет второго `tabs_list`.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(listCalls).toBe(1);

      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: true,
      });
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(listCalls).toBe(1);

      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: false,
      });
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
        await vi.advanceTimersByTimeAsync(0);
      });
      // Возврат в foreground делает ровно один актуализирующий запрос.
      expect(listCalls).toBe(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(listCalls).toBe(2);
    } finally {
      // jsdom exposes `hidden` through a prototype getter; restore the value
      // explicitly so subsequent renderer tests again mount as visible.
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: previousHidden,
      });
      vi.useRealTimers();
    }
  });

  it("даёт в hover проект и полное имя чата, оставляя tab в одной строке", async () => {
    let state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_build",
          projectId: "proj_api",
          title: "Сборка",
          pinned: false,
          openedAt: 1,
        },
        {
          threadId: "thr_review",
          projectId: "proj_api",
          title: "Ревью",
          pinned: true,
          openedAt: 2,
        },
        {
          threadId: "thr_docs",
          projectId: "proj_api",
          title: "Документация",
          pinned: true,
          openedAt: 3,
        },
        {
          threadId: "thr_design",
          projectId: "proj_web",
          title: "Макет",
          pinned: true,
          openedAt: 4,
        },
      ],
    };
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("Не зарегистрирован app overlay");

    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_build" },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_build", "proj_api", "Сборка"),
          sidebarThread("thr_review", "proj_api", "Ревью"),
          sidebarThread("thr_docs", "proj_api", "Документация"),
          sidebarThread("thr_design", "proj_web", "Макет"),
        ],
        projects: [
          { id: "proj_api", name: "API", isPersonal: false },
          { id: "proj_web", name: "Web", isPersonal: false },
        ],
      },
      rpc: {
        tabs_list: () => ({ state }),
        tabs_sync_activity: () => ({ state }),
        tabs_open: () => ({ state }),
        tabs_set_pinned: ({ threadId, pinned }) => {
          state = {
            ...state,
            entries: state.entries.map((entry) =>
              entry.threadId === threadId ? { ...entry, pinned } : entry,
            ),
          };
          return { state };
        },
        tabs_close: ({ threadId }) => {
          const entries = state.entries.filter((entry) => entry.threadId !== threadId);
          const removed = entries.length !== state.entries.length;
          state = { ...state, entries };
          return { state, removed };
        },
        tabs_move: ({ sourceThreadId, targetThreadId, position }) => {
          state = movePinnedTab(
            state,
            sourceThreadId,
            targetThreadId,
            position,
          );
          return { state };
        },
      },
    });

    await waitFor(() => {
      expect(
        slot.container
          .querySelector("#bb-chat-tabs-overlay")
          ?.getAttribute("data-row-count"),
      ).toBe("1");
    });
    const overlayElement = slot.container.querySelector("#bb-chat-tabs-overlay");
    if (!(overlayElement instanceof HTMLElement)) {
      throw new Error("Не найден overlay вкладок");
    }
    // Пока все вкладки помещаются, верхняя scrollbar не занимает место.
    expect(overlayElement.getAttribute("data-scrollable")).toBe("false");

    // Название проекта не занимает место в полосе: оба полных имени — в hover.
    expect(slot.queryByText("API")).toBeNull();
    expect(slot.queryByText("Web")).toBeNull();
    const buildTab = await slot.findByRole("button", { name: "Сборка" });
    expect(buildTab.getAttribute("title")).toContain("Проект: API");
    expect(buildTab.getAttribute("title")).toContain("Чат: Сборка");
    expect(buildTab.getAttribute("title")).toContain(
      "Кликните, чтобы открыть чат.",
    );
    expect(buildTab.getAttribute("aria-description")).toContain(
      "Клик открывает чат.",
    );
    expect(
      buildTab.closest(".bb-chat-tab")?.getAttribute("data-preview"),
    ).toBe("true");
    expect(slot.container.querySelectorAll(".bb-chat-tab")).toHaveLength(4);
    expect(slot.queryByRole("button", { name: /Закрепить «/u })).toBeNull();

    const strip = slot.container.querySelector(".bb-chat-tabs-strip");
    if (!(strip instanceof HTMLDivElement)) {
      throw new Error("Не найдена полоса вкладок");
    }
    const topScrollbar = slot.container.querySelector(
      ".bb-chat-tabs-top-scrollbar",
    );
    if (!(topScrollbar instanceof HTMLDivElement)) {
      throw new Error("Не найдена верхняя scrollbar");
    }
    expect(topScrollbar.getAttribute("aria-hidden")).toBe("true");
    expect(topScrollbar.tabIndex).toBe(-1);

    Object.defineProperties(strip, {
      clientWidth: { configurable: true, value: 100 },
      scrollWidth: { configurable: true, value: 400 },
    });
    fireEvent.resize(window);
    await waitFor(() => {
      expect(overlayElement.getAttribute("data-scrollable")).toBe("true");
    });
    expect(topScrollbar.getAttribute("aria-hidden")).toBe("false");
    expect(topScrollbar.tabIndex).toBe(0);

    // Внутренней вертикали нет: даже над *активной* button wheel листает
    // общую горизонтальную полосу.
    expect(buildTab.getAttribute("aria-current")).toBe("page");
    strip.scrollLeft = 0;
    const alreadyPrevented = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 48,
    });
    alreadyPrevented.preventDefault();
    expect(alreadyPrevented.defaultPrevented).toBe(true);
    buildTab.dispatchEvent(alreadyPrevented);
    expect(strip.scrollLeft).toBe(48);
    fireEvent.wheel(buildTab, { ctrlKey: true, deltaY: 48 });
    expect(strip.scrollLeft).toBe(48);

    // Верхняя scrollbar и скрытый content scroller всегда синхронизированы.
    topScrollbar.scrollLeft = 120;
    fireEvent.scroll(topScrollbar);
    expect(strip.scrollLeft).toBe(120);
    strip.scrollLeft = 84;
    fireEvent.scroll(strip);
    expect(topScrollbar.scrollLeft).toBe(84);

    // Preview остаётся временной, но закреплённая вкладка свободно проходит
    // через границу проектов в общем горизонтальном порядке.
    const docsTab = slot.getByRole("button", { name: "Документация" });
    const docsContainer = docsTab.closest(".bb-chat-tab");
    const previewContainer = buildTab.closest(".bb-chat-tab");
    const designAfterSlot = strip.querySelector(
      '[data-drop-target="thr_design"][data-drop-position="after"]',
    );
    if (
      !(docsContainer instanceof HTMLDivElement) ||
      !(previewContainer instanceof HTMLDivElement) ||
      !(designAfterSlot instanceof HTMLDivElement)
    ) {
      throw new Error("Не найдены контейнеры вкладок/щель для drag-and-drop");
    }
    expect(previewContainer.draggable).toBe(false);
    expect(docsContainer.draggable).toBe(true);
    expect(docsContainer.getAttribute("data-drop-position")).toBeNull();
    const dataTransfer = {
      dropEffect: "",
      effectAllowed: "",
      setData: vi.fn(),
    };
    fireEvent.dragStart(docsContainer, { dataTransfer });
    const dragOver = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperties(dragOver, {
      clientX: { value: 180 },
      dataTransfer: { value: dataTransfer },
    });
    fireEvent(designAfterSlot, dragOver);
    await waitFor(() => {
      expect(designAfterSlot.getAttribute("data-active")).toBe("true");
      expect(
        strip.querySelectorAll('.bb-chat-tab-drop-slot[data-active="true"]'),
      ).toHaveLength(1);
    });
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperties(drop, {
      clientX: { value: 180 },
      dataTransfer: { value: dataTransfer },
    });
    fireEvent(designAfterSlot, drop);
    await waitFor(() => {
      expect(state.entries.map((entry) => entry.threadId)).toEqual([
        "thr_build",
        "thr_review",
        "thr_design",
        "thr_docs",
      ]);
      expect(
        [...strip.querySelectorAll(".bb-chat-tab-select")].map((tab) =>
          tab.getAttribute("aria-label"),
        ),
      ).toEqual(["Ревью", "Макет", "Документация", "Сборка"]);
    });

    // Остаточный deltaX не должен ломать первый жест после смены направления.
    strip.scrollLeft = 150;
    fireEvent.wheel(buildTab, { deltaX: 8, deltaY: -48 });
    expect(strip.scrollLeft).toBe(102);
    fireEvent.wheel(buildTab, { deltaX: -8, deltaY: 48 });
    expect(strip.scrollLeft).toBe(150);

    fireEvent.click(slot.getByRole("button", { name: "Ревью" }));
    expect(slot.inspection.sidebarActionCalls).toEqual([
      { method: "open", threadId: "thr_review", options: undefined },
    ]);

    fireEvent.doubleClick(buildTab);
    await waitFor(() => {
      expect(
        state.entries.find((entry) => entry.threadId === "thr_build")?.pinned,
      ).toBe(true);
    });
  });

  it("показывает pinned перед историей и догружает её click/hover/tap через «Ещё»", async () => {
    const state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_api_current",
          projectId: "proj_api",
          title: "Текущий API",
          pinned: true,
          openedAt: 1,
        },
        {
          threadId: "thr_web",
          projectId: "proj_web",
          title: "Макет",
          pinned: true,
          openedAt: 2,
        },
        {
          threadId: "thr_api_review",
          projectId: "proj_api",
          title: "Ревью API",
          pinned: true,
          openedAt: 3,
        },
      ],
    };
    const history = {
      version: 1 as const,
      entries: Array.from({ length: 26 }, (_, index) => ({
        threadId: `thr_history_${index}`,
        projectId: index % 2 === 0 ? "proj_api" : "proj_web",
        title: `Исторический чат ${index}`,
        visitedAt: 100 - index,
      })),
    };
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("Не зарегистрирован app overlay");

    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_api_current" },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_api_current", "proj_api", "Текущий API"),
          sidebarThread("thr_web", "proj_web", "Макет", {
            activity: {
              workflows: 1,
              backgroundAgents: 0,
              backgroundCommands: 0,
              planMode: 0,
              goals: 0,
            },
            indicator: "workflow",
          }),
          sidebarThread("thr_api_review", "proj_api", "Ревью API", {
            isUnread: true,
          }),
          ...history.entries.map((entry, index) =>
            sidebarThread(entry.threadId, entry.projectId, entry.title, {
              isUnread: index === 25,
            }),
          ),
        ],
        projects: [
          { id: "proj_api", name: "API", isPersonal: false },
          { id: "proj_web", name: "Web", isPersonal: false },
        ],
      },
      rpc: {
        tabs_list: () => ({ state, history }),
        tabs_history_visit: () => ({ history }),
        tabs_sync_activity: () => ({ state }),
        tabs_open: () => ({ state }),
        tabs_set_pinned: () => ({ state }),
        tabs_close: () => ({ state, removed: false }),
      },
    });

    const trigger = await slot.findByRole("button", {
      name: "Список открытых чатов",
    });
    expect(trigger.querySelector('[data-icon="ListView"]')).not.toBeNull();
    expect(slot.queryByRole("combobox", { name: "Перейти к чату" })).toBeNull();
    expect(slot.container.querySelector("select")).toBeNull();

    // Radix DropdownMenu намеренно открывается на pointerdown, чтобы
    // поддержать touch и не позволить click уйти в фоновый strip.
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    let menu: HTMLElement | null = null;
    await waitFor(() => {
      menu = document.body.querySelector(".bb-chat-tabs-list-menu");
      expect(menu).not.toBeNull();
    });
    if (menu === null) throw new Error("Не открылось подменю списка вкладок");

    const groups = [
      ...menu.querySelectorAll<HTMLElement>(".bb-chat-tabs-list-menu-group"),
    ];
    expect(
      groups.map(
        (group) =>
          group.querySelector(".bb-chat-tabs-list-menu-group-label")?.textContent,
      ),
    ).toEqual(["Закреплённые", "История"]);
    expect(
      [...groups[0]!.querySelectorAll<HTMLElement>("[data-thread-id]")].map(
        (item) => item.dataset.threadId,
      ),
    ).toEqual(["thr_api_current", "thr_web", "thr_api_review"]);
    const currentMenuItem = menu.querySelector<HTMLElement>(
      '[data-thread-id="thr_api_current"]',
    );
    const workingMenuItem = menu.querySelector<HTMLElement>(
      '[data-thread-id="thr_web"]',
    );
    const unreadMenuItem = menu.querySelector<HTMLElement>(
      '[data-thread-id="thr_api_review"]',
    );
    expect(
      currentMenuItem?.querySelector(".bb-chat-tabs-list-menu-status"),
    ).toBeNull();
    expect(
      workingMenuItem
        ?.querySelector(".bb-chat-tabs-list-menu-status")
        ?.getAttribute("data-status"),
    ).toBe("working");
    expect(workingMenuItem?.textContent).toContain("Работает");
    expect(
      unreadMenuItem
        ?.querySelector(".bb-chat-tabs-list-menu-status")
        ?.getAttribute("data-status"),
    ).toBe("unread");
    expect(unreadMenuItem?.textContent).toContain("Непрочитанное");
    const unreadMeta = unreadMenuItem?.querySelector(
      ".bb-chat-tabs-list-menu-meta",
    );
    expect(
      unreadMeta?.firstElementChild?.classList.contains(
        "bb-chat-tabs-list-menu-project",
      ),
    ).toBe(true);
    expect(unreadMeta?.lastElementChild).toBe(
      unreadMenuItem?.querySelector(".bb-chat-tabs-list-menu-status"),
    );
    const historyGroup = groups[1];
    if (historyGroup === undefined) throw new Error("Не найден раздел истории");
    expect(
      [...historyGroup.querySelectorAll<HTMLElement>("[data-thread-id]")].map(
        (item) => item.dataset.threadId,
      ),
    ).toEqual(history.entries.slice(0, 8).map((entry) => entry.threadId));
    const historyPageSeparators = () =>
      [
        ...historyGroup.querySelectorAll<HTMLElement>(
          ".bb-chat-tabs-list-menu-history-page-separator",
        ),
      ];
    // Пока показана только первая порция, граница следующей страницы не нужна.
    expect(historyPageSeparators()).toHaveLength(0);

    let more = menu.querySelector<HTMLElement>(".bb-chat-tabs-list-menu-more");
    if (more === null) throw new Error("Не найден пункт «Ещё»");
    vi.useFakeTimers();
    try {
      // Уход указателя отменяет pending desktop-таймер.
      fireEvent.pointerEnter(more, { pointerType: "mouse" });
      expect(more.getAttribute("data-pending")).toBe("true");
      fireEvent.pointerLeave(more, { pointerType: "mouse" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_100);
      });
      expect(historyGroup.querySelectorAll("[data-thread-id]")).toHaveLength(8);

      // Обычный mouse click раскрывает порцию сразу и отменяет hover-таймер,
      // поэтому та же страница не может добавиться повторно через секунду.
      fireEvent.pointerEnter(more, { pointerType: "mouse" });
      expect(more.getAttribute("data-pending")).toBe("true");
      fireEvent.pointerDown(more, { pointerType: "mouse" });
      fireEvent.click(more);
      expect(historyGroup.querySelectorAll("[data-thread-id]")).toHaveLength(16);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_100);
      });
      expect(historyGroup.querySelectorAll("[data-thread-id]")).toHaveLength(16);
      const [firstPageSeparator] = historyPageSeparators();
      expect(firstPageSeparator?.getAttribute("aria-label")).toBe(
        "Следующая страница истории",
      );
      expect(
        firstPageSeparator?.previousElementSibling?.getAttribute(
          "data-thread-id",
        ),
      ).toBe("thr_history_7");
      expect(
        firstPageSeparator?.nextElementSibling?.getAttribute("data-thread-id"),
      ).toBe("thr_history_8");

      // Desktop hover раскрывает следующую порцию автоматически через секунду.
      more = menu.querySelector<HTMLElement>(".bb-chat-tabs-list-menu-more");
      if (more === null) throw new Error("Не найден повторный пункт «Ещё»");
      fireEvent.pointerEnter(more, { pointerType: "mouse" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(historyGroup.querySelectorAll("[data-thread-id]")).toHaveLength(24);
      const [, secondPageSeparator] = historyPageSeparators();
      expect(historyPageSeparators()).toHaveLength(2);
      expect(
        secondPageSeparator?.previousElementSibling?.getAttribute(
          "data-thread-id",
        ),
      ).toBe("thr_history_15");
      expect(
        secondPageSeparator?.nextElementSibling?.getAttribute("data-thread-id"),
      ).toBe("thr_history_16");

      // Tap использует тот же доступный select-path и раскрывает последнюю
      // порцию сразу, без ожидания desktop hover-таймера.
      more = menu.querySelector<HTMLElement>(".bb-chat-tabs-list-menu-more");
      if (more === null) throw new Error("Не найден повторный пункт «Ещё»");
      fireEvent.pointerDown(more, { pointerType: "touch" });
      fireEvent.click(more);
      expect(historyGroup.querySelectorAll("[data-thread-id]")).toHaveLength(26);
      const [, , thirdPageSeparator] = historyPageSeparators();
      expect(historyPageSeparators()).toHaveLength(3);
      expect(
        thirdPageSeparator?.previousElementSibling?.getAttribute(
          "data-thread-id",
        ),
      ).toBe("thr_history_23");
      expect(
        thirdPageSeparator?.nextElementSibling?.getAttribute("data-thread-id"),
      ).toBe("thr_history_24");
    } finally {
      vi.useRealTimers();
    }

    const historicalItem = menu.querySelector<HTMLElement>(
      '[data-thread-id="thr_history_25"]',
    );
    if (historicalItem === null) throw new Error("Не найден исторический пункт");
    fireEvent.click(historicalItem);
    expect(slot.inspection.sidebarActionCalls).toEqual([
      { method: "open", threadId: "thr_history_25", options: undefined },
    ]);
  });

  it("оставляет archive/delete history tombstone зачёркнутыми и недоступными", async () => {
    const state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_current",
          projectId: "proj_api",
          title: "Текущий",
          pinned: true,
          openedAt: 1,
        },
      ],
    };
    const history = {
      version: 1 as const,
      entries: [
        {
          threadId: "thr_archived",
          projectId: "proj_api",
          title: "Старый архивный чат",
          visitedAt: 3,
          unavailableReason: "archived" as const,
        },
        {
          threadId: "thr_deleted",
          projectId: "proj_api",
          title: "Старый удалённый чат",
          visitedAt: 2,
          unavailableReason: "deleted" as const,
        },
      ],
    };
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("Не зарегистрирован app overlay");

    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_current" },
      sidebarThreads: {
        threads: [sidebarThread("thr_current", "proj_api", "Текущий")],
        projects: [{ id: "proj_api", name: "API", isPersonal: false }],
      },
      rpc: {
        tabs_list: () => ({ state, history }),
        tabs_history_visit: () => ({ history }),
        tabs_sync_activity: () => ({ state }),
        tabs_open: () => ({ state }),
        tabs_set_pinned: () => ({ state }),
        tabs_close: () => ({ state, removed: false }),
        tabs_move: () => ({ state }),
      },
    });

    // В strip остался только доступный current pin: tombstone никогда не
    // превращается в вкладку или root-pinned item.
    await slot.findByRole("button", { name: "Текущий" });
    expect(slot.container.querySelectorAll(".bb-chat-tab")).toHaveLength(1);

    const trigger = await slot.findByRole("button", {
      name: "Список открытых чатов",
    });
    fireEvent.pointerDown(trigger, { button: 0 });
    const menu = await waitFor(() => {
      const next = document.body.querySelector<HTMLElement>(
        ".bb-chat-tabs-list-menu",
      );
      expect(next).not.toBeNull();
      return next;
    });
    if (menu === null) throw new Error("Не открылось подменю списка вкладок");

    const archivedItem = menu.querySelector<HTMLElement>(
      '[data-thread-id="thr_archived"]',
    );
    const deletedItem = menu.querySelector<HTMLElement>(
      '[data-thread-id="thr_deleted"]',
    );
    if (archivedItem === null || deletedItem === null) {
      throw new Error("Не найдены недоступные history-записи");
    }

    expect(archivedItem.dataset.unavailable).toBe("archived");
    expect(archivedItem.hasAttribute("data-disabled")).toBe(true);
    expect(archivedItem.getAttribute("aria-label")).toContain("В архиве");
    expect(archivedItem.querySelector('[data-icon="Archive"]')).not.toBeNull();
    expect(
      archivedItem
        .querySelector(".bb-chat-tabs-list-menu-title")
        ?.getAttribute("data-unavailable"),
    ).toBe("archived");
    expect(archivedItem.textContent).toContain("В архиве");

    expect(deletedItem.dataset.unavailable).toBe("deleted");
    expect(deletedItem.hasAttribute("data-disabled")).toBe(true);
    expect(deletedItem.getAttribute("aria-label")).toContain("Удалён");
    expect(deletedItem.querySelector('[data-icon="Trash2"]')).not.toBeNull();
    expect(
      deletedItem
        .querySelector(".bb-chat-tabs-list-menu-title")
        ?.getAttribute("data-unavailable"),
    ).toBe("deleted");
    expect(deletedItem.textContent).toContain("Удалён");

    fireEvent.click(archivedItem);
    fireEvent.click(deletedItem);
    expect(slot.inspection.sidebarActionCalls).toEqual([]);
  });

  it("учитывает отдельную видимость верхней полосы на desktop и touch", async () => {
    const state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_current",
          projectId: "proj_api",
          title: "Текущий",
          pinned: true,
          openedAt: 1,
        },
        {
          threadId: "thr_other",
          projectId: "proj_api",
          title: "Другой",
          pinned: true,
          openedAt: 2,
        },
      ],
    };
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("Не зарегистрирован app overlay");

    let desktopListCalls = 0;
    const desktop = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_current" },
      settings: { showTabsOnDesktop: false },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_current", "proj_api", "Текущий"),
          sidebarThread("thr_other", "proj_api", "Другой"),
        ],
        projects: [{ id: "proj_api", name: "API", isPersonal: false }],
      },
      rpc: {
        tabs_list: () => {
          desktopListCalls += 1;
          return { state };
        },
        tabs_sync_activity: () => ({ state }),
        tabs_open: () => ({ state }),
        tabs_set_pinned: () => ({ state }),
        tabs_close: () => ({ state, removed: false }),
      },
    });
    expect(
      desktop.container
        .querySelector("#bb-chat-tabs-overlay")
        ?.getAttribute("data-docked"),
    ).toBe("false");
    await act(async () => undefined);
    expect(desktopListCalls).toBe(0);
    desktop.unmount();

    const restoreMatchMedia = installMatchMedia(true);
    try {
      let mobileListCalls = 0;
      const mobile = renderSlot<{}, typeof rpcContract>(overlay, {}, {
        context: { projectId: "proj_api", threadId: "thr_current" },
        settings: { showTabsOnMobile: false },
        sidebarThreads: {
          threads: [
            sidebarThread("thr_current", "proj_api", "Текущий"),
            sidebarThread("thr_other", "proj_api", "Другой"),
          ],
          projects: [{ id: "proj_api", name: "API", isPersonal: false }],
        },
        rpc: {
          tabs_list: () => {
            mobileListCalls += 1;
            return { state };
          },
          tabs_sync_activity: () => ({ state }),
          tabs_open: () => ({ state }),
          tabs_set_pinned: () => ({ state }),
          tabs_close: () => ({ state, removed: false }),
        },
      });
      expect(
        mobile.container
          .querySelector("#bb-chat-tabs-overlay")
          ?.getAttribute("data-docked"),
      ).toBe("false");
      await act(async () => undefined);
      expect(mobileListCalls).toBe(0);
      mobile.unmount();
    } finally {
      restoreMatchMedia();
    }
  });

  it("настраивает состав списка и положение кнопки без изменения tab state", async () => {
    const state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_current",
          projectId: "proj_api",
          title: "Текущий",
          pinned: true,
          openedAt: 1,
        },
        {
          threadId: "thr_pinned",
          projectId: "proj_api",
          title: "Закреплённый",
          pinned: true,
          openedAt: 2,
        },
      ],
    };
    const history = {
      version: 1 as const,
      entries: [
        {
          threadId: "thr_pinned",
          projectId: "proj_api",
          title: "Закреплённый",
          visitedAt: 3,
        },
        {
          threadId: "thr_history_one",
          projectId: "proj_api",
          title: "Первый из истории",
          visitedAt: 2,
        },
        {
          threadId: "thr_history_two",
          projectId: "proj_api",
          title: "Второй из истории",
          visitedAt: 1,
        },
      ],
    };
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("Не зарегистрирован app overlay");
    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_current" },
      settings: {
        showTabListPinned: false,
        showTabListHistory: true,
        tabListButtonPosition: "Справа",
      },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_current", "proj_api", "Текущий"),
          sidebarThread("thr_pinned", "proj_api", "Закреплённый"),
          sidebarThread("thr_history_one", "proj_api", "Первый из истории"),
          sidebarThread("thr_history_two", "proj_api", "Второй из истории"),
        ],
        projects: [{ id: "proj_api", name: "API", isPersonal: false }],
      },
      rpc: {
        tabs_list: () => ({ state, history }),
        tabs_history_visit: () => ({ history }),
        tabs_sync_activity: () => ({ state }),
        tabs_open: () => ({ state }),
        tabs_set_pinned: () => ({ state }),
        tabs_close: () => ({ state, removed: false }),
      },
    });

    const trigger = await slot.findByRole("button", {
      name: "Список открытых чатов",
    });
    const contentRow = slot.container.querySelector(
      ".bb-chat-tabs-content-row",
    );
    expect(contentRow?.lastElementChild).toBe(
      slot.container.querySelector(
        '.bb-chat-tabs-list-switcher[data-position="right"]',
      ),
    );
    fireEvent.pointerDown(trigger, { button: 0 });
    const menu = await waitFor(() => {
      const next = document.body.querySelector<HTMLElement>(
        ".bb-chat-tabs-list-menu",
      );
      expect(next).not.toBeNull();
      return next;
    });
    expect(
      [...menu.querySelectorAll(".bb-chat-tabs-list-menu-group-label")].map(
        (label) => label.textContent,
      ),
    ).toEqual(["История"]);
    expect(menu.textContent).not.toContain("Закреплённые");
    // При отключённом pinned-разделе ранее закреплённый чат остаётся
    // достижимым из включённой истории, а не пропадает из меню.
    expect(menu.textContent).toContain("Закреплённый");
    expect(menu.textContent).toContain("Первый из истории");
  });

  it("может показывать в списке только закреплённые чаты", async () => {
    const state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_current",
          projectId: "proj_api",
          title: "Текущий",
          pinned: true,
          openedAt: 1,
        },
        {
          threadId: "thr_pinned",
          projectId: "proj_api",
          title: "Закреплённый",
          pinned: true,
          openedAt: 2,
        },
      ],
    };
    const history = {
      version: 1 as const,
      entries: [
        {
          threadId: "thr_history_one",
          projectId: "proj_api",
          title: "Первый из истории",
          visitedAt: 1,
        },
      ],
    };
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("Не зарегистрирован app overlay");
    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_current" },
      settings: { showTabListHistory: false },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_current", "proj_api", "Текущий"),
          sidebarThread("thr_pinned", "proj_api", "Закреплённый"),
          sidebarThread("thr_history_one", "proj_api", "Первый из истории"),
        ],
        projects: [{ id: "proj_api", name: "API", isPersonal: false }],
      },
      rpc: {
        tabs_list: () => ({ state, history }),
        tabs_history_visit: () => ({ history }),
        tabs_sync_activity: () => ({ state }),
        tabs_open: () => ({ state }),
        tabs_set_pinned: () => ({ state }),
        tabs_close: () => ({ state, removed: false }),
      },
    });

    const trigger = await slot.findByRole("button", {
      name: "Список открытых чатов",
    });
    fireEvent.pointerDown(trigger, { button: 0 });
    const menu = await waitFor(() => {
      const next = document.body.querySelector<HTMLElement>(
        ".bb-chat-tabs-list-menu",
      );
      expect(next).not.toBeNull();
      return next;
    });
    expect(
      [...menu.querySelectorAll(".bb-chat-tabs-list-menu-group-label")].map(
        (label) => label.textContent,
      ),
    ).toEqual(["Закреплённые"]);
    expect(menu.textContent).not.toContain("История");
  });

  it("скрывает кнопку списка отдельной настройкой", async () => {
    const state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_current",
          projectId: "proj_api",
          title: "Текущий",
          pinned: true,
          openedAt: 1,
        },
        {
          threadId: "thr_other",
          projectId: "proj_api",
          title: "Другой",
          pinned: true,
          openedAt: 2,
        },
      ],
    };
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("Не зарегистрирован app overlay");
    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_current" },
      settings: { showTabListButton: false },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_current", "proj_api", "Текущий"),
          sidebarThread("thr_other", "proj_api", "Другой"),
        ],
        projects: [{ id: "proj_api", name: "API", isPersonal: false }],
      },
      rpc: {
        tabs_list: () => ({ state }),
        tabs_sync_activity: () => ({ state }),
        tabs_open: () => ({ state }),
        tabs_set_pinned: () => ({ state }),
        tabs_close: () => ({ state, removed: false }),
      },
    });

    await slot.findByRole("button", { name: "Текущий" });
    expect(
      slot.queryByRole("button", { name: "Список открытых чатов" }),
    ).toBeNull();
  });

  it("закрывает текущую вкладку щелчком колёсика", async () => {
    let state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_current",
          projectId: "proj_api",
          title: "Текущий",
          pinned: true,
          openedAt: 1,
        },
        {
          threadId: "thr_next",
          projectId: "proj_api",
          title: "Следующий",
          pinned: true,
          openedAt: 2,
        },
      ],
    };
    let closeCalls = 0;
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("Не зарегистрирован app overlay");

    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_current" },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_current", "proj_api", "Текущий"),
          sidebarThread("thr_next", "proj_api", "Следующий"),
        ],
        projects: [{ id: "proj_api", name: "API", isPersonal: false }],
      },
      rpc: {
        tabs_list: () => ({ state }),
        tabs_sync_activity: () => ({ state }),
        tabs_open: () => ({ state }),
        tabs_set_pinned: () => ({ state }),
        tabs_close: ({ threadId }) => {
          closeCalls += 1;
          const entries = state.entries.filter((entry) => entry.threadId !== threadId);
          state = { ...state, entries };
          return { state, removed: true };
        },
      },
    });

    const currentTab = await slot.findByRole("button", { name: "Текущий" });
    expect(currentTab.getAttribute("title")).toContain(
      "Щелчок колёсиком закрывает вкладку.",
    );
    expect(currentTab.getAttribute("aria-description")).toContain(
      "Щелчок колёсиком закрывает вкладку.",
    );

    const middleDown = new MouseEvent("mousedown", {
      bubbles: true,
      button: 1,
      cancelable: true,
    });
    currentTab.dispatchEvent(middleDown);
    expect(middleDown.defaultPrevented).toBe(true);

    const rightAuxClick = new MouseEvent("auxclick", {
      bubbles: true,
      button: 2,
      cancelable: true,
    });
    currentTab.dispatchEvent(rightAuxClick);
    expect(closeCalls).toBe(0);
    expect(state.entries).toHaveLength(2);

    const middleAuxClick = new MouseEvent("auxclick", {
      bubbles: true,
      button: 1,
      cancelable: true,
    });
    currentTab.dispatchEvent(middleAuxClick);
    expect(middleAuxClick.defaultPrevented).toBe(true);
    await waitFor(() => {
      expect(state.entries.map((entry) => entry.threadId)).toEqual(["thr_next"]);
    });
    expect(closeCalls).toBe(1);
    expect(slot.inspection.sidebarActionCalls).toEqual([
      { method: "open", threadId: "thr_next", options: undefined },
    ]);
  });

  it("переименовывает pinned tab на месте и даёт все действия в контекстном меню", async () => {
    let state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_pinned",
          projectId: "proj_api",
          title: "Закреплённый чат",
          pinned: true,
          openedAt: 1,
        },
      ],
    };
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("Не зарегистрирован app overlay");

    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_pinned" },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_pinned", "proj_api", "Закреплённый чат"),
        ],
        projects: [{ id: "proj_api", name: "API", isPersonal: false }],
      },
      rpc: {
        tabs_list: () => ({ state }),
        tabs_sync_activity: ({ threads }) => {
          state = {
            ...state,
            entries: state.entries.map((entry) => {
              const candidate = threads.find(
                (thread) => thread.threadId === entry.threadId,
              );
              return candidate === undefined
                ? entry
                : {
                    ...entry,
                    projectId: candidate.projectId,
                    title: candidate.title,
                  };
            }),
          };
          return { state };
        },
        tabs_open: () => ({ state }),
        tabs_set_pinned: ({ threadId, pinned }) => {
          state = {
            ...state,
            entries: state.entries.map((entry) =>
              entry.threadId === threadId ? { ...entry, pinned } : entry,
            ),
          };
          return { state };
        },
        tabs_close: ({ threadId }) => {
          const entries = state.entries.filter((entry) => entry.threadId !== threadId);
          state = { ...state, entries };
          return { state, removed: true };
        },
      },
    });

    let pinnedTab = await slot.findByRole("button", {
      name: "Закреплённый чат",
    });
    expect(pinnedTab.getAttribute("title")).toContain(
      "Кликните, чтобы открыть чат.",
    );
    expect(pinnedTab.getAttribute("title")).not.toContain("редактирует");
    const title = pinnedTab.querySelector(".bb-chat-tab-title");
    if (!(title instanceof HTMLSpanElement)) {
      throw new Error("Не найдено название вкладки");
    }

    // Double click ровно по названию pinned tab открывает inline editor,
    // а не меняет pin state.
    fireEvent.doubleClick(title);
    const inlineInput = await slot.findByRole("textbox", {
      name: "Переименовать вкладку «Закреплённый чат»",
    });
    fireEvent.change(inlineInput, { target: { value: "Новое inline имя" } });
    fireEvent.keyDown(inlineInput, { key: "Enter" });
    await waitFor(() => {
      expect(slot.inspection.sidebarActionCalls).toContainEqual({
        method: "rename",
        threadId: "thr_pinned",
        title: "Новое inline имя",
      });
    });
    expect(state.entries[0]?.pinned).toBe(true);
    pinnedTab = slot.getByRole("button", { name: "Закреплённый чат" });

    // Escape не сохраняет текст даже если browser следом посылает blur.
    const titleAfterRename = pinnedTab.querySelector(".bb-chat-tab-title");
    if (!(titleAfterRename instanceof HTMLSpanElement)) {
      throw new Error("Не найдено название вкладки после inline rename");
    }
    fireEvent.doubleClick(titleAfterRename);
    const cancelledInput = await slot.findByRole("textbox", {
      name: "Переименовать вкладку «Закреплённый чат»",
    });
    fireEvent.change(cancelledInput, { target: { value: "Не сохранять" } });
    fireEvent.keyDown(cancelledInput, { key: "Escape" });
    fireEvent.blur(cancelledInput);
    expect(
      slot.inspection.sidebarActionCalls.filter(
        (call) => call.method === "rename",
      ),
    ).toHaveLength(1);
    pinnedTab = slot.getByRole("button", { name: "Закреплённый чат" });

    // В контекстном меню pinned tab предлагается только «Открепить».
    fireEvent.contextMenu(pinnedTab);
    const unpin = await slot.findByRole("menuitem", { name: "Открепить" });
    expect(slot.getByRole("menuitem", { name: "Переименовать" })).toBeTruthy();
    expect(
      slot.getByRole("menuitem", { name: "Скопировать ссылку" }),
    ).toBeTruthy();
    expect(
      slot.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual([
      "Скопировать ссылку",
      "Пометить непрочитанным",
      "Открепить",
      "Переименовать",
      "Архивировать",
    ]);
    expect(
      slot.getByRole("menuitem", { name: "Пометить непрочитанным" }),
    ).toBeTruthy();
    expect(slot.getByRole("menuitem", { name: "Архивировать" })).toBeTruthy();
    fireEvent.click(unpin);
    await waitFor(() => expect(state.entries[0]?.pinned).toBe(false));

    // Для preview меню предлагает обратное действие — «Закрепить».
    fireEvent.contextMenu(pinnedTab);
    const pin = await slot.findByRole("menuitem", { name: "Закрепить" });
    fireEvent.click(pin);
    await waitFor(() => expect(state.entries[0]?.pinned).toBe(true));

    // Modal переименования использует тот же официальный host action.
    fireEvent.contextMenu(pinnedTab);
    fireEvent.click(await slot.findByRole("menuitem", { name: "Переименовать" }));
    const modalInput = await slot.findByRole("textbox", {
      name: "Новое название чата",
    });
    fireEvent.change(modalInput, { target: { value: "Новое имя из modal" } });
    fireEvent.click(slot.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => {
      expect(slot.inspection.sidebarActionCalls).toContainEqual({
        method: "rename",
        threadId: "thr_pinned",
        title: "Новое имя из modal",
      });
    });

    fireEvent.contextMenu(pinnedTab);
    fireEvent.click(
      await slot.findByRole("menuitem", { name: "Пометить непрочитанным" }),
    );
    await waitFor(() => {
      expect(slot.inspection.sidebarActionCalls).toContainEqual({
        method: "setRead",
        threadId: "thr_pinned",
        read: false,
      });
    });

    fireEvent.contextMenu(pinnedTab);
    fireEvent.click(await slot.findByRole("menuitem", { name: "Архивировать" }));
    await waitFor(() => {
      expect(slot.inspection.sidebarActionCalls).toContainEqual({
        method: "archive",
        threadId: "thr_pinned",
      });
      expect(state.entries).toEqual([]);
    });
  });

  it("отмечает непрочитанные сообщения отдельной точкой, не смешивая их с работой", async () => {
    const state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_unread",
          projectId: "proj_api",
          title: "Непрочитанный чат",
          pinned: true,
          openedAt: 1,
        },
        {
          threadId: "thr_working",
          projectId: "proj_api",
          title: "Рабочий чат",
          pinned: true,
          openedAt: 2,
        },
      ],
    };
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("Не зарегистрирован app overlay");

    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_unread" },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_unread", "proj_api", "Непрочитанный чат", {
            isUnread: true,
          }),
          sidebarThread("thr_working", "proj_api", "Рабочий чат", {
            isUnread: true,
            activity: {
              workflows: 0,
              backgroundAgents: 1,
              backgroundCommands: 0,
              planMode: 0,
              goals: 0,
            },
            indicator: "background-agent",
          }),
        ],
        projects: [{ id: "proj_api", name: "API", isPersonal: false }],
      },
      rpc: {
        tabs_list: () => ({ state }),
        tabs_sync_activity: () => ({ state }),
        tabs_open: () => ({ state }),
        tabs_set_pinned: () => ({ state }),
        tabs_close: () => ({ state, removed: false }),
      },
    });

    const unreadTab = await slot.findByRole("button", {
      name: "Непрочитанный чат, есть непрочитанные сообщения",
    });
    expect(unreadTab.closest(".bb-chat-tab")?.getAttribute("data-unread")).toBe(
      "true",
    );
    expect(unreadTab.querySelector(".bb-chat-tab-unread")).not.toBeNull();
    expect(unreadTab.querySelector(".bb-chat-tab-working")).toBeNull();
    expect(unreadTab.getAttribute("title")).toContain(
      "Есть непрочитанные сообщения.",
    );

    const workingTab = slot.getByRole("button", {
      name: "Рабочий чат, работа выполняется, есть непрочитанные сообщения",
    });
    expect(workingTab.querySelector(".bb-chat-tab-working")).not.toBeNull();
    expect(workingTab.querySelector(".bb-chat-tab-unread")).not.toBeNull();
  });

  it("показывает закреплённые чаты на экране «Новый чат» и открывает выбранный", async () => {
    const state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_idle",
          projectId: "proj_api",
          title: "Спокойный чат",
          pinned: true,
          openedAt: 1,
        },
        {
          threadId: "thr_parent",
          projectId: "proj_api",
          title: "Родительский чат",
          pinned: true,
          openedAt: 2,
        },
        {
          threadId: "thr_running",
          projectId: "proj_web",
          title: "Активный чат",
          pinned: true,
          openedAt: 3,
        },
        {
          threadId: "thr_preview",
          projectId: "proj_api",
          title: "Временный чат",
          pinned: false,
          openedAt: 4,
        },
      ],
    };
    const homepage = app.homepageSections.find(
      (section) => section.id === "pinned-tabs",
    );
    if (homepage === undefined) {
      throw new Error("Не зарегистрирован homepage section закреплённых чатов");
    }

    const slot = renderSlot<{ projectId: string | null }, typeof rpcContract>(
      homepage,
      { projectId: "proj_api" },
      {
        context: { projectId: "proj_api", threadId: null },
        sidebarThreads: {
          threads: [
            sidebarThread("thr_idle", "proj_api", "Спокойный чат"),
            sidebarThread("thr_parent", "proj_api", "Родительский чат", {
              isUnread: true,
            }),
            sidebarThread("thr_child", "proj_api", "Вложенный workflow", {
              parentThreadId: "thr_parent",
              activity: {
                workflows: 1,
                backgroundAgents: 0,
                backgroundCommands: 0,
                planMode: 0,
                goals: 0,
              },
              indicator: "workflow",
            }),
            sidebarThread("thr_running", "proj_web", "Активный чат", {
              activity: {
                workflows: 0,
                backgroundAgents: 1,
                backgroundCommands: 0,
                planMode: 0,
                goals: 0,
              },
              indicator: "background-agent",
            }),
            sidebarThread("thr_preview", "proj_api", "Временный чат"),
          ],
          projects: [
            { id: "proj_api", name: "API", isPersonal: false },
            { id: "proj_web", name: "Web", isPersonal: false },
          ],
        },
        rpc: {
          tabs_list: () => ({ state }),
          tabs_sync_activity: () => ({ state }),
          tabs_open: () => ({ state }),
          tabs_set_pinned: () => ({ state }),
          tabs_close: () => ({ state, removed: false }),
        },
      },
    );

    const list = await slot.findByRole("list", { name: "Закреплённые чаты" });
    const rows = [
      ...list.querySelectorAll(".bb-chat-tabs-homepage-pinned-item"),
    ];
    expect(rows).toHaveLength(3);
    expect(
      rows.map(
        (row) =>
          row.querySelector(".bb-chat-tabs-homepage-pinned-title")?.textContent,
      ),
    ).toEqual(["Спокойный чат", "Родительский чат", "Активный чат"]);
    expect(list.textContent).not.toContain("Нет активности");
    expect(
      rows[0]?.querySelector(".bb-chat-tabs-homepage-pinned-status"),
    ).toBeNull();
    expect(list.textContent).toContain("Работает · Непрочитанное");
    expect(list.textContent).toContain("Работает");
    expect(slot.getByRole("button", {
      name: "Спокойный чат. Проект: API.",
    })).toBeTruthy();
    const activeMeta = rows[2]?.querySelector(
      ".bb-chat-tabs-homepage-pinned-meta",
    );
    const activeStatus = rows[2]?.querySelector(
      ".bb-chat-tabs-homepage-pinned-status",
    );
    expect(
      activeMeta?.firstElementChild?.classList.contains(
        "bb-chat-tabs-homepage-pinned-project",
      ),
    ).toBe(true);
    expect(activeMeta?.lastElementChild).toBe(activeStatus);
    expect(
      rows[0]
        ?.querySelector(".bb-chat-tabs-homepage-pinned-project")
        ?.getAttribute("title"),
    ).toBe("API");
    expect(slot.queryByText("Временный чат")).toBeNull();

    const activeChatButton = slot.getByRole("button", {
      name: "Активный чат. Проект: Web. Работает.",
    });
    fireEvent.click(activeChatButton);
    expect(slot.inspection.sidebarActionCalls).toContainEqual({
      method: "open",
      threadId: "thr_running",
      options: undefined,
    });
  });

  it("скрывает быстрый список на экране «Новый чат» при выключенной настройке", async () => {
    const state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_current",
          projectId: "proj_api",
          title: "Текущий",
          pinned: true,
          openedAt: 1,
        },
      ],
    };
    const homepage = app.homepageSections.find(
      (section) => section.id === "pinned-tabs",
    );
    if (homepage === undefined) {
      throw new Error("Не зарегистрирован homepage section закреплённых чатов");
    }
    let listCalls = 0;

    const slot = renderSlot<{ projectId: string | null }, typeof rpcContract>(
      homepage,
      { projectId: "proj_api" },
      {
        context: { projectId: "proj_api", threadId: null },
        settings: { showPinnedTabsList: false },
        sidebarThreads: {
          threads: [sidebarThread("thr_current", "proj_api", "Текущий")],
          projects: [{ id: "proj_api", name: "API", isPersonal: false }],
        },
        rpc: {
          tabs_list: () => {
            listCalls += 1;
            return { state };
          },
          tabs_sync_activity: () => ({ state }),
          tabs_open: () => ({ state }),
          tabs_set_pinned: () => ({ state }),
          tabs_close: () => ({ state, removed: false }),
        },
      },
    );

    const list = await slot.findByTestId("bb-chat-tabs-homepage-pinned-list");
    expect(list.getAttribute("data-visible")).toBe("false");
    expect(slot.queryByRole("button", { name: /Текущий/u })).toBeNull();
    expect(listCalls).toBe(0);
  });

  it("помечает вкладку родителя, когда workflow выполняется во вложенном чате", async () => {
    const state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_parent",
          projectId: "proj_api",
          title: "Родительский чат",
          pinned: true,
          openedAt: 1,
        },
      ],
    };
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("Не зарегистрирован app overlay");

    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_parent" },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_parent", "proj_api", "Родительский чат"),
          sidebarThread("thr_workflow", "proj_api", "Вложенный workflow", {
            parentThreadId: "thr_parent",
            activity: {
              workflows: 1,
              backgroundAgents: 0,
              backgroundCommands: 0,
              planMode: 0,
              goals: 0,
            },
            indicator: "workflow",
            updatedAt: 8,
          }),
        ],
        projects: [{ id: "proj_api", name: "API", isPersonal: false }],
      },
      rpc: {
        tabs_list: () => ({ state }),
        tabs_sync_activity: () => ({ state }),
        tabs_open: () => ({ state }),
        tabs_set_pinned: () => ({ state }),
        tabs_close: () => ({ state, removed: false }),
      },
    });

    const parentTab = await slot.findByRole("button", {
      name: "Родительский чат, выполняется вложенная работа",
    });
    expect(parentTab.querySelector(".bb-chat-tab-working")).not.toBeNull();
    expect(parentTab.closest(".bb-chat-tab")?.getAttribute("data-nested-work")).toBe(
      "true",
    );
    expect(parentTab.getAttribute("title")).toContain(
      "Выполняется вложенная работа.",
    );
  });

  it("показывает durable workflow origin-чата, даже когда sidebar ещё не сообщил activity", async () => {
    const state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_system_all",
          projectId: "proj_system",
          title: "SystemAll 1",
          pinned: true,
          openedAt: 1,
        },
      ],
    };
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("Не зарегистрирован app overlay");

    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_system", threadId: "thr_system_all" },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_system_all", "proj_system", "SystemAll 1", {
            // Именно такой нулевой sidebar snapshot раньше скрывал workflow.
            activity: {
              workflows: 0,
              backgroundAgents: 0,
              backgroundCommands: 0,
              planMode: 0,
              goals: 0,
            },
            indicator: "none",
          }),
        ],
        projects: [{ id: "proj_system", name: "System", isPersonal: false }],
      },
      rpc: {
        tabs_list: () => ({
          state,
          activeWorkflowThreadIds: ["thr_system_all"],
        }),
        tabs_sync_activity: () => ({ state }),
        tabs_open: () => ({ state }),
        tabs_set_pinned: () => ({ state }),
        tabs_close: () => ({ state, removed: false }),
      },
    });

    const systemTab = await slot.findByRole("button", {
      name: "SystemAll 1, работа выполняется",
    });
    expect(systemTab.querySelector(".bb-chat-tab-working")).not.toBeNull();
  });

  it("сворачивает durable workflow дочернего origin-чата к вкладке родителя", async () => {
    const state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_parent",
          projectId: "proj_api",
          title: "Родительский чат",
          pinned: true,
          openedAt: 1,
        },
      ],
    };
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("Не зарегистрирован app overlay");

    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_parent" },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_parent", "proj_api", "Родительский чат"),
          sidebarThread("thr_child", "proj_api", "Workflow worker", {
            parentThreadId: "thr_parent",
          }),
        ],
        projects: [{ id: "proj_api", name: "API", isPersonal: false }],
      },
      rpc: {
        tabs_list: (input) => ({
          state,
          activeWorkflowThreadIds:
            input !== null && input.workflowThreadIds.includes("thr_child")
              ? ["thr_child"]
              : [],
        }),
        tabs_sync_activity: () => ({ state }),
        tabs_open: () => ({ state }),
        tabs_set_pinned: () => ({ state }),
        tabs_close: () => ({ state, removed: false }),
      },
    });

    const parentTab = await slot.findByRole("button", {
      name: "Родительский чат, выполняется вложенная работа",
    });
    expect(parentTab.querySelector(".bb-chat-tab-working")).not.toBeNull();
  });

  it("использует родительский чат как preview-кандидат вложенного workflow", async () => {
    let received: readonly { threadId: string; projectId: string; title: string }[] = [];
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("Не зарегистрирован app overlay");

    renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: null },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_parent", "proj_api", "Родительский чат", {
            updatedAt: 1,
          }),
          sidebarThread("thr_workflow", "proj_api", "Вложенный workflow", {
            parentThreadId: "thr_parent",
            activity: {
              workflows: 1,
              backgroundAgents: 0,
              backgroundCommands: 0,
              planMode: 0,
              goals: 0,
            },
            indicator: "workflow",
            updatedAt: 9,
          }),
        ],
        projects: [{ id: "proj_api", name: "API", isPersonal: false }],
      },
      rpc: {
        tabs_list: () => ({ state: { version: 1, entries: [] } }),
        tabs_sync_activity: ({ threads }) => {
          received = threads;
          return { state: { version: 1, entries: [] } };
        },
        tabs_open: () => ({ state: { version: 1, entries: [] } }),
        tabs_set_pinned: () => ({ state: { version: 1, entries: [] } }),
        tabs_close: () => ({ state: { version: 1, entries: [] }, removed: false }),
      },
    });

    await waitFor(() => {
      expect(received).toEqual([
        {
          threadId: "thr_parent",
          projectId: "proj_api",
          title: "Родительский чат",
        },
      ]);
    });
  });

  it("отправляет в preview текущий чат и не принимает только непрочитанный итог за активную работу", async () => {
    let received: readonly { threadId: string; projectId: string; title: string }[] = [];
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("Не зарегистрирован app overlay");

    renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_active" },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_active", "proj_api", "Активная сборка", {
            activity: {
              workflows: 0,
              backgroundAgents: 1,
              backgroundCommands: 0,
              planMode: 0,
              goals: 0,
            },
            indicator: "background-agent",
            updatedAt: 2,
          }),
          sidebarThread("thr_done", "proj_api", "Непрочитанный итог", {
            isUnread: true,
            indicator: "unread-success",
            updatedAt: 3,
          }),
        ],
        projects: [{ id: "proj_api", name: "API", isPersonal: false }],
      },
      rpc: {
        tabs_list: () => ({ state: { version: 1, entries: [] } }),
        tabs_sync_activity: ({ threads }) => {
          received = threads;
          return {
            state: {
              version: 1,
              entries: threads.map((thread, index) => ({
                ...thread,
                pinned: false,
                openedAt: index,
              })),
            },
          };
        },
        tabs_open: () => ({ state: { version: 1, entries: [] } }),
        tabs_set_pinned: () => ({ state: { version: 1, entries: [] } }),
        tabs_close: () => ({ state: { version: 1, entries: [] }, removed: false }),
      },
    });

    await waitFor(() => {
      expect(received).toEqual([
        {
          threadId: "thr_active",
          projectId: "proj_api",
          title: "Активная сборка",
        },
      ]);
    });
  });

  it("Ctrl+Tab циклически открывает следующую, а Ctrl+Shift+Tab — предыдущую plugin-вкладку", async () => {
    const state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_current",
          projectId: "proj_api",
          title: "Текущий",
          pinned: true,
          openedAt: 1,
        },
        {
          threadId: "thr_next",
          projectId: "proj_web",
          title: "Следующий",
          pinned: true,
          openedAt: 2,
        },
        {
          threadId: "thr_last",
          projectId: "proj_docs",
          title: "Последний",
          pinned: true,
          openedAt: 3,
        },
      ],
    };
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("Не зарегистрирован app overlay");

    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_current" },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_current", "proj_api", "Текущий"),
          sidebarThread("thr_next", "proj_web", "Следующий"),
          sidebarThread("thr_last", "proj_docs", "Последний"),
        ],
        projects: [
          { id: "proj_api", name: "API", isPersonal: false },
          { id: "proj_web", name: "Web", isPersonal: false },
          { id: "proj_docs", name: "Docs", isPersonal: false },
        ],
      },
      rpc: {
        tabs_list: () => ({ state }),
        tabs_sync_activity: () => ({ state }),
        tabs_open: () => ({ state }),
        tabs_set_pinned: () => ({ state }),
        tabs_close: () => ({ state, removed: false }),
      },
    });

    await slot.findByRole("button", { name: "Текущий" });
    const next = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: "Tab",
    });
    window.dispatchEvent(next);
    expect(next.defaultPrevented).toBe(true);

    const previous = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      shiftKey: true,
      key: "Tab",
    });
    window.dispatchEvent(previous);
    expect(previous.defaultPrevented).toBe(true);

    // Контекст в harness не меняется после open, поэтому Ctrl+Shift+Tab
    // проверяет wrap-around от исходной первой вкладки к последней.
    expect(slot.inspection.sidebarActionCalls).toEqual([
      { method: "open", threadId: "thr_next", options: undefined },
      { method: "open", threadId: "thr_last", options: undefined },
    ]);

    const focusTraversal = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      shiftKey: true,
      key: "Tab",
    });
    window.dispatchEvent(focusTraversal);
    expect(focusTraversal.defaultPrevented).toBe(false);
    expect(slot.inspection.sidebarActionCalls).toHaveLength(2);
  });

  it("не перехватывает Ctrl+Tab при единственной plugin-вкладке", async () => {
    const state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_current",
          projectId: "proj_api",
          title: "Текущий",
          pinned: true,
          openedAt: 1,
        },
      ],
    };
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("Не зарегистрирован app overlay");
    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_current" },
      sidebarThreads: {
        threads: [sidebarThread("thr_current", "proj_api", "Текущий")],
        projects: [{ id: "proj_api", name: "API", isPersonal: false }],
      },
      rpc: {
        tabs_list: () => ({ state }),
        tabs_sync_activity: () => ({ state }),
        tabs_open: () => ({ state }),
        tabs_set_pinned: () => ({ state }),
        tabs_close: () => ({ state, removed: false }),
      },
    });

    await slot.findByRole("button", { name: "Текущий" });
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: "Tab",
    });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(slot.inspection.sidebarActionCalls).toEqual([]);
  });

  it("Ctrl+W закрывает только текущую plugin-вкладку и открывает соседнюю", async () => {
    let state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_current",
          projectId: "proj_api",
          title: "Текущий",
          pinned: true,
          openedAt: 1,
        },
        {
          threadId: "thr_next",
          projectId: "proj_api",
          title: "Следующий",
          pinned: true,
          openedAt: 2,
        },
      ],
    };
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("Не зарегистрирован app overlay");

    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_current" },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_current", "proj_api", "Текущий"),
          sidebarThread("thr_next", "proj_api", "Следующий"),
        ],
        projects: [{ id: "proj_api", name: "API", isPersonal: false }],
      },
      rpc: {
        tabs_list: () => ({ state }),
        tabs_sync_activity: () => ({ state }),
        tabs_open: () => ({ state }),
        tabs_set_pinned: () => ({ state }),
        tabs_close: ({ threadId }) => {
          const entries = state.entries.filter((entry) => entry.threadId !== threadId);
          const removed = entries.length !== state.entries.length;
          state = { ...state, entries };
          return { state, removed };
        },
      },
    });

    await slot.findByRole("button", { name: "Текущий" });
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: "w",
    });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => {
      expect(state.entries.map((entry) => entry.threadId)).toEqual(["thr_next"]);
    });
    expect(slot.inspection.sidebarActionCalls).toEqual([
      { method: "open", threadId: "thr_next", options: undefined },
    ]);
  });

  it("отвечает на Desktop close request до нативного закрытия окна", async () => {
    const desktop = installDesktopCloseRequestBridge();
    let state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_current",
          projectId: "proj_api",
          title: "Текущий",
          pinned: true,
          openedAt: 1,
        },
        {
          threadId: "thr_next",
          projectId: "proj_api",
          title: "Следующий",
          pinned: true,
          openedAt: 2,
        },
      ],
    };
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("Не зарегистрирован app overlay");

    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_current" },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_current", "proj_api", "Текущий"),
          sidebarThread("thr_next", "proj_api", "Следующий"),
        ],
        projects: [{ id: "proj_api", name: "API", isPersonal: false }],
      },
      rpc: {
        tabs_list: () => ({ state }),
        tabs_sync_activity: () => ({ state }),
        tabs_open: () => ({ state }),
        tabs_set_pinned: () => ({ state }),
        tabs_close: ({ threadId }) => {
          const entries = state.entries.filter((entry) => entry.threadId !== threadId);
          const removed = entries.length !== state.entries.length;
          state = { ...state, entries };
          return { state, removed };
        },
      },
    });

    await slot.findByRole("button", { name: "Текущий" });
    expect(desktop.listenerCount()).toBe(1);
    // `true` — синхронный ответ preload, отменяющий BrowserWindow.close().
    expect(desktop.dispatch()).toBe(true);
    await waitFor(() => {
      expect(state.entries.map((entry) => entry.threadId)).toEqual(["thr_next"]);
    });
    expect(slot.inspection.sidebarActionCalls).toEqual([
      { method: "open", threadId: "thr_next", options: undefined },
    ]);
  });

  it("уступает Ctrl+W встроенному браузеру, пока тот в фокусе", async () => {
    const desktop = installDesktopCloseRequestBridge();
    const state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_current",
          projectId: "proj_api",
          title: "Текущий",
          pinned: true,
          openedAt: 1,
        },
        {
          threadId: "thr_next",
          projectId: "proj_api",
          title: "Следующий",
          pinned: true,
          openedAt: 2,
        },
      ],
    };
    let closeCalls = 0;
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("Не зарегистрирован app overlay");

    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_current" },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_current", "proj_api", "Текущий"),
          sidebarThread("thr_next", "proj_api", "Следующий"),
        ],
        projects: [{ id: "proj_api", name: "API", isPersonal: false }],
      },
      rpc: {
        tabs_list: () => ({ state }),
        tabs_sync_activity: () => ({ state }),
        tabs_open: () => ({ state }),
        tabs_set_pinned: () => ({ state }),
        tabs_close: () => {
          closeCalls += 1;
          return { state, removed: false };
        },
      },
    });

    await slot.findByRole("button", { name: "Текущий" });
    expect(desktop.browserFocusListenerCount()).toBe(1);
    desktop.dispatchBrowserViewFocus("browser-current");

    // Если Desktop всё же доставит fallback keydown в host renderer, плагин
    // также не отменит его и не закроет chat tab.
    const nativeBrowserKeydown = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: "w",
    });
    window.dispatchEvent(nativeBrowserKeydown);
    expect(nativeBrowserKeydown.defaultPrevented).toBe(false);
    expect(closeCalls).toBe(0);

    // `false` передаёт accelerator штатному BB handler, который закрывает
    // active browser tab. В harness его нет, поэтому проверяем handoff.
    expect(desktop.dispatch()).toBe(false);
    expect(closeCalls).toBe(0);

    // После реального перехода фокуса обратно в renderer plugin tab снова
    // может обработать shortcut.
    const chatControl = document.createElement("button");
    document.body.append(chatControl);
    fireEvent.focusIn(chatControl);
    expect(desktop.dispatch()).toBe(true);
    await waitFor(() => expect(closeCalls).toBe(1));
    chatControl.remove();

    // Chrome встроенного браузера живёт в renderer, однако Desktop menu
    // accelerator приходит раньше DOM keydown. Pointer/focus marker оставляет
    // и этот close request штатному panel.close handler BB.
    const browserChrome = document.createElement("div");
    browserChrome.dataset.appBrowser = "";
    document.body.append(browserChrome);
    fireEvent.pointerDown(browserChrome);
    expect(desktop.dispatch()).toBe(false);
    expect(closeCalls).toBe(1);

    // DOM fallback сохраняет тот же handoff в non-native окружении.
    const browserChromeKeydown = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: "w",
    });
    browserChrome.dispatchEvent(browserChromeKeydown);
    browserChrome.remove();
    expect(browserChromeKeydown.defaultPrevented).toBe(false);
    expect(closeCalls).toBe(1);
  });

  it("не перехватывает Ctrl+W, если текущий чат не является plugin-вкладкой", async () => {
    const desktop = installDesktopCloseRequestBridge();
    const state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_other",
          projectId: "proj_api",
          title: "Другой",
          pinned: true,
          openedAt: 1,
        },
      ],
    };
    let closeCalls = 0;
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("Не зарегистрирован app overlay");

    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_current" },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_current", "proj_api", "Текущий"),
          sidebarThread("thr_other", "proj_api", "Другой"),
        ],
        projects: [{ id: "proj_api", name: "API", isPersonal: false }],
      },
      rpc: {
        tabs_list: () => ({ state }),
        tabs_sync_activity: () => ({ state }),
        tabs_open: () => ({ state }),
        tabs_set_pinned: () => ({ state }),
        tabs_close: () => {
          closeCalls += 1;
          return { state, removed: false };
        },
      },
    });

    await slot.findByRole("button", { name: "Другой" });
    expect(desktop.dispatch()).toBe(false);
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: "w",
    });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(closeCalls).toBe(0);
    expect(desktop.listenerCount()).toBe(1);
  });
});
