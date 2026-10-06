// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot, type RenderSlotOptions } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { addTabCandidates, movePinnedTab, setTabPinned, type TabsState } from "./lib/tabs-model";
import { visitTabHistory, type TabHistoryState } from "./lib/tab-history";
import { recentProjects } from "./lib/recent-projects";

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

describe("Chat Tabs", () => {
  it("shows descendant attention counts and opens a nested child as an explicit preview", async () => {
    let state: TabsState = { version: 1, entries: [
      { threadId: "thr_root", projectId: "proj_api", title: "Root", pinned: true, openedAt: 1 },
    ] };
    const overlay = app.appOverlays[0];
    if (!overlay) throw new Error("App overlay is not registered");
    const sync = vi.fn((input: { threads: { threadId: string; projectId: string; title: string }[]; reopen?: boolean }) => {
      state = addTabCandidates(state, input.threads, Date.now());
      return { state };
    });
    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_root" },
      sidebarThreads: { threads: [
        sidebarThread("thr_root", "proj_api", "Root"),
        { ...sidebarThread("thr_child", "proj_api", "Parent child"), parentThreadId: "thr_root" },
        { ...sidebarThread("thr_grandchild", "proj_api", "Grandchild"), parentThreadId: "thr_child", indicator: "runtime", isUnread: true },
        { ...sidebarThread("thr_waiting", "proj_api", "Waiting child"), parentThreadId: "thr_root", hasPendingInteraction: true },
        { ...sidebarThread("thr_calm", "proj_api", "Calm child"), parentThreadId: "thr_root" },
      ], projects: [{ id: "proj_api", name: "API", isPersonal: false }] },
      rpc: { tabs_list: () => ({ state }), tabs_sync_activity: sync },
    });
    const badge = await slot.findByRole("button", { name: "Subthreads of “Root”: 2 active or unread" });
    expect(state.entries).toHaveLength(1); // Background children never open tabs.
    fireEvent.pointerDown(badge, { button: 0, ctrlKey: false });
    expect(await slot.findByRole("menuitem", { name: "Calm child" })).toBeTruthy();
    const parent = slot.getByRole("menuitem", { name: /Parent child/ });
    fireEvent.keyDown(parent, { key: "ArrowRight" });
    fireEvent.click(await slot.findByRole("menuitem", { name: /Grandchild/ }));
    await waitFor(() => expect(sync).toHaveBeenCalledWith({
      threads: [{ threadId: "thr_grandchild", projectId: "proj_api", title: "Grandchild" }], reopen: true,
    }));
    await waitFor(() => expect(slot.inspection.sidebarActionCalls).toContainEqual({ method: "open", threadId: "thr_grandchild", options: undefined }));
    expect(state.entries.map((entry) => entry.threadId)).toEqual(["thr_root", "thr_grandchild"]);
    expect(state.entries[1]?.pinned).toBe(false);
    expect(await slot.findByRole("button", { name: /Grandchild, work is running, unread messages/ })).toBeTruthy();
  });

  it.each(["button", "middle-click", "keyboard"])("returns to New chat when the last active tab is closed via %s", async (method) => {
    let state: TabsState = { version: 1, entries: [
      { threadId: "thr_last", projectId: "proj_api", title: "Last chat", pinned: true, openedAt: 1 },
    ] };
    const overlay = app.appOverlays[0];
    if (!overlay) throw new Error("App overlay is not registered");
    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_last" },
      sidebarThreads: { threads: [sidebarThread("thr_last", "proj_api", "Last chat")],
        projects: [{ id: "proj_api", name: "API", isPersonal: false }] },
      rpc: {
        tabs_list: () => ({ state }),
        tabs_sync_activity: () => ({ state }),
        tabs_close: () => {
          state = { version: 1, entries: [] };
          return { state, removed: true };
        },
      },
    });
    const tab = await slot.findByRole("button", { name: "Last chat" });
    if (method === "button") fireEvent.click(slot.getByRole("button", { name: "Close tab “Last chat”" }));
    else if (method === "middle-click") fireEvent(tab, new MouseEvent("auxclick", { button: 1, bubbles: true }));
    else fireEvent.keyDown(window, { key: "w", ctrlKey: true });
    await waitFor(() => expect(slot.inspection.sidebarActionCalls).toEqual([
      { method: "openNewThread", options: { focusPrompt: true } },
    ]));
    expect(state.entries).toEqual([]);
    expect(slot.queryByRole("button", { name: "Last chat" })).toBeNull();
  });

  it("filters local chats by project and preserves remote project matches outside the sidebar", async () => {
    const state: TabsState = { version: 1, entries: [
      { threadId: "thr_current", projectId: "proj_api", title: "Current", pinned: true, openedAt: 1 },
      { threadId: "thr_other", projectId: "proj_api", title: "Other", pinned: true, openedAt: 2 },
    ] };
    const overlay = app.appOverlays[0];
    if (!overlay) throw new Error("App overlay is not registered");
    const query = vi.fn(() => ({ candidates: [{ threadId: "thr_remote", projectId: "proj_remote", title: "Repair build", projectName: "Office CRM" }] }));
    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_current" },
      sidebarThreads: { threads: [sidebarThread("thr_current", "proj_api", "Current"), sidebarThread("thr_other", "proj_api", "Other")],
        projects: [{ id: "proj_api", name: "API", isPersonal: false }] },
      rpc: { tabs_list: () => ({ state }), tabs_search: query },
    });
    fireEvent.pointerDown(await slot.findByRole("button", { name: "Open chat list" }), { button: 0 });
    const search = await slot.findByRole("searchbox", { name: "Search chats by title or project" });
    fireEvent.change(search, { target: { value: "API" } });
    expect(await slot.findByRole("menuitem", { name: /Current.*API/ })).toBeTruthy();
    expect(slot.getByRole("menuitem", { name: /Other.*API/ })).toBeTruthy();
    fireEvent.change(search, { target: { value: "Office" } });
    const remote = await slot.findByRole("menuitem", { name: /Repair build.*Office CRM/ });
    expect(remote.getAttribute("data-thread-id")).toBe("thr_remote");
    expect(slot.queryByRole("menuitem", { name: /Current.*API/ })).toBeNull();
    fireEvent.change(search, { target: { value: "office build" } });
    expect(await slot.findByRole("menuitem", { name: /Repair build.*Office CRM/ })).toBeTruthy();
    await waitFor(() => expect(query).toHaveBeenCalledWith({ query: "office build", includeArchived: false }));
  });

  it.each([false, true])("includes archived search results only when the checkbox is %s", async (enabled) => {
    const state: TabsState = { version: 1, entries: [
      { threadId: "thr_current", projectId: "proj_api", title: "Current", pinned: true, openedAt: 1 },
      { threadId: "thr_other", projectId: "proj_api", title: "Other", pinned: true, openedAt: 2 },
    ] };
    const overlay = app.appOverlays[0];
    if (!overlay) throw new Error("App overlay is not registered");
    const query = vi.fn(() => ({ candidates: [{ threadId: "thr_archived_search", projectId: "proj_api", title: "Old archived task", archived: true }] }));
    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      settings: { searchArchivedChats: enabled },
      context: { projectId: "proj_api", threadId: "thr_current" },
      sidebarThreads: { threads: [sidebarThread("thr_current", "proj_api", "Current"), sidebarThread("thr_other", "proj_api", "Other")],
        projects: [{ id: "proj_api", name: "API", isPersonal: false }] },
      rpc: { tabs_list: () => ({ state }), tabs_search: query },
    });
    fireEvent.pointerDown(await slot.findByRole("button", { name: "Open chat list" }), { button: 0 });
    fireEvent.change(await slot.findByRole("searchbox", { name: "Search chats by title or project" }), { target: { value: "Old archived task" } });
    await waitFor(() => expect(query).toHaveBeenCalledWith({ query: "Old archived task", includeArchived: enabled }));
    if (enabled) {
      const item = await slot.findByRole("menuitem", { name: /Old archived task.*Archived/ });
      expect(item.hasAttribute("data-disabled")).toBe(true);
      expect(item.getAttribute("data-selected")).not.toBe("true");
      expect(item.querySelector("svg")).toBeNull();
      expect(item.querySelector('.bb-chat-tabs-list-menu-title[data-unavailable="archived"]')).not.toBeNull();
    } else {
      expect(await slot.findByText("No matching chats")).toBeTruthy();
      expect(slot.queryByRole("menuitem", { name: /Old archived task/ })).toBeNull();
    }
  });

  it("finds an older chat outside pins, history, and sidebar by its title and version fragment", async () => {
    const title = "Обновить систему до версии 0.43.3 — office";
    const state: TabsState = { version: 1, entries: [
      { threadId: "thr_current", projectId: "proj_api", title: "Current", pinned: true, openedAt: 1 },
      { threadId: "thr_other", projectId: "proj_api", title: "Other", pinned: true, openedAt: 2 },
    ] };
    const overlay = app.appOverlays[0];
    if (!overlay) throw new Error("App overlay is not registered");
    const query = vi.fn(() => ({ candidates: [{ threadId: "thr_office", projectId: "proj_office", title }] }));
    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_current" },
      sidebarThreads: { threads: [sidebarThread("thr_current", "proj_api", "Current"), sidebarThread("thr_other", "proj_api", "Other")],
        projects: [{ id: "proj_api", name: "API", isPersonal: false }, { id: "proj_office", name: "Office", isPersonal: false }] },
      rpc: { tabs_list: () => ({ state }), tabs_search: query },
    });
    fireEvent.pointerDown(await slot.findByRole("button", { name: "Open chat list" }), { button: 0 });
    const search = await slot.findByRole("searchbox", { name: "Search chats by title or project" });
    fireEvent.change(search, { target: { value: "43" } });
    const match = await slot.findByRole("menuitem", { name: new RegExp(title.replace(/\./g, "\\.")) });
    expect(match.getAttribute("data-thread-id")).toBe("thr_office");
    expect(query).toHaveBeenCalledWith({ query: "43", includeArchived: false });
    fireEvent.change(search, { target: { value: title } });
    await waitFor(() => expect(query).toHaveBeenCalledWith({ query: title, includeArchived: false }));
    fireEvent.keyDown(search, { key: "Enter" });
    expect(slot.inspection.sidebarActionCalls).toContainEqual({ method: "open", threadId: "thr_office" });
  });

  it("marks a pending question or approval in the strip and list instead of showing endless work", async () => {
    const state: TabsState = { version: 1, entries: [
      { threadId: "thr_parent", projectId: "proj_api", title: "Parent", pinned: true, openedAt: 1 },
      { threadId: "thr_other", projectId: "proj_api", title: "Other", pinned: true, openedAt: 2 },
    ] };
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("App overlay is not registered");
    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      settings: { language: "Русский" },
      context: { projectId: "proj_api", threadId: "thr_parent" },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_parent", "proj_api", "Parent"),
          sidebarThread("thr_child", "proj_api", "Child", {
            parentThreadId: "thr_parent", hasPendingInteraction: true, indicator: "waiting-for-input",
            activity: { workflows: 1, backgroundAgents: 0, backgroundCommands: 0, goals: 0, planMode: 0 },
          }),
          sidebarThread("thr_other", "proj_api", "Other"),
        ],
        projects: [{ id: "proj_api", name: "API", isPersonal: false }],
      },
      rpc: { tabs_list: () => ({ state }) },
    });
    const tab = await slot.findByRole("button", { name: /Parent, В дочернем чате требуется ваш ответ/ });
    expect(tab.closest(".bb-chat-tab")?.getAttribute("data-waiting")).toBe("true");
    expect(tab.querySelector(".bb-chat-tab-waiting")?.textContent).toBe("?");
    expect(tab.querySelector(".bb-chat-tab-waiting")?.getAttribute("title")).toBe("В дочернем чате требуется ваш ответ или подтверждение.");
    expect(tab.querySelector(".bb-chat-tab-working")).toBeNull();
    fireEvent.pointerDown(slot.getByRole("button", { name: "Открыть список чатов" }), { button: 0 });
    await waitFor(() => expect(document.querySelector('.bb-chat-tabs-list-menu-status[data-status="waiting"]')).not.toBeNull());
  });

  it("renders Russian tab actions and navigation when language is overridden", async () => {
    const state: TabsState = { version: 1, entries: [
      { threadId: "thr_current", projectId: "proj_api", title: "Первый чат", pinned: true, openedAt: 1 },
      { threadId: "thr_other", projectId: "proj_api", title: "Второй чат", pinned: true, openedAt: 2 },
    ] };
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("App overlay is not registered");
    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      settings: { language: "Русский" },
      context: { projectId: "proj_api", threadId: "thr_current" },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_current", "proj_api", "Первый чат"),
          sidebarThread("thr_other", "proj_api", "Второй чат"),
        ],
        projects: [{ id: "proj_api", name: "API", isPersonal: false }],
      },
      rpc: { tabs_list: () => ({ state }) },
    });
    const tab = await slot.findByRole("button", { name: "Первый чат" });
    expect(tab.closest("aside")?.getAttribute("lang")).toBe("ru");
    expect(slot.getByRole("button", { name: "Закрыть вкладку «Первый чат»" })).toBeTruthy();
    expect(slot.getByRole("button", { name: "Новый чат" })).toBeTruthy();
    fireEvent.contextMenu(tab);
    expect(await slot.findByRole("menuitem", { name: "Копировать ссылку" })).toBeTruthy();
    expect(slot.getByRole("menuitem", { name: "Открепить" })).toBeTruthy();
  });

  it("handles behavior 1", () => {
    expect(app.threadHeaderActions).toHaveLength(0);
  });

  it("handles behavior 2", async () => {
    const state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_current",
          projectId: "proj_api",
          title: "Current chat",
          pinned: true,
          openedAt: 1,
        },
      ],
    };
    let listCalls = 0;
    let syncCalls = 0;
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("App overlay is not registered");

    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_current" },
      sidebarThreads: {
        threads: [sidebarThread("thr_current", "proj_api", "Current chat")],
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

    await slot.findByRole("button", { name: "Current chat" });
    await waitFor(() => expect(listCalls).toBe(1));
    expect(syncCalls).toBe(0);
    fireEvent.click(slot.getByRole("button", { name: "New chat" }));
    expect(slot.sidebarActionCalls).toContainEqual({
      method: "openNewThread",
      options: { focusPrompt: true },
    });
  });

  it("handles behavior 3", async () => {
    const state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_idle",
          projectId: "proj_api",
          title: "Quiet chat",
          pinned: true,
          openedAt: 1,
        },
      ],
    };
    const previousHidden = document.hidden;
    let listCalls = 0;
    let syncCalls = 0;
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("App overlay is not registered");

    vi.useFakeTimers();
    try {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: false,
      });
      renderSlot<{}, typeof rpcContract>(overlay, {}, {
        context: { projectId: "proj_api", threadId: "thr_idle" },
        sidebarThreads: {
          threads: [sidebarThread("thr_idle", "proj_api", "Quiet chat")],
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

  it("handles behavior 4", async () => {
    let moveCalls = 0;
    let state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_build",
          projectId: "proj_api",
          title: "Build",
          pinned: false,
          openedAt: 1,
        },
        {
          threadId: "thr_review",
          projectId: "proj_api",
          title: "Review",
          pinned: true,
          openedAt: 2,
        },
        {
          threadId: "thr_docs",
          projectId: "proj_api",
          title: "Documentation",
          pinned: true,
          openedAt: 3,
        },
        {
          threadId: "thr_design",
          projectId: "proj_web",
          title: "Design",
          pinned: true,
          openedAt: 4,
        },
      ],
    };
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("App overlay is not registered");

    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_build" },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_build", "proj_api", "Build"),
          sidebarThread("thr_review", "proj_api", "Review"),
          sidebarThread("thr_docs", "proj_api", "Documentation"),
          sidebarThread("thr_design", "proj_web", "Design"),
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
          moveCalls += 1;
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
      throw new Error("Chat tabs overlay was not found");
    }
    expect(overlayElement.getAttribute("data-scrollable")).toBe("false");

    expect(slot.queryByText("API")).toBeNull();
    expect(slot.queryByText("Web")).toBeNull();
    const buildTab = await slot.findByRole("button", { name: "Build" });
    expect(buildTab.getAttribute("title")).toContain("Project: API");
    expect(buildTab.getAttribute("title")).toContain("Chat: Build");
    expect(buildTab.getAttribute("title")).toContain(
      "Click to open the chat.",
    );
    expect(buildTab.getAttribute("aria-description")).toContain(
      "Click opens the chat.",
    );
    expect(
      buildTab.closest(".bb-chat-tab")?.getAttribute("data-preview"),
    ).toBe("true");
    expect(slot.container.querySelectorAll(".bb-chat-tab")).toHaveLength(4);
    expect(slot.queryByRole("button", { name: /Pin «/u })).toBeNull();

    const strip = slot.container.querySelector(".bb-chat-tabs-strip");
    if (!(strip instanceof HTMLDivElement)) {
      throw new Error("Chat tab strip was not found");
    }
    const topScrollbar = slot.container.querySelector(
      ".bb-chat-tabs-top-scrollbar",
    );
    if (!(topScrollbar instanceof HTMLDivElement)) {
      throw new Error("Top scrollbar was not found");
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

    topScrollbar.scrollLeft = 120;
    fireEvent.scroll(topScrollbar);
    expect(strip.scrollLeft).toBe(120);
    strip.scrollLeft = 84;
    fireEvent.scroll(strip);
    expect(topScrollbar.scrollLeft).toBe(84);

    const docsTab = slot.getByRole("button", { name: "Documentation" });
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
      throw new Error("Tab containers or drag-and-drop slot were not found");
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
      ).toEqual(["Review", "Design", "Documentation", "Build"]);
    });

    const designBeforeSlotForNoop = strip.querySelector(
      '[data-drop-target="thr_design"][data-drop-position="before"]',
    );
    if (!(designBeforeSlotForNoop instanceof HTMLDivElement)) {
      throw new Error("Design drop slot was not found");
    }
    fireEvent.dragStart(docsContainer, { dataTransfer });
    fireEvent.dragOver(designBeforeSlotForNoop, { clientX: 180, dataTransfer });
    await waitFor(() => {
      expect(designBeforeSlotForNoop.getAttribute("data-active")).toBe("true");
    });
    fireEvent.dragOver(docsContainer, { clientX: 0, dataTransfer });
    expect(strip.querySelector('.bb-chat-tab-drop-slot[data-active="true"]')).toBeNull();
    fireEvent.drop(strip, { clientX: 0, dataTransfer });
    expect(moveCalls).toBe(1);
    expect(state.entries.map((entry) => entry.threadId)).toEqual([
      "thr_build", "thr_review", "thr_design", "thr_docs",
    ]);

    const reviewContainer = slot.getByRole("button", { name: "Review" }).closest(".bb-chat-tab");
    const designContainer = slot.getByRole("button", { name: "Design" }).closest(".bb-chat-tab");
    if (!(reviewContainer instanceof HTMLDivElement) ||
        !(designContainer instanceof HTMLDivElement)) {
      throw new Error("Pinned tab containers were not found");
    }
    designContainer.getBoundingClientRect = () =>
      ({ left: 100, width: 100 } as DOMRect);
    fireEvent.dragStart(reviewContainer, { dataTransfer });
    fireEvent.dragOver(designContainer, { clientX: 175, dataTransfer });
    await waitFor(() => {
      expect(
        strip.querySelector('[data-drop-target="thr_docs"][data-drop-position="before"]')
          ?.getAttribute("data-active"),
      ).toBe("true");
    });
    fireEvent.drop(designContainer, { clientX: 175, dataTransfer });
    await waitFor(() => {
      expect(state.entries.map((entry) => entry.threadId)).toEqual([
        "thr_build", "thr_design", "thr_review", "thr_docs",
      ]);
    });

    docsContainer.getBoundingClientRect = () =>
      ({ left: 200, width: 100 } as DOMRect);
    fireEvent.dragStart(reviewContainer, { dataTransfer });
    fireEvent.dragOver(docsContainer, { clientX: 275, dataTransfer });
    await waitFor(() => {
      expect(
        strip.querySelector('[data-drop-target="thr_docs"][data-drop-position="after"]')
          ?.getAttribute("data-active"),
      ).toBe("true");
    });
    fireEvent.drop(docsContainer, { clientX: 275, dataTransfer });
    await waitFor(() => {
      expect(state.entries.map((entry) => entry.threadId)).toEqual([
        "thr_build", "thr_design", "thr_docs", "thr_review",
      ]);
    });

    const designBeforeSlot = strip.querySelector(
      '[data-drop-target="thr_design"][data-drop-position="before"]',
    );
    if (!(designBeforeSlot instanceof HTMLDivElement)) {
      throw new Error("Design drop slot was not found");
    }
    fireEvent.dragStart(reviewContainer, { dataTransfer });
    fireEvent.dragOver(designBeforeSlot, { clientX: 180, dataTransfer });
    await waitFor(() => {
      expect(designBeforeSlot.getAttribute("data-active")).toBe("true");
    });
    fireEvent.drop(strip, { clientX: 180, dataTransfer });
    await waitFor(() => {
      expect(state.entries.map((entry) => entry.threadId)).toEqual([
        "thr_build", "thr_review", "thr_design", "thr_docs",
      ]);
      expect(moveCalls).toBe(4);
    });

    strip.scrollLeft = 150;
    fireEvent.wheel(buildTab, { deltaX: 8, deltaY: -48 });
    expect(strip.scrollLeft).toBe(102);
    fireEvent.wheel(buildTab, { deltaX: -8, deltaY: 48 });
    expect(strip.scrollLeft).toBe(150);

    fireEvent.click(slot.getByRole("button", { name: "Review" }));
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

  it("handles behavior 5", async () => {
    const state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_api_current",
          projectId: "proj_api",
          title: "Current API",
          pinned: true,
          openedAt: 1,
        },
        {
          threadId: "thr_web",
          projectId: "proj_web",
          title: "Design",
          pinned: true,
          openedAt: 2,
        },
        {
          threadId: "thr_api_review",
          projectId: "proj_api",
          title: "API review",
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
        title: `Historical chat ${index}`,
        visitedAt: 100 - index,
      })),
    };
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("App overlay is not registered");

    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_api_current" },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_api_current", "proj_api", "Current API"),
          sidebarThread("thr_web", "proj_web", "Design", {
            activity: {
              workflows: 1,
              backgroundAgents: 0,
              backgroundCommands: 0,
              planMode: 0,
              goals: 0,
            },
            indicator: "workflow",
          }),
          sidebarThread("thr_api_review", "proj_api", "API review", {
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
      name: "Open chat list",
    });
    expect(trigger.querySelector('[data-icon="ListView"]')).not.toBeNull();
    expect(slot.queryByRole("combobox", { name: "Go to chat" })).toBeNull();
    expect(slot.container.querySelector("select")).toBeNull();

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    let menu: HTMLElement | null = null;
    await waitFor(() => {
      menu = document.body.querySelector(".bb-chat-tabs-list-menu");
      expect(menu).not.toBeNull();
    });
    if (menu === null) throw new Error("Tab list submenu did not open");

    const groups = [
      ...menu.querySelectorAll<HTMLElement>(".bb-chat-tabs-list-menu-group"),
    ];
    expect(
      groups.map(
        (group) =>
          group.querySelector(".bb-chat-tabs-list-menu-group-label")?.textContent,
      ),
    ).toEqual(["Pinned", "History"]);
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
    expect(workingMenuItem?.textContent).toContain("Working");
    expect(
      unreadMenuItem
        ?.querySelector(".bb-chat-tabs-list-menu-status")
        ?.getAttribute("data-status"),
    ).toBe("unread");
    expect(unreadMenuItem?.textContent).toContain("Unread");
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
    if (historyGroup === undefined) throw new Error("History section was not found");
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
    expect(historyPageSeparators()).toHaveLength(0);

    let more = menu.querySelector<HTMLElement>(".bb-chat-tabs-list-menu-more");
    if (more === null) throw new Error("More item was not found");
    vi.useFakeTimers();
    try {
      fireEvent.pointerEnter(more, { pointerType: "mouse" });
      expect(more.getAttribute("data-pending")).toBe("true");
      fireEvent.pointerLeave(more, { pointerType: "mouse", relatedTarget: historyGroup });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_100);
      });
      expect(historyGroup.querySelectorAll("[data-thread-id]")).toHaveLength(8);

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
        "Next history page",
      );
      expect(
        firstPageSeparator?.previousElementSibling?.getAttribute(
          "data-thread-id",
        ),
      ).toBe("thr_history_7");
      expect(
        firstPageSeparator?.nextElementSibling?.getAttribute("data-thread-id"),
      ).toBe("thr_history_8");

      more = menu.querySelector<HTMLElement>(".bb-chat-tabs-list-menu-more");
      if (more === null) throw new Error("Repeated More item was not found");
      fireEvent.pointerEnter(more, { pointerType: "mouse" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(299);
      });
      expect(historyGroup.querySelectorAll("[data-thread-id]")).toHaveLength(16);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
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

      more = menu.querySelector<HTMLElement>(".bb-chat-tabs-list-menu-more");
      if (more === null) throw new Error("Repeated More item was not found");
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
    if (historicalItem === null) throw new Error("Historical item was not found");
    fireEvent.click(historicalItem);
    expect(slot.inspection.sidebarActionCalls).toEqual([
      { method: "open", threadId: "thr_history_25", options: undefined },
    ]);
  });

  it("handles behavior 6", async () => {
    const state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_current",
          projectId: "proj_api",
          title: "Current",
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
          title: "Old archived chat",
          visitedAt: 3,
          unavailableReason: "archived" as const,
        },
        {
          threadId: "thr_deleted",
          projectId: "proj_api",
          title: "Old deleted chat",
          visitedAt: 2,
          unavailableReason: "deleted" as const,
        },
      ],
    };
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("App overlay is not registered");

    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_current" },
      sidebarThreads: {
        threads: [sidebarThread("thr_current", "proj_api", "Current")],
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

    await slot.findByRole("button", { name: "Current" });
    expect(slot.container.querySelectorAll(".bb-chat-tab")).toHaveLength(1);

    const trigger = await slot.findByRole("button", {
      name: "Open chat list",
    });
    fireEvent.pointerDown(trigger, { button: 0 });
    const menu = await waitFor(() => {
      const next = document.body.querySelector<HTMLElement>(
        ".bb-chat-tabs-list-menu",
      );
      expect(next).not.toBeNull();
      return next;
    });
    if (menu === null) throw new Error("Tab list submenu did not open");

    const archivedItem = menu.querySelector<HTMLElement>(
      '[data-thread-id="thr_archived"]',
    );
    const deletedItem = menu.querySelector<HTMLElement>(
      '[data-thread-id="thr_deleted"]',
    );
    if (archivedItem === null || deletedItem === null) {
      throw new Error("Unavailable history entries were not found");
    }

    expect(archivedItem.dataset.unavailable).toBe("archived");
    expect(archivedItem.hasAttribute("data-disabled")).toBe(true);
    expect(archivedItem.getAttribute("aria-label")).toContain("Archived");
    expect(archivedItem.querySelector('svg')).toBeNull();
    expect(archivedItem.getAttribute("data-selected")).not.toBe("true");
    expect(
      archivedItem
        .querySelector(".bb-chat-tabs-list-menu-title")
        ?.getAttribute("data-unavailable"),
    ).toBe("archived");
    expect(archivedItem.textContent).toContain("Archived");

    expect(deletedItem.dataset.unavailable).toBe("deleted");
    expect(deletedItem.hasAttribute("data-disabled")).toBe(true);
    expect(deletedItem.getAttribute("aria-label")).toContain("Deleted");
    expect(deletedItem.querySelector('svg')).toBeNull();
    expect(deletedItem.getAttribute("data-selected")).not.toBe("true");
    expect(
      deletedItem
        .querySelector(".bb-chat-tabs-list-menu-title")
        ?.getAttribute("data-unavailable"),
    ).toBe("deleted");
    expect(deletedItem.textContent).toContain("Deleted");

    fireEvent.click(archivedItem);
    fireEvent.click(deletedItem);
    expect(slot.inspection.sidebarActionCalls).toEqual([]);
  });

  it("handles behavior 7", async () => {
    const state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_current",
          projectId: "proj_api",
          title: "Current",
          pinned: true,
          openedAt: 1,
        },
        {
          threadId: "thr_other",
          projectId: "proj_api",
          title: "Other",
          pinned: true,
          openedAt: 2,
        },
      ],
    };
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("App overlay is not registered");

    let desktopListCalls = 0;
    const desktop = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_current" },
      settings: { showTabsOnDesktop: false },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_current", "proj_api", "Current"),
          sidebarThread("thr_other", "proj_api", "Other"),
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
            sidebarThread("thr_current", "proj_api", "Current"),
            sidebarThread("thr_other", "proj_api", "Other"),
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

  it("handles behavior 8", async () => {
    const state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_current",
          projectId: "proj_api",
          title: "Current",
          pinned: true,
          openedAt: 1,
        },
        {
          threadId: "thr_pinned",
          projectId: "proj_api",
          title: "Pinned",
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
          title: "Pinned",
          visitedAt: 3,
        },
        {
          threadId: "thr_history_one",
          projectId: "proj_api",
          title: "First from history",
          visitedAt: 2,
        },
        {
          threadId: "thr_history_two",
          projectId: "proj_api",
          title: "Second from history",
          visitedAt: 1,
        },
      ],
    };
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("App overlay is not registered");
    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_current" },
      settings: {
        showTabListPinned: false,
        showTabListHistory: true,
        tabListButtonPosition: "Right",
      },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_current", "proj_api", "Current"),
          sidebarThread("thr_pinned", "proj_api", "Pinned"),
          sidebarThread("thr_history_one", "proj_api", "First from history"),
          sidebarThread("thr_history_two", "proj_api", "Second from history"),
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
      name: "Open chat list",
    });
    const contentRow = slot.container.querySelector(
      ".bb-chat-tabs-content-row",
    );
    expect(contentRow?.lastElementChild).toBe(
      slot.container.querySelector(
        '.bb-chat-tabs-list-switcher[data-position="right"]',
      ),
    );
    const strip = slot.container.querySelector(".bb-chat-tabs-strip");
    expect(strip?.querySelector(".bb-chat-tabs-new-switcher")).toBe(
      strip?.lastElementChild,
    );
    const openMenu = () => document.body.querySelector<HTMLElement>('.bb-chat-tabs-list-menu[data-state="open"]');
    const waitPastLeaveDelay = () => act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 180));
    });
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    await waitFor(() => expect(openMenu()).not.toBeNull(), { timeout: 900 });
    // Crossing from the icon into the list must not dismiss the hover preview.
    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
    fireEvent.pointerEnter(openMenu()!, { pointerType: "mouse" });
    await waitPastLeaveDelay();
    expect(openMenu()).not.toBeNull();
    fireEvent.pointerLeave(openMenu()!, { pointerType: "mouse" });
    await waitFor(() => expect(openMenu()).toBeNull());

    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    await waitFor(() => expect(openMenu()).not.toBeNull(), { timeout: 900 });
    // First click latches the hover preview and cancels a pending dismissal.
    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
    fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0 });
    fireEvent.pointerLeave(openMenu()!, { pointerType: "mouse" });
    await waitPastLeaveDelay();
    expect(openMenu()).not.toBeNull();
    fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0 });
    await waitFor(() => expect(openMenu()).toBeNull());

    // Click-open stays open after leaving; an outside click dismisses it.
    fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0 });
    await waitFor(() => expect(openMenu()).not.toBeNull());
    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
    await waitPastLeaveDelay();
    expect(openMenu()).not.toBeNull();
    fireEvent.pointerDown(document.body, { pointerType: "mouse", button: 0 });
    await waitFor(() => expect(openMenu()).toBeNull());

    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    expect(document.body.querySelector(".bb-chat-tabs-list-menu")).toBeNull();
    const menu = await waitFor(() => {
      const next = document.body.querySelector<HTMLElement>(
        ".bb-chat-tabs-list-menu",
      );
      expect(next).not.toBeNull();
      return next;
    }, { timeout: 900 });
    expect(
      [...menu.querySelectorAll(".bb-chat-tabs-list-menu-group-label")].map(
        (label) => label.textContent,
      ),
    ).toEqual(["History"]);
    expect(menu.textContent).toContain("Pinned");
    expect(menu.textContent).toContain("First from history");
    const search = menu.querySelector<HTMLInputElement>('input[aria-label="Search chats by title or project"]');
    if (search === null) throw new Error("Chat search input was not found");
    await waitFor(() => expect(document.activeElement).toBe(search));
    const historyItem = menu.querySelector<HTMLElement>('[data-thread-id="thr_history_one"]');
    if (historyItem === null) throw new Error("History item was not found");
    fireEvent.pointerMove(historyItem, { pointerType: "mouse", clientX: 50 });
    expect(document.activeElement).toBe(search);
    fireEvent.pointerLeave(historyItem, { pointerType: "mouse" });
    expect(document.activeElement).toBe(search);
    // Arrow navigation also works before entering a search query, without moving input focus.
    fireEvent.keyDown(search, { key: "ArrowUp" });
    expect(menu.querySelector('[data-selected="true"]')?.getAttribute("data-thread-id")).toBe("thr_history_two");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(menu.querySelector('[data-selected="true"]')?.getAttribute("data-thread-id")).toBe("thr_pinned");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(menu.querySelector('[data-selected="true"]')?.getAttribute("data-thread-id")).toBe("thr_history_one");
    fireEvent.keyDown(search, { key: "ArrowUp" });
    expect(menu.querySelector('[data-selected="true"]')?.getAttribute("data-thread-id")).toBe("thr_pinned");
    expect(document.activeElement).toBe(search);
    expect(search.getAttribute("aria-activedescendant")).toBe(menu.querySelector('[data-selected="true"]')?.id);
    fireEvent.change(search, { target: { value: "seond" } });
    const searchResult = menu.querySelector<HTMLElement>('[data-thread-id="thr_history_two"]');
    if (searchResult === null) throw new Error("Search result was not found");
    fireEvent.pointerMove(searchResult, { pointerType: "mouse", clientX: 60 });
    expect(document.activeElement).toBe(search);
    fireEvent.pointerLeave(searchResult, { pointerType: "mouse" });
    expect(document.activeElement).toBe(search);
    expect(menu.querySelectorAll(".bb-chat-tabs-list-menu-search-results [data-thread-id]")).toHaveLength(1);
    expect(menu.querySelector('[data-thread-id="thr_history_one"]')).toBeNull();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(menu.querySelector('[data-selected="true"]')).not.toBeNull();
    fireEvent.keyDown(search, { key: "Enter" });
    expect(slot.sidebarActionCalls).toContainEqual({ method: "open", threadId: "thr_history_two" });
    fireEvent.keyUp(window, { key: "Shift" });
    fireEvent.keyUp(window, { key: "Shift" });
    await waitFor(() => {
      expect(document.body.querySelector('.bb-chat-tabs-list-menu[data-state="open"]')).not.toBeNull();
    });
    const reopenedSearch = document.body.querySelector<HTMLInputElement>('input[aria-label="Search chats by title or project"]');
    if (reopenedSearch === null) throw new Error("Reopened search was not found");
    fireEvent.keyDown(reopenedSearch, { key: "Escape" });
    await waitFor(() => {
      expect(document.body.querySelector('.bb-chat-tabs-list-menu[data-state="open"]')).toBeNull();
    });
    const composer = document.createElement("textarea");
    slot.container.appendChild(composer);
    composer.focus();
    fireEvent.keyUp(composer, { key: "Shift" });
    fireEvent.keyUp(composer, { key: "Shift" });
    await waitFor(() => {
      expect(document.body.querySelector('.bb-chat-tabs-list-menu[data-state="open"]')).not.toBeNull();
      expect(document.activeElement).toBe(document.body.querySelector('input[aria-label="Search chats by title or project"]'));
    });
  });

  it("handles behavior 9", async () => {
    const state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_current",
          projectId: "proj_api",
          title: "Current",
          pinned: true,
          openedAt: 1,
        },
        {
          threadId: "thr_pinned",
          projectId: "proj_api",
          title: "Pinned",
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
          title: "First from history",
          visitedAt: 1,
        },
      ],
    };
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("App overlay is not registered");
    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_current" },
      settings: { showTabListHistory: false },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_current", "proj_api", "Current"),
          sidebarThread("thr_pinned", "proj_api", "Pinned"),
          sidebarThread("thr_history_one", "proj_api", "First from history"),
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
      name: "Open chat list",
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
    ).toEqual(["Pinned"]);
    expect(menu.textContent).not.toContain("History");
  });

  it("handles behavior 10", async () => {
    const state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_current",
          projectId: "proj_api",
          title: "Current",
          pinned: true,
          openedAt: 1,
        },
        {
          threadId: "thr_other",
          projectId: "proj_api",
          title: "Other",
          pinned: true,
          openedAt: 2,
        },
      ],
    };
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("App overlay is not registered");
    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_current" },
      settings: { showTabListButton: false },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_current", "proj_api", "Current"),
          sidebarThread("thr_other", "proj_api", "Other"),
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

    await slot.findByRole("button", { name: "Current" });
    expect(
      slot.queryByRole("button", { name: "Open chat list" }),
    ).toBeNull();
  });

  it("handles behavior 11", async () => {
    let state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_current",
          projectId: "proj_api",
          title: "Current",
          pinned: true,
          openedAt: 1,
        },
        {
          threadId: "thr_next",
          projectId: "proj_api",
          title: "Next",
          pinned: true,
          openedAt: 2,
        },
      ],
    };
    let closeCalls = 0;
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("App overlay is not registered");

    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_current" },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_current", "proj_api", "Current"),
          sidebarThread("thr_next", "proj_api", "Next"),
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

    const currentTab = await slot.findByRole("button", { name: "Current" });
    expect(currentTab.getAttribute("title")).toContain(
      "Middle-click to close this tab.",
    );
    expect(currentTab.getAttribute("aria-description")).toContain(
      "Middle-click closes this tab.",
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

  it("handles behavior 12", async () => {
    let state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_pinned",
          projectId: "proj_api",
          title: "Pinned chat",
          pinned: true,
          openedAt: 1,
        },
      ],
    };
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("App overlay is not registered");

    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_pinned" },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_pinned", "proj_api", "Pinned chat"),
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
      name: "Pinned chat",
    });
    expect(pinnedTab.getAttribute("title")).toContain(
      "Click to open the chat.",
    );
    expect(pinnedTab.getAttribute("title")).not.toContain("edits");
    const title = pinnedTab.querySelector(".bb-chat-tab-title");
    if (!(title instanceof HTMLSpanElement)) {
      throw new Error("Tab title was not found");
    }

    fireEvent.doubleClick(title);
    const inlineInput = await slot.findByRole("textbox", {
      name: "Rename tab “Pinned chat”",
    });
    fireEvent.change(inlineInput, { target: { value: "New inline name" } });
    fireEvent.keyDown(inlineInput, { key: "Enter" });
    await waitFor(() => {
      expect(slot.inspection.sidebarActionCalls).toContainEqual({
        method: "rename",
        threadId: "thr_pinned",
        title: "New inline name",
      });
    });
    expect(state.entries[0]?.pinned).toBe(true);
    pinnedTab = slot.getByRole("button", { name: "Pinned chat" });

    const titleAfterRename = pinnedTab.querySelector(".bb-chat-tab-title");
    if (!(titleAfterRename instanceof HTMLSpanElement)) {
      throw new Error("Tab title after inline rename was not found");
    }
    fireEvent.doubleClick(titleAfterRename);
    const cancelledInput = await slot.findByRole("textbox", {
      name: "Rename tab “Pinned chat”",
    });
    fireEvent.change(cancelledInput, { target: { value: "Do not save" } });
    fireEvent.keyDown(cancelledInput, { key: "Escape" });
    fireEvent.blur(cancelledInput);
    expect(
      slot.inspection.sidebarActionCalls.filter(
        (call) => call.method === "rename",
      ),
    ).toHaveLength(1);
    pinnedTab = slot.getByRole("button", { name: "Pinned chat" });

    fireEvent.contextMenu(pinnedTab);
    const unpin = await slot.findByRole("menuitem", { name: "Unpin" });
    expect(slot.getByRole("menuitem", { name: "Rename" })).toBeTruthy();
    expect(
      slot.getByRole("menuitem", { name: "Copy link" }),
    ).toBeTruthy();
    expect(
      slot.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual([
      "Copy link",
      "Mark as unread",
      "Unpin",
      "Rename",
      "Archive",
    ]);
    expect(
      slot.getByRole("menuitem", { name: "Mark as unread" }),
    ).toBeTruthy();
    expect(slot.getByRole("menuitem", { name: "Archive" })).toBeTruthy();
    fireEvent.click(unpin);
    await waitFor(() => expect(state.entries[0]?.pinned).toBe(false));

    fireEvent.contextMenu(pinnedTab);
    const pin = await slot.findByRole("menuitem", { name: "Pin" });
    fireEvent.click(pin);
    await waitFor(() => expect(state.entries[0]?.pinned).toBe(true));

    fireEvent.contextMenu(pinnedTab);
    fireEvent.click(await slot.findByRole("menuitem", { name: "Rename" }));
    const modalInput = await slot.findByRole("textbox", {
      name: "New chat title",
    });
    fireEvent.change(modalInput, { target: { value: "New name from modal" } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(slot.inspection.sidebarActionCalls).toContainEqual({
        method: "rename",
        threadId: "thr_pinned",
        title: "New name from modal",
      });
    });

    fireEvent.contextMenu(pinnedTab);
    fireEvent.click(
      await slot.findByRole("menuitem", { name: "Mark as unread" }),
    );
    await waitFor(() => {
      expect(slot.inspection.sidebarActionCalls).toContainEqual({
        method: "setRead",
        threadId: "thr_pinned",
        read: false,
      });
    });

    fireEvent.contextMenu(pinnedTab);
    fireEvent.click(await slot.findByRole("menuitem", { name: "Archive" }));
    await waitFor(() => {
      expect(slot.inspection.sidebarActionCalls).toContainEqual({
        method: "archive",
        threadId: "thr_pinned",
      });
      expect(state.entries).toEqual([]);
    });
  });

  it("opens a newly created chat when the first mounted route is already its thread", async () => {
    let state: TabsState = { version: 1, entries: [
      { threadId: "thr_old", projectId: "proj_api", title: "Old preview", pinned: false, openedAt: 1 },
    ] };
    const syncs: Array<{ threadId: string; reopen?: boolean }> = [];
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("App overlay is not registered");
    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_new" },
      sidebarThreads: {
        threads: [sidebarThread("thr_new", "proj_api", "New conversation", { createdAt: Date.now() - 5_000 })],
        projects: [{ id: "proj_api", name: "API", isPersonal: false }],
      },
      rpc: {
        tabs_list: () => ({ state }),
        tabs_sync_activity: ({ threads, reopen }) => {
          syncs.push({ threadId: threads[0]?.threadId ?? "", reopen });
          state = addTabCandidates(state, threads, Date.now());
          return { state };
        },
      },
    });
    await slot.findByRole("button", { name: "New conversation" });
    expect(syncs).toEqual([{ threadId: "thr_new", reopen: false }]);
    expect(state.entries.map((entry) => entry.threadId)).toEqual(["thr_new"]);
  });

  it("does not reopen a freshly created chat that was explicitly closed", async () => {
    const state: TabsState = { version: 1, entries: [] };
    let syncCount = 0;
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("App overlay is not registered");
    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_closed" },
      sidebarThreads: {
        threads: [sidebarThread("thr_closed", "proj_api", "Closed chat", { createdAt: Date.now() - 5_000 })],
        projects: [{ id: "proj_api", name: "API", isPersonal: false }],
      },
      rpc: {
        tabs_list: () => ({ state }),
        // The persisted closed-ID guard rejects this automatic sync.
        tabs_sync_activity: ({ reopen }) => {
          expect(reopen).toBe(false);
          syncCount += 1;
          return { state };
        },
      },
    });
    await waitFor(() => expect(syncCount).toBe(1));
    expect(slot.queryByRole("button", { name: "Closed chat" })).toBeNull();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(syncCount).toBe(1);
  });

  it("opens a new current chat even when the sidebar omits it", async () => {
    let state: TabsState = { version: 1, entries: [] };
    let syncCount = 0;
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("App overlay is not registered");
    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_new" },
      sidebarThreads: {
        threads: [],
        projects: [{ id: "proj_api", name: "API", isPersonal: false }],
      },
      rpc: {
        tabs_list: () => ({ state }),
        tabs_resolve_current: ({ threadId }) => ({
          candidate: { threadId, projectId: "proj_api", title: "Just created" },
          createdAt: Date.now() - 5_000,
        }),
        tabs_sync_activity: ({ threads, reopen }) => {
          expect(reopen).toBe(false);
          syncCount += 1;
          state = addTabCandidates(state, threads, Date.now());
          return { state };
        },
      },
    });
    await slot.findByRole("button", { name: "Just created" });
    expect(syncCount).toBe(1);
  });

  it("does not invent a preview for an unchanged route omitted from the sidebar", async () => {
    let state: TabsState = { version: 1, entries: [] };
    const synced: string[] = [];
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("App overlay is not registered");
    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_current" },
      sidebarThreads: {
        threads: [sidebarThread("thr_other", "proj_api", "Other chat")],
        projects: [{ id: "proj_api", name: "API", isPersonal: false }],
      },
      rpc: {
        tabs_list: () => ({ state, history: { version: 1, entries: [] } }),
        tabs_resolve_current: ({ threadId }) => ({ candidate: {
          threadId, projectId: "proj_api", title: "Viewed but omitted",
        } }),
        tabs_sync_activity: ({ threads }) => {
          synced.push(threads[0]?.threadId ?? "");
          state = addTabCandidates(state, threads, Date.now());
          return { state };
        },
      },
    });
    await waitFor(() => expect(slot.inspection.rpcCalls.some((call) => call.method === "tabs_resolve_current")).toBe(true));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(synced).toEqual([]);
    expect(state.entries).toEqual([]);
    expect(slot.queryByRole("button", { name: "Viewed but omitted" })).toBeNull();
  });

  it("does not reopen a preview closed in another window while the route stays unchanged", async () => {
    let state: TabsState = { version: 1, entries: [
      { threadId: "thr_current", projectId: "proj_api", title: "Current chat", pinned: false, openedAt: 1 },
    ] };
    let syncCount = 0;
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("App overlay is not registered");
    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_current" },
      sidebarThreads: {
        threads: [sidebarThread("thr_current", "proj_api", "Current chat")],
        projects: [{ id: "proj_api", name: "API", isPersonal: false }],
      },
      rpc: {
        tabs_list: () => ({ state, history: { version: 1, entries: [] } }),
        tabs_sync_activity: ({ threads }) => {
          syncCount++;
          state = addTabCandidates(state, threads, syncCount);
          return { state };
        },
      },
    });
    await slot.findByRole("button", { name: "Current chat" });
    state = { version: 1, entries: [] };
    await slot.emitRealtime("tabs-changed", state);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(syncCount).toBe(0);
    expect(slot.queryByRole("button", { name: "Current chat" })).toBeNull();
  });

  it("keeps a closed preview closed after page reload, even with a pinned fallback", async () => {
    let state: TabsState = {
      version: 1,
      entries: [
        { threadId: "thr_other", projectId: "proj_api", title: "Other chat", pinned: true, openedAt: 1 },
        { threadId: "thr_current", projectId: "proj_api", title: "Current chat", pinned: false, openedAt: 2 },
      ],
    };
    const synced: string[] = [];
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("App overlay is not registered");
    const options = {
      context: { projectId: "proj_api", threadId: "thr_current" },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_current", "proj_api", "Current chat"),
          sidebarThread("thr_other", "proj_api", "Other chat"),
        ],
        projects: [{ id: "proj_api", name: "API", isPersonal: false }],
      },
      rpc: {
        tabs_list: () => ({ state }),
        tabs_sync_activity: ({ threads }) => {
          synced.push(...threads.map((thread) => thread.threadId));
          state = addTabCandidates(state, threads, Date.now());
          return { state };
        },
        tabs_close: ({ threadId }) => {
          const removed = state.entries.some((entry) => entry.threadId === threadId);
          state = { ...state, entries: state.entries.filter((entry) => entry.threadId !== threadId) };
          return { state, removed };
        },
      },
    } satisfies RenderSlotOptions<typeof rpcContract>;
    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, options);
    await slot.findByRole("button", { name: "Current chat" });
    fireEvent.click(slot.getByRole("button", { name: "Close tab “Current chat”" }));
    await waitFor(() => expect(slot.inspection.sidebarActionCalls).toContainEqual({
      method: "open", threadId: "thr_other", options: undefined,
    }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(state.entries.map((entry) => entry.threadId)).toEqual(["thr_other"]);
    expect(synced).toEqual([]);
    expect(slot.queryByRole("button", { name: "Current chat" })).toBeNull();

    slot.unmount();
    const reloaded = renderSlot<{}, typeof rpcContract>(overlay, {}, options);
    await reloaded.findByRole("button", { name: "Other chat" });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(synced).toEqual([]);
    expect(state.entries.map((entry) => entry.threadId)).toEqual(["thr_other"]);
    expect(reloaded.queryByRole("button", { name: "Current chat" })).toBeNull();
  });

  it("keeps a persisted preview when current chat and work arrive together", async () => {
    let state: TabsState = { version: 1, entries: [
      { threadId: "thr_current", projectId: "proj_api", title: "Current chat", pinned: false, openedAt: 1 },
    ] };
    let history: TabHistoryState = {
      version: 1,
      entries: [{ threadId: "thr_work", projectId: "proj_api", title: "Working chat", visitedAt: 1 }],
    };
    const synced: string[] = [];
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("App overlay is not registered");
    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_current" },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_current", "proj_api", "Current chat"),
          sidebarThread("thr_work", "proj_api", "Working chat", {
            updatedAt: 10,
            indicator: "workflow",
          }),
        ],
        projects: [{ id: "proj_api", name: "API", isPersonal: false }],
      },
      rpc: {
        tabs_list: () => ({ state, history }),
        tabs_sync_activity: ({ threads }) => {
          synced.push(threads[0]?.threadId ?? "");
          state = addTabCandidates(state, threads, synced.length + 10);
          return { state };
        },
        tabs_history_visit: (candidate) => {
          history = visitTabHistory(history, candidate, Date.now());
          return { history };
        },
      },
    });
    await waitFor(() => {
      expect(state.entries.at(-1)?.threadId).toBe("thr_current");
      expect(history.entries[0]?.threadId).toBe("thr_work");
    });
    expect(synced).toEqual([]);
    expect(await slot.findByRole("button", { name: "Current chat" })).toBeTruthy();
  });

  it("revisits a chat after another window changes history", async () => {
    const state: TabsState = {
      version: 1,
      entries: [{ threadId: "thr_current", projectId: "proj_api", title: "Current chat", pinned: true, openedAt: 1 }],
    };
    let history: TabHistoryState = { version: 1, entries: [] };
    let visitCalls = 0;
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("App overlay is not registered");
    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_current" },
      sidebarThreads: {
        threads: [sidebarThread("thr_current", "proj_api", "Current chat")],
        projects: [{ id: "proj_api", name: "API", isPersonal: false }],
      },
      rpc: {
        tabs_list: () => ({ state, history }),
        tabs_history_visit: (candidate) => {
          visitCalls += 1;
          history = visitTabHistory(history, candidate, visitCalls + 10);
          return { history };
        },
      },
    });
    await waitFor(() => expect(visitCalls).toBe(1));
    history = visitTabHistory(history, {
      threadId: "thr_other", projectId: "proj_api", title: "Other chat",
    }, 30);
    await slot.emitRealtime("tabs-history-changed", history);
    fireEvent.click(slot.getByRole("button", { name: "Current chat" }));
    await waitFor(() => {
      expect(visitCalls).toBe(2);
      expect(history.entries[0]?.threadId).toBe("thr_current");
    });
  });

  it("does not replace a just-pinned preview with background work", async () => {
    let state: TabsState = {
      version: 1,
      entries: [{ threadId: "thr_current", projectId: "proj_api", title: "Current chat", pinned: false, openedAt: 1 }],
    };
    let history: TabHistoryState = { version: 1, entries: [] };
    const synced: string[] = [];
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("App overlay is not registered");
    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_current" },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_current", "proj_api", "Current chat"),
          sidebarThread("thr_work", "proj_api", "Background job", { indicator: "workflow", updatedAt: 20 }),
        ],
        projects: [{ id: "proj_api", name: "API", isPersonal: false }],
      },
      rpc: {
        tabs_list: () => ({ state, history }),
        tabs_sync_activity: ({ threads }) => {
          synced.push(...threads.map((thread) => thread.threadId));
          state = addTabCandidates(state, threads, 20);
          return { state };
        },
        tabs_set_pinned: ({ threadId, pinned }) => {
          state = setTabPinned(state, threadId, pinned);
          return { state };
        },
        tabs_history_visit: (candidate) => {
          history = visitTabHistory(history, candidate, 20);
          return { history };
        },
      },
    });
    const tab = await slot.findByRole("button", { name: "Current chat" });
    expect(tab.closest(".bb-chat-tab")?.getAttribute("data-preview")).toBe("true");
    fireEvent.doubleClick(tab);
    await waitFor(() => {
      expect(state.entries).toEqual([expect.objectContaining({ threadId: "thr_current", pinned: true })]);
      expect(history.entries.some((entry) => entry.threadId === "thr_work")).toBe(true);
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(slot.container.querySelectorAll('[data-preview="true"]')).toHaveLength(0);
    expect(synced).not.toContain("thr_work");
  });

  it("lists every working chat in history while keeping the viewed tab active", async () => {
    let state: TabsState = {
      version: 1,
      entries: [{ threadId: "thr_current", projectId: "proj_api", title: "Current chat", pinned: true, openedAt: 1 }],
    };
    let history: TabHistoryState = { version: 1, entries: [] };
    let visitedAt = 10;
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("App overlay is not registered");
    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_current" },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_current", "proj_api", "Current chat"),
          sidebarThread("thr_first", "proj_api", "First job", { updatedAt: 10, indicator: "workflow" }),
          sidebarThread("thr_second", "proj_api", "Second job", { updatedAt: 20, indicator: "workflow" }),
        ],
        projects: [{ id: "proj_api", name: "API", isPersonal: false }],
      },
      rpc: {
        tabs_list: () => ({ state, history }),
        tabs_sync_activity: ({ threads }) => {
          state = addTabCandidates(state, threads, ++visitedAt);
          return { state };
        },
        tabs_history_visit: (candidate) => {
          history = visitTabHistory(history, candidate, ++visitedAt);
          return { history };
        },
      },
    });
    await waitFor(() => {
      expect(history.entries.slice(0, 2).map((entry) => entry.threadId)).toEqual([
        "thr_second", "thr_first",
      ]);
      expect(state.entries.every((entry) => entry.pinned)).toBe(true);
    });
    await waitFor(() => {
      expect(slot.getByRole("button", { name: "Current chat" }).getAttribute("aria-current")).toBe("page");
      expect(slot.queryByRole("button", { name: "Second job, work is running" })).toBeNull();
    });
  });

  it("handles behavior 13", async () => {
    const state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_unread",
          projectId: "proj_api",
          title: "Unread chat",
          pinned: true,
          openedAt: 1,
        },
        {
          threadId: "thr_working",
          projectId: "proj_api",
          title: "Working chat",
          pinned: true,
          openedAt: 2,
        },
      ],
    };
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("App overlay is not registered");

    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_unread" },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_unread", "proj_api", "Unread chat", {
            isUnread: true,
          }),
          sidebarThread("thr_working", "proj_api", "Working chat", {
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
      name: "Unread chat, unread messages",
    });
    expect(unreadTab.closest(".bb-chat-tab")?.getAttribute("data-unread")).toBe(
      "true",
    );
    expect(unreadTab.querySelector(".bb-chat-tab-unread")).not.toBeNull();
    expect(unreadTab.querySelector(".bb-chat-tab-working")).toBeNull();
    expect(unreadTab.getAttribute("title")).toContain(
      "There are unread messages.",
    );

    const workingTab = slot.getByRole("button", {
      name: "Working chat, work is running, unread messages",
    });
    expect(workingTab.querySelector(".bb-chat-tab-working")).not.toBeNull();
    expect(workingTab.querySelector(".bb-chat-tab-unread")).not.toBeNull();
  });

  it("handles behavior 14", async () => {
    const state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_idle",
          projectId: "proj_api",
          title: "Quiet chat",
          pinned: true,
          openedAt: 1,
        },
        {
          threadId: "thr_parent",
          projectId: "proj_api",
          title: "Parent chat",
          pinned: true,
          openedAt: 2,
        },
        {
          threadId: "thr_running",
          projectId: "proj_web",
          title: "Active chat",
          pinned: true,
          openedAt: 3,
        },
        {
          threadId: "thr_preview",
          projectId: "proj_api",
          title: "Temporary chat",
          pinned: false,
          openedAt: 4,
        },
      ],
    };
    const homepage = app.homepageSections.find(
      (section) => section.id === "pinned-tabs",
    );
    if (homepage === undefined) {
      throw new Error("Pinned chats homepage section is not registered");
    }

    const slot = renderSlot<{ projectId: string | null }, typeof rpcContract>(
      homepage,
      { projectId: "proj_api" },
      {
        context: { projectId: "proj_api", threadId: null },
        sidebarThreads: {
          threads: [
            sidebarThread("thr_idle", "proj_api", "Quiet chat"),
            sidebarThread("thr_parent", "proj_api", "Parent chat", {
              isUnread: true,
            }),
            sidebarThread("thr_child", "proj_api", "Nested workflow", {
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
            sidebarThread("thr_running", "proj_web", "Active chat", {
              activity: {
                workflows: 0,
                backgroundAgents: 1,
                backgroundCommands: 0,
                planMode: 0,
                goals: 0,
              },
              indicator: "background-agent",
            }),
            sidebarThread("thr_preview", "proj_api", "Temporary chat"),
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

    const list = await slot.findByRole("list", { name: "Tabs" });
    const rows = [
      ...list.querySelectorAll(".bb-chat-tabs-homepage-pinned-item"),
    ];
    expect(rows).toHaveLength(3);
    expect(
      rows.map(
        (row) =>
          row.querySelector(".bb-chat-tabs-homepage-pinned-title")?.textContent,
      ),
    ).toEqual(["Quiet chat", "Parent chat", "Active chat"]);
    expect(list.textContent).not.toContain("No activity");
    expect(
      rows[0]?.querySelector(".bb-chat-tabs-homepage-pinned-status"),
    ).toBeNull();
    expect(list.textContent).toContain("Working · Unread");
    expect(list.textContent).toContain("Working");
    expect(slot.getByRole("button", {
      name: "Quiet chat. Project: API.",
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
    expect(slot.queryByText("Temporary chat")).toBeNull();

    const activeChatButton = slot.getByRole("button", {
      name: "Active chat. Project: Web. Working.",
    });
    fireEvent.click(activeChatButton);
    expect(slot.inspection.sidebarActionCalls).toContainEqual({
      method: "open",
      threadId: "thr_running",
      options: undefined,
    });
  });

  it("handles behavior 15", async () => {
    const state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_current",
          projectId: "proj_api",
          title: "Current",
          pinned: true,
          openedAt: 1,
        },
      ],
    };
    const homepage = app.homepageSections.find(
      (section) => section.id === "pinned-tabs",
    );
    if (homepage === undefined) {
      throw new Error("Pinned chats homepage section is not registered");
    }
    let listCalls = 0;

    const slot = renderSlot<{ projectId: string | null }, typeof rpcContract>(
      homepage,
      { projectId: "proj_api" },
      {
        context: { projectId: "proj_api", threadId: null },
        settings: { showPinnedTabsList: false },
        sidebarThreads: {
          threads: [sidebarThread("thr_current", "proj_api", "Current")],
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
    expect(slot.queryByRole("button", { name: /Current/u })).toBeNull();
    expect(listCalls).toBe(0);
  });

  it("handles behavior 16", async () => {
    const state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_parent",
          projectId: "proj_api",
          title: "Parent chat",
          pinned: true,
          openedAt: 1,
        },
      ],
    };
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("App overlay is not registered");

    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_parent" },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_parent", "proj_api", "Parent chat"),
          sidebarThread("thr_workflow", "proj_api", "Nested workflow", {
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
      name: "Parent chat, nested work is running",
    });
    expect(parentTab.querySelector(".bb-chat-tab-working")).not.toBeNull();
    expect(parentTab.closest(".bb-chat-tab")?.getAttribute("data-nested-work")).toBe(
      "true",
    );
    expect(parentTab.getAttribute("title")).toContain(
      "Nested work is running.",
    );
  });

  it("handles behavior 17", async () => {
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
    if (overlay === undefined) throw new Error("App overlay is not registered");

    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_system", threadId: "thr_system_all" },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_system_all", "proj_system", "SystemAll 1", {
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
      name: "SystemAll 1, work is running",
    });
    expect(systemTab.querySelector(".bb-chat-tab-working")).not.toBeNull();
  });

  it("handles behavior 18", async () => {
    const state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_parent",
          projectId: "proj_api",
          title: "Parent chat",
          pinned: true,
          openedAt: 1,
        },
      ],
    };
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("App overlay is not registered");

    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_parent" },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_parent", "proj_api", "Parent chat"),
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
      name: "Parent chat, nested work is running",
    });
    expect(parentTab.querySelector(".bb-chat-tab-working")).not.toBeNull();
  });

  it("does not create a preview for a background workflow without a viewed chat", async () => {
    let received: readonly { threadId: string; projectId: string; title: string }[] = [];
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("App overlay is not registered");

    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: null },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_parent", "proj_api", "Parent chat", {
            updatedAt: 1,
          }),
          sidebarThread("thr_workflow", "proj_api", "Nested workflow", {
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

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(received).toEqual([]);
    expect(slot.container.querySelectorAll('[data-preview="true"]')).toHaveLength(0);
  });

  it("does not turn work on the current unchanged route into a preview", async () => {
    let received: readonly { threadId: string; projectId: string; title: string }[] = [];
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("App overlay is not registered");

    renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_active" },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_active", "proj_api", "Active build", {
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
          sidebarThread("thr_done", "proj_api", "Unread result", {
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

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(received).toEqual([]);
  });

  it("handles behavior 21", async () => {
    const state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_current",
          projectId: "proj_api",
          title: "Current",
          pinned: true,
          openedAt: 1,
        },
        {
          threadId: "thr_next",
          projectId: "proj_web",
          title: "Next",
          pinned: true,
          openedAt: 2,
        },
        {
          threadId: "thr_last",
          projectId: "proj_docs",
          title: "Last",
          pinned: true,
          openedAt: 3,
        },
      ],
    };
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("App overlay is not registered");

    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_current" },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_current", "proj_api", "Current"),
          sidebarThread("thr_next", "proj_web", "Next"),
          sidebarThread("thr_last", "proj_docs", "Last"),
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

    await slot.findByRole("button", { name: "Current" });
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

  it("handles behavior 22", async () => {
    const state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_current",
          projectId: "proj_api",
          title: "Current",
          pinned: true,
          openedAt: 1,
        },
      ],
    };
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("App overlay is not registered");
    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_current" },
      sidebarThreads: {
        threads: [sidebarThread("thr_current", "proj_api", "Current")],
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

    await slot.findByRole("button", { name: "Current" });
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

  it("handles behavior 23", async () => {
    let state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_current",
          projectId: "proj_api",
          title: "Current",
          pinned: true,
          openedAt: 1,
        },
        {
          threadId: "thr_next",
          projectId: "proj_api",
          title: "Next",
          pinned: true,
          openedAt: 2,
        },
      ],
    };
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("App overlay is not registered");

    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_current" },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_current", "proj_api", "Current"),
          sidebarThread("thr_next", "proj_api", "Next"),
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

    await slot.findByRole("button", { name: "Current" });
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

  it("handles behavior 24", async () => {
    const desktop = installDesktopCloseRequestBridge();
    let state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_current",
          projectId: "proj_api",
          title: "Current",
          pinned: true,
          openedAt: 1,
        },
        {
          threadId: "thr_next",
          projectId: "proj_api",
          title: "Next",
          pinned: true,
          openedAt: 2,
        },
      ],
    };
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("App overlay is not registered");

    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_current" },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_current", "proj_api", "Current"),
          sidebarThread("thr_next", "proj_api", "Next"),
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

    await slot.findByRole("button", { name: "Current" });
    expect(desktop.listenerCount()).toBe(1);
    expect(desktop.dispatch()).toBe(true);
    await waitFor(() => {
      expect(state.entries.map((entry) => entry.threadId)).toEqual(["thr_next"]);
    });
    expect(slot.inspection.sidebarActionCalls).toEqual([
      { method: "open", threadId: "thr_next", options: undefined },
    ]);
  });

  it("handles behavior 25", async () => {
    const desktop = installDesktopCloseRequestBridge();
    const state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_current",
          projectId: "proj_api",
          title: "Current",
          pinned: true,
          openedAt: 1,
        },
        {
          threadId: "thr_next",
          projectId: "proj_api",
          title: "Next",
          pinned: true,
          openedAt: 2,
        },
      ],
    };
    let closeCalls = 0;
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("App overlay is not registered");

    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_current" },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_current", "proj_api", "Current"),
          sidebarThread("thr_next", "proj_api", "Next"),
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

    await slot.findByRole("button", { name: "Current" });
    expect(desktop.browserFocusListenerCount()).toBe(1);
    desktop.dispatchBrowserViewFocus("browser-current");

    const nativeBrowserKeydown = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: "w",
    });
    window.dispatchEvent(nativeBrowserKeydown);
    expect(nativeBrowserKeydown.defaultPrevented).toBe(false);
    expect(closeCalls).toBe(0);

    expect(desktop.dispatch()).toBe(false);
    expect(closeCalls).toBe(0);

    const chatControl = document.createElement("button");
    document.body.append(chatControl);
    fireEvent.focusIn(chatControl);
    expect(desktop.dispatch()).toBe(true);
    await waitFor(() => expect(closeCalls).toBe(1));
    chatControl.remove();

    const browserChrome = document.createElement("div");
    browserChrome.dataset.appBrowser = "";
    document.body.append(browserChrome);
    fireEvent.pointerDown(browserChrome);
    expect(desktop.dispatch()).toBe(false);
    expect(closeCalls).toBe(1);

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

  it("handles behavior 26", async () => {
    const desktop = installDesktopCloseRequestBridge();
    const state: TabsState = {
      version: 1,
      entries: [
        {
          threadId: "thr_other",
          projectId: "proj_api",
          title: "Other",
          pinned: true,
          openedAt: 1,
        },
      ],
    };
    let closeCalls = 0;
    const overlay = app.appOverlays[0];
    if (overlay === undefined) throw new Error("App overlay is not registered");

    const slot = renderSlot<{}, typeof rpcContract>(overlay, {}, {
      context: { projectId: "proj_api", threadId: "thr_current" },
      sidebarThreads: {
        threads: [
          sidebarThread("thr_current", "proj_api", "Current"),
          sidebarThread("thr_other", "proj_api", "Other"),
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

    await slot.findByRole("button", { name: "Other" });
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
