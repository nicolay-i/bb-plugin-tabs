// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import type { PluginCommandContext, PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { renderPartialSlot } from "./test-utils";
import type { rpcContract } from "./server";
import { createTabCommands } from "./lib/tab-commands";
import { workspaceSelectionStore } from "./lib/workspace-selection";
import { createInitialWorkspaces, workspaceInfos } from "./lib/workspaces";
import {
  closeTab,
  movePinnedTab,
  restoreClosedTab,
  setTabFavorite,
  setTabPinned,
  type TabsState,
} from "./lib/tabs-model";

const app = await loadPluginApp(() => import("./app"));
const commands = createTabCommands("ru");
const context: PluginCommandContext = {
  threadId: "current",
  projectId: "project",
  openPanel: () => false,
};
const command = (id: string) => {
  const result = commands.find((command) => command.id === id);
  if (!result) throw new Error(`Missing command ${id}`);
  return result;
};
const available = (id: string) => command(id).isAvailable?.(context) ?? true;
const run = (id: string) =>
  act(async () => {
    await command(id).run(context);
  });
function thread(id: string, parentThreadId: string | null): PluginSidebarThread {
  return {
    id,
    projectId: "project",
    title: id,
    titleFallback: null,
    parentThreadId,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "pi",
    hasPendingInteraction: false,
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
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
  };
}
const store = workspaceSelectionStore();
beforeEach(() => {
  store.setWorkspacesEnabled(true);
  store.acceptCatalog(workspaceInfos(createInitialWorkspaces(undefined, undefined)));
  store.select("work");
  store.observeRoute(null);
  window.history.replaceState(null, "", "/projects/project/threads/current");
  for (const id of ["work", "home", "other"]) {
    let closed = store.lastClosed(id);
    while (closed) {
      store.forgetClosed(id, closed.entry.threadId);
      closed = store.lastClosed(id);
    }
  }
});
afterEach(cleanup);
async function renderCommands({ root = false, empty = false } = {}) {
  let state: TabsState = {
    version: 1,
    entries: empty
      ? []
      : ["parent", "current", "third", "last"].map((id, index) => ({
          threadId: id,
          projectId: "project",
          title: id,
          pinned: id !== "last",
          openedAt: index + 1,
        })),
  };
  const overlay = app.appOverlays[0];
  if (!overlay) throw new Error("Missing overlay");
  const homeState: TabsState = {
    version: 1,
    entries: [
      { threadId: "home-chat", projectId: "project", title: "Home", pinned: true, openedAt: 1 },
    ],
  };
  const slot = renderPartialSlot<{}, typeof rpcContract>(
    overlay,
    {},
    {
      context: { projectId: "project", threadId: "current" },
      settings: { language: "English" },
      sidebarThreads: {
        threads: [
          thread("parent", null),
          thread("current", root ? null : "parent"),
          ...(root ? [] : [thread("child", "current")]),
        ],
        projects: [],
      },
      rpc: {
        tabs_list: (input) => ({ state: input?.workspaceId === "home" ? homeState : state }),
        tabs_pinned_list: () => ({ entries: [], stateRevision: 0 }),
        tabs_history_visit: () => ({ history: { version: 1, entries: [] } }),
        tabs_sync_activity: () => ({ state }),
        tabs_set_pinned: ({ threadId, pinned }) => ({
          state: (state = setTabPinned(state, threadId, pinned)),
        }),
        tabs_set_favorite: ({ threadId, favorite }) => ({
          state: (state = setTabFavorite(state, threadId, favorite)),
        }),
        tabs_move: ({ sourceThreadId, targetThreadId, position }) => ({
          state: (state = movePinnedTab(state, sourceThreadId, targetThreadId, position)),
        }),
        tabs_close: ({ threadId }) => ({
          state: (state = closeTab(state, threadId)),
          removed: true,
        }),
        tabs_restore: ({ entry, index }) => ({
          state: (state = restoreClosedTab(state, entry, index)),
          status: "restored",
        }),
      },
    },
  );
  await waitFor(() =>
    expect(slot.inspection.rpcCalls.some((call) => call.method === "tabs_list")).toBe(true),
  );
  if (!empty) await slot.findByRole("button", { name: "current" });
  return { slot, state: () => state };
}

describe("SDK tab commands", () => {
  it("registers exactly the requested defaults and localized palette-only commands", () => {
    expect(commands).toHaveLength(23);
    expect(new Set(commands.map((command) => command.id)).size).toBe(23);
    expect(command("select-1").title).toBe("Перейти на вкладку 1");
    expect(command("select-1").defaultShortcut).toEqual({ key: "1", mod: true, alt: true });
    expect(command("last").defaultShortcut).toEqual({ key: "9", mod: true, alt: true });
    expect(command("rename").defaultShortcut).toEqual({ key: "F2" });
    for (const [id, key] of [
      ["toggle-pin", "p"],
      ["toggle-favorite", "s"],
      ["next-workspace", "w"],
      ["parent", "ArrowUp"],
      ["children", "ArrowDown"],
    ]) {
      expect(command(id!).defaultShortcut).toEqual({ key, mod: true, alt: true });
    }
    for (const id of [
      "list",
      "copy-link",
      "close-others",
      "move-left",
      "move-right",
      "next",
      "previous",
      "restore",
    ])
      expect(command(id).defaultShortcut).toBeUndefined();
    expect(commands.every((command) => !command.isAvailable?.(context))).toBe(true);
  });

  it("selects by rendered order, selects the last tab, cycles and opens the parent", async () => {
    const { slot } = await renderCommands();
    expect(available("select-8")).toBe(false);
    expect(available("parent")).toBe(true);
    for (const [id, target] of [
      ["select-1", "parent"],
      ["last", "last"],
      ["next", "third"],
      ["previous", "parent"],
      ["parent", "parent"],
    ]) {
      await run(id!);
      expect(slot.inspection.sidebarActionCalls.at(-1)).toMatchObject({
        method: "open",
        threadId: target,
      });
    }
    expect(command("parent").isAvailable?.({ ...context, threadId: "other" })).toBe(false);
    slot.unmount();
    expect(available("parent")).toBe(false);
  });

  it("reuses pin/favorite mutations and pinned-order moves with fresh state", async () => {
    const f = await renderCommands();
    await run("toggle-favorite");
    expect(f.state().favorites?.map((entry) => entry.threadId)).toEqual(["current"]);
    await run("toggle-favorite");
    expect(f.state().favorites ?? []).toEqual([]);
    await run("move-left");
    expect(
      f
        .state()
        .entries.filter((entry) => entry.pinned)
        .map((entry) => entry.threadId),
    ).toEqual(["current", "parent", "third"]);
    expect(available("move-left")).toBe(false);
    await run("move-right");
    expect(
      f
        .state()
        .entries.filter((entry) => entry.pinned)
        .map((entry) => entry.threadId),
    ).toEqual(["parent", "current", "third"]);
    await run("toggle-pin");
    expect(f.state().entries.find((entry) => entry.threadId === "current")?.pinned).toBe(false);
    expect(available("move-left")).toBe(false);
    await run("toggle-pin");
    expect(f.state().entries.find((entry) => entry.threadId === "current")?.pinned).toBe(true);
  });

  it("opens the existing list/tree without additional RPC, preserving focus", async () => {
    const { slot } = await renderCommands();
    const reads = slot.inspection.rpcCalls.filter((call) => call.method === "tabs_list").length;
    await run("children");
    expect(await slot.findByRole("menuitem", { name: "child" })).toBeTruthy();
    fireEvent.keyDown(slot.getByRole("menu", { name: "Subthreads of “current”" }), {
      key: "Escape",
    });
    await waitFor(() => expect(document.querySelector(".bb-chat-tabs-child-menu")).toBeNull());
    expect(available("list")).toBe(true);
    await run("list");
    const search = await slot.findByRole("searchbox", { name: "Search chats by title or project" });
    await waitFor(() => expect(document.activeElement).toBe(search));
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "tabs_list")).toHaveLength(
      reads,
    );
  });

  it("hides parent/tree for roots and tab actions with no tabs", async () => {
    const f = await renderCommands({ root: true });
    expect(available("parent")).toBe(false);
    expect(available("children")).toBe(false);
    f.slot.unmount();
    await renderCommands({ empty: true });
    for (const id of [
      "select-1",
      "last",
      "parent",
      "children",
      "toggle-pin",
      "toggle-favorite",
      "rename",
      "next",
      "previous",
      "close-others",
    ])
      expect(available(id)).toBe(false);
  });

  it("guards F2 in editors but allows the palette to run rename after restoring focus", async () => {
    const { slot } = await renderCommands();
    const editor = document.createElement("textarea");
    slot.container.append(editor);
    editor.focus();
    expect(available("rename")).toBe(false);
    const palette = document.createElement("div");
    palette.setAttribute("role", "dialog");
    const input = document.createElement("input");
    palette.append(input);
    slot.container.append(palette);
    input.focus();
    expect(available("rename")).toBe(true);
    palette.remove();
    editor.focus();
    await run("rename");
    expect(await slot.findByRole("dialog", { name: "Rename chat" })).toBeTruthy();
    expect(available("toggle-pin")).toBe(false);
  });

  it("closes only other tabs and restores the latest close using the existing undo stack", async () => {
    const f = await renderCommands();
    expect(available("restore")).toBe(false);
    await run("close-others");
    expect(f.state().entries.map((entry) => entry.threadId)).toEqual(["current"]);
    expect(available("close-others")).toBe(false);
    expect(available("restore")).toBe(true);
    await run("restore");
    expect(f.state().entries.map((entry) => entry.threadId)).toEqual(["current", "last"]);
    expect(f.slot.inspection.sidebarActionCalls).toContainEqual({
      method: "open",
      threadId: "last",
      options: undefined,
    });
  });

  it("switches workspace through the same restoration path as the header", async () => {
    const { slot } = await renderCommands();
    await run("next-workspace");
    expect(store.getSnapshot().workspaceId).toBe("home");
    expect(slot.inspection.sidebarActionCalls).toContainEqual({
      method: "open",
      threadId: "home-chat",
      options: undefined,
    });
  });

  it("copies the current chat link through the existing clipboard action", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      await renderCommands();
      await run("copy-link");
      expect(writeText).toHaveBeenCalledWith(
        expect.stringContaining("/projects/project/threads/current"),
      );
    } finally {
      if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });
});
