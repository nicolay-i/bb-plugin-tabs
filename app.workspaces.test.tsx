// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import { renderPartialSlot as renderSlot, type PartialRenderSlotOptions } from "./test-utils";
import type { rpcContract } from "./server";
import type { PluginRpcResult } from "@get-bb/plugin-sdk";
import {
  addWorkspace,
  createInitialWorkspaces,
  deleteWorkspace,
  getWorkspace,
  renameWorkspace,
  workspaceInfos,
} from "./lib/workspaces";
import {
  createEmptyTabsState,
  addTabCandidates,
  closeTab,
  openTabCandidate,
  restoreClosedTab,
  setTabFavorite,
  type TabsState,
} from "./lib/tabs-model";
import { workspaceSelectionStore } from "./lib/workspace-selection";

const app = await loadPluginApp(() => import("./app"));
const current = { threadId: "work-thread", projectId: "project", title: "Work chat" };
function ChatSurface() {
  const overlay = app.appOverlays[0];
  const header = app.threadHeaderActions[0];
  if (!overlay || !header) throw new Error("Missing chat surfaces");
  const Overlay = overlay.component;
  const Header = header.component;
  return (
    <>
      <header data-testid="workspace-thread-header">
        <Header threadId={current.threadId} projectId="project" isCompactViewport={false} />
      </header>
      <Overlay />
    </>
  );
}
const home = { threadId: "home-thread", projectId: "project", title: "Home chat" };
const store = workspaceSelectionStore();
type Handlers = NonNullable<PartialRenderSlotOptions<typeof rpcContract>["rpc"]>;

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<Value>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  store.setWorkspacesEnabled(true);
  store.observeRoute(null);
  store.acceptCatalog(workspaceInfos(createInitialWorkspaces(undefined, undefined)));
  store.select("work");
  for (const id of ["work", "home", "other"]) {
    let closed = store.lastClosed(id);
    while (closed !== null) {
      store.forgetClosed(id, closed.entry.threadId);
      closed = store.lastClosed(id);
    }
  }
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
});
afterEach(cleanup);

let fixtureRevision = 0;
function fixture() {
  let collection = {
    ...createInitialWorkspaces(undefined, undefined),
    revision: ++fixtureRevision * 100,
  };
  collection = {
    ...collection,
    workspaces: collection.workspaces.map((workspace) => {
      const candidate = workspace.id === "work" ? current : home;
      const state =
        workspace.id === "other"
          ? createEmptyTabsState()
          : setTabFavorite(
              openTabCandidate(createEmptyTabsState(), candidate, 1),
              candidate.threadId,
              true,
            );
      return { ...workspace, state };
    }),
  };
  const changeState = (id: string, apply: (state: TabsState) => TabsState) => {
    collection = {
      ...collection,
      revision: collection.revision + 1,
      workspaces: collection.workspaces.map((workspace) =>
        workspace.id === id ? { ...workspace, state: apply(workspace.state) } : workspace,
      ),
    };
    return getWorkspace(collection, id).state;
  };
  const list = (id: string): PluginRpcResult<(typeof rpcContract)["tabs_list"]> => ({
    state: getWorkspace(collection, id).state,
    workspaceId: id,
    stateRevision: collection.revision,
    workspaces: workspaceInfos(collection),
    history: { version: 1, entries: [] },
  });
  const rpc: Handlers = {
    tabs_workspaces_list: () => ({
      workspaces: workspaceInfos(collection),
      stateRevision: collection.revision,
    }),
    tabs_list: (input) => list(input?.workspaceId ?? "work"),
    tabs_workspace_memberships: ({ threadId }) => ({
      stateRevision: collection.revision,
      workspaces: workspaceInfos(collection).map((info) => ({
        ...info,
        included: getWorkspace(collection, info.id).state.entries.some(
          (entry) => entry.threadId === threadId,
        ),
      })),
    }),
    tabs_open: (candidate) => ({
      state: changeState(candidate.workspaceId ?? "work", (state) =>
        openTabCandidate(state, candidate, 10),
      ),
      stateRevision: collection.revision,
    }),
    tabs_close: ({ threadId, workspaceId }) => ({
      state: changeState(workspaceId ?? "work", (state) => closeTab(state, threadId)),
      stateRevision: collection.revision,
      removed: true,
    }),
    tabs_restore: ({ entry, index, workspaceId }) => {
      const id = workspaceId ?? "work";
      const status = getWorkspace(collection, id).state.entries.some(
        (item) => item.threadId === entry.threadId,
      )
        ? ("open" as const)
        : ("restored" as const);
      return {
        state: changeState(id, (state) => restoreClosedTab(state, entry, index)),
        stateRevision: collection.revision,
        status,
      };
    },
    tabs_resolve_current: () => ({ candidate: current }),
    tabs_history_visit: () => ({ history: { version: 1, entries: [] } }),
    tabs_sync_activity: ({ workspaceId }) => ({
      state: getWorkspace(collection, workspaceId).state,
    }),
    tabs_set_favorite: ({ workspaceId, threadId, favorite, candidate }) => ({
      state: changeState(workspaceId ?? "work", (state) =>
        setTabFavorite(state, threadId, favorite, candidate),
      ),
    }),
    tabs_workspace_create: ({ name }) => {
      collection = { ...addWorkspace(collection, "qa", name), revision: collection.revision + 1 };
      return {
        workspaceId: "qa",
        workspaces: workspaceInfos(collection),
        stateRevision: collection.revision,
      };
    },
    tabs_workspace_rename: ({ workspaceId, name }) => {
      collection = {
        ...renameWorkspace(collection, workspaceId, name),
        revision: collection.revision + 1,
      };
      return { workspaces: workspaceInfos(collection), stateRevision: collection.revision };
    },
    tabs_workspace_delete: ({ workspaceId }) => {
      collection = {
        ...deleteWorkspace(collection, workspaceId),
        revision: collection.revision + 1,
      };
      return { workspaces: workspaceInfos(collection), stateRevision: collection.revision };
    },
  };
  const renderOverlay = (
    overrides: Handlers = {},
    settings?: PartialRenderSlotOptions["settings"],
  ) => {
    const overlay = app.appOverlays[0];
    if (!overlay) throw new Error("Missing overlay");
    return renderSlot<{}, typeof rpcContract>(
      { ...overlay, component: ChatSurface },
      {},
      {
        settings,
        context: { projectId: "project", threadId: current.threadId },
        sidebarThreads: {
          threads: [],
          projects: [{ id: "project", name: "Project", isPersonal: false }],
        },
        rpc: { ...rpc, ...overrides },
      },
    );
  };
  const renderHomepage = (
    id: string,
    overrides: Handlers = {},
    threadId: string | null = null,
    settings?: PartialRenderSlotOptions["settings"],
  ) => {
    const section = app.homepageSections.find((section) => section.id === id);
    if (!section) throw new Error("Missing homepage section");
    return renderSlot<{ projectId: string | null }, typeof rpcContract>(
      section,
      { projectId: null },
      {
        settings,
        context: { projectId: null, threadId },
        sidebarThreads: {
          threads: [],
          projects: [{ id: "project", name: "Project", isPersonal: false }],
        },
        rpc: { ...rpc, ...overrides },
      },
    );
  };
  return {
    rpc,
    list,
    changeState,
    renderOverlay,
    renderHomepage,
    revision: () => collection.revision,
  };
}

function choose(container: HTMLElement, id: string) {
  fireEvent.keyDown(within(container).getByRole("button", { name: "Workspace" }), {
    key: "ArrowDown",
  });
  const workspace = store.getSnapshot().workspaces.find((item) => item.id === id);
  fireEvent.click(
    within(document.body).getByRole(id === "" ? "menuitem" : "menuitemradio", {
      name: workspace?.defaultName ?? workspace?.name ?? "Manage workspaces…",
    }),
  );
}

describe("workspace surfaces and visit races", () => {
  it.each([false, true])(
    "renders the native header control with host compact flag %s",
    async (compact) => {
      const fx = fixture();
      const header = app.threadHeaderActions[0];
      if (!header) throw new Error("Missing workspace header");
      const slot = renderSlot(
        header,
        { threadId: current.threadId, projectId: "project", isCompactViewport: compact },
        { rpc: fx.rpc },
      );
      const trigger = slot.getByRole("button", { name: "Workspace" });
      expect(trigger.title).toBe("Work");
      expect(trigger.querySelector(".bb-chat-tabs-workspace-label")?.textContent).toBe("Work");
      expect(
        trigger.closest(".bb-chat-tabs-workspace-switcher")?.getAttribute("data-compact"),
      ).toBe(compact ? "true" : null);
      expect(slot.container.querySelector(".bb-chat-tabs-content-row")).toBeNull();
    },
  );
  it("loads and reconnects the header catalog on a cold page with both tab strips disabled", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    vi.stubGlobal("window", frame.contentWindow);
    try {
      const fx = fixture();
      const slot = fx.renderOverlay({}, { showTabsOnDesktop: false, showTabsOnMobile: false });
      await waitFor(() =>
        expect(slot.getByRole("button", { name: "Workspace" }).title).toBe("Work"),
      );
      expect(
        slot.inspection.rpcCalls.filter((call) => call.method === "tabs_workspaces_list"),
      ).toHaveLength(1);
      await fx.rpc.tabs_workspace_rename!({ workspaceId: "work", name: "After reconnect" });
      await slot.setRealtimeConnectionState("reconnecting");
      await slot.setRealtimeConnectionState("connected");
      await waitFor(() =>
        expect(slot.getByRole("button", { name: "Workspace" }).title).toBe("After reconnect"),
      );
      expect(
        slot.inspection.rpcCalls.filter((call) => call.method === "tabs_workspaces_list"),
      ).toHaveLength(2);
      expect(slot.inspection.rpcCalls.filter((call) => call.method === "tabs_list")).toHaveLength(
        0,
      );
      expect(slot.inspection.sidebarActionCalls).toEqual([]);
    } finally {
      cleanup();
      vi.unstubAllGlobals();
      frame.remove();
    }
  });
  it("accepts creation realtime before a delayed reply without restoring the old selection or navigating", async () => {
    const fx = fixture();
    const gate = deferred<PluginRpcResult<(typeof rpcContract)["tabs_workspace_create"]>>();
    const overlay = fx.renderOverlay({ tabs_workspace_create: () => gate.promise });
    await within(overlay.container).findByRole("button", { name: "Work chat" });
    choose(overlay.container, "");
    const dialog = await within(document.body).findByRole("dialog", { name: "Workspaces" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Workspace name" }), {
      target: { value: "Late QA" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(
        overlay.inspection.rpcCalls.some((call) => call.method === "tabs_workspace_create"),
      ).toBe(true),
    );
    await act(async () => store.select("home"));
    const visit = store.getSnapshot();
    const result = await fx.rpc.tabs_workspace_create!({ name: "Late QA" });
    await overlay.emitRealtime("tabs-workspaces-changed", result);
    await act(async () => gate.resolve(result));
    expect(store.getSnapshot().workspaceId).toBe("home");
    expect(store.getSnapshot().generation).toBe(visit.generation);
    expect(store.getSnapshot().workspaces.some((item) => item.id === "qa")).toBe(true);
    expect(overlay.inspection.sidebarActionCalls).toEqual([]);
  });

  it.each(["route", "workspace", "A → B → A", "settings", "own realtime"] as const)(
    "preserves navigation ownership on workspace deletion after %s",
    async (kind) => {
      const fx = fixture();
      const gate = deferred<PluginRpcResult<(typeof rpcContract)["tabs_workspace_delete"]>>();
      const overlay = fx.renderOverlay({ tabs_workspace_delete: () => gate.promise });
      await within(overlay.container).findByRole("button", { name: "Work chat" });
      choose(overlay.container, "");
      const dialog = await within(document.body).findByRole("dialog", {
        name: "Workspaces",
      });
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete workspace: Work" }));
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
      await waitFor(() =>
        expect(
          overlay.inspection.rpcCalls.some((call) => call.method === "tabs_workspace_delete"),
        ).toBe(true),
      );
      await act(async () => {
        if (kind === "route") store.observeRoute("explicitly-opened-chat");
        if (kind === "workspace" || kind === "A → B → A") store.select("home");
        if (kind === "A → B → A") store.select("work");
        if (kind === "settings") {
          store.setWorkspacesEnabled(false);
          store.setWorkspacesEnabled(true);
        }
      });
      const result = await fx.rpc.tabs_workspace_delete!({ workspaceId: "work" });
      if (kind === "own realtime") await overlay.emitRealtime("tabs-workspaces-changed", result);
      await act(async () => gate.resolve(result));
      expect(store.getSnapshot().workspaceId).toBe("home");
      expect(store.getSnapshot().workspaces.some((item) => item.id === "work")).toBe(false);
      expect(overlay.inspection.sidebarActionCalls).toEqual(
        kind === "own realtime" ? [{ method: "open", threadId: home.threadId }] : [],
      );
    },
  );

  it("does not handle tab shortcuts or double Shift behind the workspace management dialog", async () => {
    const fx = fixture();
    fx.changeState("work", (state) =>
      openTabCandidate(state, { ...current, threadId: "second", title: "Second" }, 2),
    );
    const overlay = fx.renderOverlay();
    await within(overlay.container).findByRole("button", { name: "Second" });
    store.rememberClosed("work", { ...current, threadId: "closed", pinned: true, openedAt: 1 }, 0);
    choose(overlay.container, "");
    const dialog = await within(document.body).findByRole("dialog", { name: "Workspaces" });
    const input = within(dialog).getByRole("textbox", { name: "Workspace name" });
    for (const key of [
      { key: "Tab", ctrlKey: true },
      { key: "Tab", ctrlKey: true, shiftKey: true },
      { key: "w", ctrlKey: true },
      { key: "T", code: "KeyT", ctrlKey: true, shiftKey: true },
    ])
      expect(fireEvent.keyDown(input, key)).toBe(true);
    fireEvent.keyUp(input, { key: "Shift" });
    fireEvent.keyUp(input, { key: "Shift" });
    await act(async () => Promise.resolve());
    expect(overlay.inspection.sidebarActionCalls).toEqual([]);
    expect(
      overlay.inspection.rpcCalls.filter(
        (call) => call.method === "tabs_close" || call.method === "tabs_restore",
      ),
    ).toEqual([]);
    expect(document.querySelector(".bb-chat-tabs-list-menu")).toBeNull();
  });
  it("accepts newer sidechat activity independently of a stale tab-state snapshot without rolling back memberships", async () => {
    const fx = fixture();
    const pending = deferred<PluginRpcResult<(typeof rpcContract)["tabs_list"]>>();
    const stale = {
      ...fx.list("work"),
      sidechatActivity: { revision: 1, sourceThreadIds: [current.threadId] },
    };
    const overlay = fx.renderOverlay({ tabs_list: () => pending.promise });
    fx.changeState("work", (state) =>
      openTabCandidate(
        state,
        { threadId: "fresh-thread", projectId: "project", title: "Fresh chat" },
        10,
      ),
    );
    const fresh = fx.list("work");
    await overlay.emitRealtime("tabs-changed:work", {
      workspaceId: "work",
      state: fresh.state,
      stateRevision: fresh.stateRevision,
    });
    await within(overlay.container).findByRole("button", { name: "Fresh chat" });
    pending.resolve(stale);
    const parent = await within(overlay.container).findByRole("button", {
      name: "Work chat, nested work is running",
    });
    expect(parent.querySelector('.bb-chat-tab-working[data-nested-only="true"]')).not.toBeNull();
    expect(within(overlay.container).getByRole("button", { name: "Fresh chat" })).toBeTruthy();
    expect(overlay.inspection.sidebarActionCalls).toEqual([]);
    expect(overlay.inspection.navigateCalls).toEqual([]);
  });
  it.each(["control", "command"] as const)(
    "restores successful closes LIFO with %s + Shift + T, including a non-Latin layout",
    async (modifier) => {
      const fx = fixture();
      const second = { ...current, threadId: "second-closed", title: "Second" };
      const third = { ...current, threadId: "third-closed", title: "Third" };
      fx.changeState("work", (state) =>
        openTabCandidate(openTabCandidate(state, second, 2), third, 3),
      );
      const overlay = fx.renderOverlay();
      await within(overlay.container).findByRole("button", { name: "Third" });
      fireEvent.click(
        within(overlay.container).getByRole("button", { name: "Close tab “Second”" }),
      );
      await waitFor(() => expect(store.lastClosed("work")?.entry.threadId).toBe(second.threadId));
      fireEvent.click(within(overlay.container).getByRole("button", { name: "Close tab “Third”" }));
      await waitFor(() => expect(store.lastClosed("work")?.entry.threadId).toBe(third.threadId));
      const press = () =>
        fireEvent.keyDown(window, {
          key: "Е",
          code: "KeyT",
          shiftKey: true,
          ctrlKey: modifier === "control",
          metaKey: modifier === "command",
        });
      expect(press()).toBe(false);
      await within(overlay.container).findByRole("button", { name: "Third" });
      expect(press()).toBe(false);
      await within(overlay.container).findByRole("button", { name: "Second" });
      expect(fx.list("work").state.entries.map((entry) => entry.threadId)).toEqual([
        current.threadId,
        second.threadId,
        third.threadId,
      ]);
      expect(overlay.inspection.sidebarActionCalls).toEqual([
        { method: "open", threadId: third.threadId },
        { method: "open", threadId: second.threadId },
      ]);
      expect(store.lastClosed("work")).toBeNull();
      expect(press()).toBe(true);
    },
  );

  it("restores from New chat, skips already open/unavailable IDs, and keeps failed undo retryable", async () => {
    const fx = fixture();
    const entry = fx.list("work").state.entries[0]!;
    const already = { ...entry, threadId: "already-open" };
    fx.changeState("work", (state) => ({ ...state, entries: [already] }));
    store.rememberClosed("work", entry, 0);
    store.rememberClosed("work", { ...entry, threadId: "unavailable" }, 0);
    store.rememberClosed("work", already, 0);
    let fail = true;
    const restore = fx.rpc.tabs_restore;
    if (!restore) throw new Error("Missing restore mock");
    const overlay = app.appOverlays[0];
    if (!overlay) throw new Error("Missing overlay");
    const slot = renderSlot<{}, typeof rpcContract>(
      overlay,
      {},
      {
        context: { projectId: null, threadId: null },
        rpc: {
          ...fx.rpc,
          tabs_restore: (input) => {
            if (input.entry.threadId === "unavailable")
              return { ...fx.list("work"), status: "unavailable" };
            if (fail && input.entry.threadId === entry.threadId) throw new Error("write failed");
            return restore(input);
          },
        },
      },
    );
    fireEvent.keyDown(window, { key: "T", ctrlKey: true, shiftKey: true });
    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.filter((call) => call.method === "tabs_restore"),
      ).toHaveLength(3),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(store.lastClosed("work")?.entry).toEqual(entry);
    expect(slot.inspection.sidebarActionCalls).toEqual([]);
    fail = false;
    fireEvent.keyDown(window, { key: "T", ctrlKey: true, shiftKey: true });
    await waitFor(() =>
      expect(slot.inspection.sidebarActionCalls).toEqual([
        { method: "open", threadId: entry.threadId },
      ]),
    );
    expect(store.lastClosed("work")).toBeNull();
  });

  it("does not hijack browser chrome, repeats, unsupported modifiers or a mode with no closed tabs", async () => {
    const fx = fixture();
    const overlay = fx.renderOverlay();
    await within(overlay.container).findByRole("button", { name: "Work chat" });
    store.rememberClosed("work", { ...current, threadId: "closed", pinned: true, openedAt: 1 }, 0);
    const browser = document.createElement("div");
    browser.dataset.appBrowser = "";
    const input = document.createElement("input");
    browser.append(input);
    document.body.append(browser);
    expect(fireEvent.keyDown(input, { key: "T", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(
      fireEvent.keyDown(window, { key: "T", ctrlKey: true, shiftKey: true, repeat: true }),
    ).toBe(true);
    expect(
      fireEvent.keyDown(window, { key: "T", ctrlKey: true, shiftKey: true, altKey: true }),
    ).toBe(true);
    expect(
      fireEvent.keyDown(window, { key: "T", ctrlKey: true, metaKey: true, shiftKey: true }),
    ).toBe(true);
    choose(overlay.container, "home");
    await within(overlay.container).findByRole("button", { name: "Home chat" });
    expect(fireEvent.keyDown(window, { key: "T", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(overlay.inspection.rpcCalls.filter((call) => call.method === "tabs_restore")).toEqual(
      [],
    );
    browser.remove();
  });

  it("does not navigate a different mode after a delayed undo response", async () => {
    const fx = fixture();
    const entry = { ...current, threadId: "closed", pinned: true, openedAt: 1 };
    store.rememberClosed("work", entry, 0);
    const late = deferred<PluginRpcResult<(typeof rpcContract)["tabs_restore"]>>();
    const overlay = fx.renderOverlay({ tabs_restore: () => late.promise });
    await within(overlay.container).findByRole("button", { name: "Work chat" });
    fireEvent.keyDown(window, { key: "T", ctrlKey: true, shiftKey: true });
    choose(overlay.container, "home");
    await within(overlay.container).findByRole("button", { name: "Home chat" });
    const next = fx.changeState("work", (state) => restoreClosedTab(state, entry, 0));
    await act(async () =>
      late.resolve({ state: next, stateRevision: fx.revision(), status: "restored" }),
    );
    expect(overlay.inspection.sidebarActionCalls).toEqual([
      { method: "open", threadId: home.threadId },
    ]);
    expect(store.lastClosed("work")).toBeNull();
  });

  it("switches memberships without reopening an already visible chat", async () => {
    const fx = fixture();
    fx.changeState("home", () => openTabCandidate(createEmptyTabsState(), current, 1));
    const overlay = fx.renderOverlay();
    await within(overlay.container).findByRole("button", { name: "Work chat" });
    choose(overlay.container, "home");
    await waitFor(() => expect(store.lastActiveThreadId("home")).toBe(current.threadId));
    expect(store.getSnapshot().workspaceId).toBe("home");
    expect(store.isParkedRoute(current.threadId)).toBe(false);
    expect(overlay.inspection.sidebarActionCalls).toEqual([]);
    expect(overlay.inspection.navigateCalls).toEqual([]);
  });

  it("restores a chat from New chat even if its SDK context still names that chat", async () => {
    const fx = fixture();
    fx.changeState("home", () => openTabCandidate(createEmptyTabsState(), current, 1));
    const homepage = fx.renderHomepage("pinned-tabs", {}, current.threadId);
    await within(homepage.container).findByRole("button", { name: "Work chat. Project: Project." });
    choose(homepage.container, "home");
    await waitFor(() =>
      expect(homepage.inspection.sidebarActionCalls).toEqual([
        { method: "open", threadId: current.threadId },
      ]),
    );
  });

  it("checks multiple memberships in the tab submenu without navigating, switching mode or changing other favorites/order", async () => {
    const fx = fixture();
    const open = fx.rpc.tabs_open;
    if (!open) throw new Error("Missing open mock");
    const overlay = fx.renderOverlay({
      tabs_open: (input) => {
        expect(Object.keys(input).sort()).toEqual([
          "projectId",
          "threadId",
          "title",
          "workspaceId",
        ]);
        return open(input);
      },
    });
    const original = fx.list("work").state;
    fireEvent.contextMenu(
      await within(overlay.container).findByRole("button", { name: "Work chat" }),
    );
    const submenu = await within(document.body).findByRole("menuitem", {
      name: "Show in workspaces",
    });
    fireEvent.keyDown(submenu, { key: "ArrowRight" });
    const homeOption = await within(document.body).findByRole("menuitemcheckbox", { name: "Home" });
    expect(homeOption.getAttribute("aria-checked")).toBe("false");
    expect(
      within(document.body)
        .getByRole("menuitemcheckbox", { name: "Work" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(homeOption);
    await waitFor(() => expect(homeOption.getAttribute("aria-checked")).toBe("true"));
    expect(fx.list("home").state.entries.map((entry) => entry.threadId)).toEqual([
      home.threadId,
      current.threadId,
    ]);
    expect(fx.list("home").state.entries[1]?.pinned).toBe(true);
    const otherOption = within(document.body).getByRole("menuitemcheckbox", { name: "Other" });
    fireEvent.click(otherOption);
    await waitFor(() => expect(otherOption.getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(homeOption);
    await waitFor(() => expect(homeOption.getAttribute("aria-checked")).toBe("false"));
    expect(fx.list("work").state).toEqual(original);
    expect(fx.list("home").state.favorites?.[0]?.threadId).toBe(home.threadId);
    expect(fx.list("other").state.entries[0]?.threadId).toBe(current.threadId);
    expect(store.getSnapshot().workspaceId).toBe("work");
    expect(overlay.inspection.navigateCalls).toEqual([]);
  });

  it("refreshes open membership checkboxes for other windows and rejects a delayed older snapshot", async () => {
    const fx = fixture();
    const memberships = fx.rpc.tabs_workspace_memberships;
    if (!memberships) throw new Error("Missing memberships mock");
    const old = await memberships({ threadId: current.threadId });
    const delayed = deferred<typeof old>();
    let calls = 0;
    const overlay = fx.renderOverlay({
      tabs_workspace_memberships: (input) => (++calls === 2 ? delayed.promise : memberships(input)),
    });
    fireEvent.contextMenu(
      await within(overlay.container).findByRole("button", { name: "Work chat" }),
    );
    fireEvent.keyDown(
      await within(document.body).findByRole("menuitem", { name: "Show in workspaces" }),
      { key: "ArrowRight" },
    );
    await within(document.body).findByRole("menuitemcheckbox", { name: "Home" });
    fx.changeState("home", (state) => openTabCandidate(state, current, 10));
    await act(async () =>
      overlay.emitRealtime("tabs-workspace-memberships-changed", fx.revision()),
    );
    await waitFor(() => expect(calls).toBe(2));
    fx.changeState("other", (state) => openTabCandidate(state, current, 11));
    await act(async () =>
      overlay.emitRealtime("tabs-workspace-memberships-changed", fx.revision()),
    );
    await waitFor(() =>
      expect(
        within(document.body)
          .getByRole("menuitemcheckbox", { name: "Other" })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
    await act(async () => delayed.resolve(old));
    expect(
      within(document.body)
        .getByRole("menuitemcheckbox", { name: "Home" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      within(document.body)
        .getByRole("menuitemcheckbox", { name: "Other" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("keeps the checkbox unchanged and offers retry after a failed membership write", async () => {
    const fx = fixture();
    const response = deferred<PluginRpcResult<(typeof rpcContract)["tabs_open"]>>();
    const overlay = fx.renderOverlay({ tabs_open: () => response.promise });
    fireEvent.contextMenu(
      await within(overlay.container).findByRole("button", { name: "Work chat" }),
    );
    fireEvent.keyDown(
      await within(document.body).findByRole("menuitem", { name: "Show in workspaces" }),
      { key: "ArrowRight" },
    );
    const option = await within(document.body).findByRole("menuitemcheckbox", { name: "Home" });
    fireEvent.click(option);
    await waitFor(() => expect(option.getAttribute("aria-disabled")).toBe("true"));
    await act(async () => response.reject(new Error("Write failed")));
    expect(await within(document.body).findByRole("alert")).toHaveProperty(
      "textContent",
      "Write failed",
    );
    expect(option.getAttribute("aria-checked")).toBe("false");
    expect(option.hasAttribute("aria-disabled")).toBe(false);
    fireEvent.click(within(document.body).getByRole("menuitem", { name: "Retry" }));
    await waitFor(() => expect(within(document.body).queryByRole("alert")).toBeNull());
    expect(fx.list("home").state.entries).toHaveLength(1);
  });
  it.each(["remembered", "closed", "empty"] as const)(
    "restores %s target per mode with a first-tab or New chat fallback",
    async (kind) => {
      const fx = fixture();
      const second = { ...home, threadId: "home-second", title: "Second Home" };
      fx.changeState("home", (state) => openTabCandidate(state, second, 2));
      store.select("home");
      store.rememberActive("home", second.threadId);
      store.select("work");
      if (kind === "closed") fx.changeState("home", (state) => closeTab(state, second.threadId));
      if (kind === "empty") fx.changeState("home", () => createEmptyTabsState());
      const overlay = fx.renderOverlay();
      await within(overlay.container).findByRole("button", { name: "Work chat" });
      choose(overlay.container, "home");
      await waitFor(() =>
        expect(overlay.inspection.sidebarActionCalls).toEqual(
          kind === "empty"
            ? [{ method: "openNewThread", options: { focusPrompt: true } }]
            : [
                {
                  method: "open",
                  threadId: kind === "remembered" ? second.threadId : home.threadId,
                },
              ],
        ),
      );
      expect(
        fx.list("home").state.entries.some((entry) => entry.threadId === current.threadId),
      ).toBe(false);
      expect(store.lastActiveThreadId("home")).toBe(
        kind === "closed" ? home.threadId : second.threadId,
      );
    },
  );

  it("restores from New chat when the old overlay reports its null route after the homepage mounted", async () => {
    const fx = fixture();
    const late = deferred<PluginRpcResult<(typeof rpcContract)["tabs_list"]>>();
    const homepage = fx.renderHomepage("pinned-tabs", {
      tabs_list: (input) =>
        input?.workspaceId === "home" ? late.promise : fx.list(input?.workspaceId ?? "work"),
    });
    await within(homepage.container).findByRole("button", { name: "Work chat. Project: Project." });
    store.observeRoute(current.threadId);
    choose(homepage.container, "home");
    store.observeRoute(null);
    await act(async () => late.resolve(fx.list("home")));
    expect(homepage.inspection.sidebarActionCalls).toEqual([
      { method: "open", threadId: home.threadId },
    ]);
  });

  it.each(["switch", "navigate"] as const)(
    "ignores late restore after a newer %s",
    async (kind) => {
      const fx = fixture();
      const late = deferred<PluginRpcResult<(typeof rpcContract)["tabs_list"]>>();
      const overlay = fx.renderOverlay({
        tabs_list: (input) =>
          input?.workspaceId === "home" ? late.promise : fx.list(input?.workspaceId ?? "work"),
      });
      await within(overlay.container).findByRole("button", { name: "Work chat" });
      const restored = { ...current, threadId: "restored-work" };
      if (kind === "switch")
        fx.changeState("work", () => openTabCandidate(createEmptyTabsState(), restored, 1));
      choose(overlay.container, "home");
      if (kind === "switch") {
        choose(overlay.container, "work");
        await waitFor(() =>
          expect(overlay.inspection.sidebarActionCalls).toEqual([
            { method: "open", threadId: restored.threadId },
          ]),
        );
      } else store.observeRoute("explicitly-opened-chat");
      await act(async () => late.resolve(fx.list("home")));
      expect(overlay.inspection.sidebarActionCalls).toEqual(
        kind === "switch" ? [{ method: "open", threadId: restored.threadId }] : [],
      );
    },
  );

  it("shares selection between strip and homepage, restores one target per switch and never injects the previous chat", async () => {
    const fx = fixture();
    const overlay = fx.renderOverlay();
    const homepage = fx.renderHomepage("pinned-tabs");
    await within(overlay.container).findByRole("button", { name: "Work chat" });
    await within(homepage.container).findByRole("button", { name: "Work chat. Project: Project." });
    choose(overlay.container, "home");
    await within(overlay.container).findByRole("button", { name: "Home chat" });
    await within(homepage.container).findByRole("button", { name: "Home chat. Project: Project." });
    expect(within(homepage.container).getByRole("button", { name: "Workspace" }).title).toBe(
      "Home",
    );
    expect(within(overlay.container).queryByRole("button", { name: "Work chat" })).toBeNull();
    expect(overlay.inspection.sidebarActionCalls).toEqual([
      { method: "open", threadId: home.threadId },
    ]);
    expect(
      overlay.inspection.rpcCalls.filter((call) => call.method === "tabs_sync_activity"),
    ).toEqual([]);
    choose(homepage.container, "work");
    await within(overlay.container).findByRole("button", { name: "Work chat" });
    expect(overlay.inspection.sidebarActionCalls).toEqual([
      { method: "open", threadId: home.threadId },
    ]);
    expect(homepage.inspection.sidebarActionCalls).toEqual([
      { method: "open", threadId: current.threadId },
    ]);
  });

  it("does not inject the parked current chat after reloading an empty selected workspace", async () => {
    const fx = fixture();
    fx.changeState("home", (state) => ({ ...state, entries: [], favorites: [] }));
    const overlay = fx.renderOverlay();
    await within(overlay.container).findByRole("button", { name: "Work chat" });
    choose(overlay.container, "home");
    await act(async () => {
      await Promise.resolve();
    });
    overlay.unmount();
    const reloaded = fx.renderOverlay();
    await act(async () => {
      await Promise.resolve();
    });
    expect(within(reloaded.container).getByRole("button", { name: "Workspace" }).title).toBe(
      "Home",
    );
    expect(reloaded.inspection.rpcCalls).toContainEqual({
      method: "tabs_list",
      input: { workspaceId: "home", workflowThreadIds: [] },
    });
    expect(
      reloaded.inspection.rpcCalls.filter((call) => call.method === "tabs_sync_activity"),
    ).toEqual([]);
    expect(fx.list("home").state.entries).toEqual([]);
  });

  it("retries a cold response older than another surface's known revision instead of remaining in loading", async () => {
    const fx = fixture();
    let reads = 0;
    const overlay = fx.renderOverlay({
      tabs_list: (input) => {
        const id = input?.workspaceId ?? "work";
        reads++;
        if (reads === 1) {
          store.acceptStateRevision(id, fx.revision() + 1);
          return fx.list(id);
        }
        fx.changeState(id, (state) => state);
        return fx.list(id);
      },
    });
    await waitFor(
      () =>
        expect(within(overlay.container).getByRole("button", { name: "Work chat" })).toBeTruthy(),
      { timeout: 5000 },
    );
    expect(reads).toBe(2);
    expect(overlay.container.textContent).not.toContain("Tabs unavailable");
  });

  it.each(["snapshot", "error"] as const)(
    "ignores a late %s from the first A visit after A → B → A and does not block B behind it",
    async (outcome) => {
      const fx = fixture();
      const late = deferred<PluginRpcResult<(typeof rpcContract)["tabs_list"]>>();
      let workReads = 0;
      const overlay = fx.renderOverlay({
        tabs_list: (input) => {
          const id = input?.workspaceId ?? "work";
          if (id === "work" && ++workReads === 2) return late.promise;
          return fx.list(id);
        },
      });
      await within(overlay.container).findByRole("button", { name: "Work chat" });
      await overlay.setRealtimeConnectionState("reconnecting");
      await overlay.setRealtimeConnectionState("connected");
      await waitFor(() => expect(workReads).toBe(2));
      choose(overlay.container, "home");
      await within(overlay.container).findByRole("button", { name: "Home chat" });
      fx.changeState("work", (state) => ({
        ...state,
        entries: state.entries.map((entry) => ({
          ...entry,
          threadId: "latest-work",
          title: "Latest Work",
        })),
      }));
      choose(overlay.container, "work");
      await within(overlay.container).findByRole("button", { name: "Latest Work" });
      await act(async () => {
        if (outcome === "error") late.reject(new Error("Old Work failure"));
        else
          late.resolve({
            ...fx.list("work"),
            state: {
              version: 1,
              entries: [{ ...current, title: "Old Work snapshot", openedAt: 1, pinned: true }],
            },
          });
        await Promise.resolve();
      });
      expect(
        within(overlay.container).queryByRole("button", { name: "Old Work snapshot" }),
      ).toBeNull();
      expect(within(overlay.container).getByRole("button", { name: "Latest Work" })).toBeTruthy();
      expect(overlay.container.textContent).not.toContain("Tabs unavailable");
      expect(overlay.inspection.sidebarActionCalls).toEqual([
        { method: "open", threadId: home.threadId },
        { method: "open", threadId: "latest-work" },
      ]);
    },
  );

  it.each(["success", "error"] as const)(
    "keeps delayed favorite %s, undo cards and pending IDs out of the next workspace visit",
    async (outcome) => {
      const fx = fixture();
      const shared = { ...current, title: "Same chat", openedAt: 1, pinned: false };
      for (const id of ["work", "home"])
        fx.changeState(id, () => ({ version: 1, entries: [], favorites: [shared] }));
      const late = deferred<{ state: TabsState }>();
      const overrides: Handlers = {
        tabs_set_favorite: (input) =>
          input.workspaceId === "work"
            ? late.promise
            : {
                state: fx.changeState(input.workspaceId ?? "work", (state) =>
                  setTabFavorite(state, input.threadId, input.favorite, input.candidate),
                ),
              },
      };
      const pinned = fx.renderHomepage("pinned-tabs", overrides);
      const favorites = fx.renderHomepage("favorite-tabs", overrides);
      const remove = await within(favorites.container).findByRole("button", {
        name: "Remove from favorites: Same chat",
      });
      fireEvent.click(remove);
      expect((remove as HTMLButtonElement).disabled).toBe(true);
      choose(pinned.container, "home");
      const homeRemove = await within(favorites.container).findByRole("button", {
        name: "Remove from favorites: Same chat",
      });
      expect((homeRemove as HTMLButtonElement).disabled).toBe(false);
      await act(async () => {
        if (outcome === "error") late.reject(new Error("Old favorite failure"));
        else
          late.resolve({
            state: fx.changeState("work", (state) =>
              setTabFavorite(state, current.threadId, false),
            ),
          });
        await Promise.resolve();
      });
      expect(within(favorites.container).queryByRole("alert")).toBeNull();
      expect((homeRemove as HTMLButtonElement).disabled).toBe(false);
      choose(pinned.container, "work");
      await waitFor(() => {
        const card = within(favorites.container).queryByRole("button", {
          name: "Same chat. Project: Project.",
        });
        if (outcome === "success") expect(card).toBeNull();
        else expect(card).not.toBeNull();
      });
      expect(
        within(favorites.container).queryByRole("button", { name: "Add to favorites: Same chat" }),
      ).toBeNull();
    },
  );

  it("opens a favorite in the newly selected set but never navigates after an old set's delayed open", async () => {
    const fx = fixture();
    for (const id of ["work", "home"]) fx.changeState(id, (state) => ({ ...state, entries: [] }));
    const late = deferred<{ state: TabsState }>();
    const overrides: Handlers = {
      tabs_sync_activity: (input) =>
        input.workspaceId === "work"
          ? late.promise
          : {
              state: fx.changeState(input.workspaceId ?? "work", (state) =>
                addTabCandidates(state, input.threads, 2),
              ),
            },
    };
    const pinned = fx.renderHomepage("pinned-tabs", overrides);
    const favorites = fx.renderHomepage("favorite-tabs", overrides);
    fireEvent.click(
      await within(favorites.container).findByRole("button", {
        name: "Work chat. Project: Project.",
      }),
    );
    choose(pinned.container, "home");
    fireEvent.click(
      await within(favorites.container).findByRole("button", {
        name: "Home chat. Project: Project.",
      }),
    );
    await waitFor(() => expect(favorites.inspection.sidebarActionCalls).toHaveLength(1));
    expect(favorites.inspection.sidebarActionCalls[0]).toMatchObject({
      method: "open",
      threadId: home.threadId,
    });
    expect(fx.list("home").state.entries[0]?.pinned).toBe(false);
    await act(async () => {
      late.resolve({
        state: fx.changeState("work", (state) => addTabCandidates(state, [current], 3)),
      });
      await Promise.resolve();
    });
    expect(favorites.inspection.sidebarActionCalls).toHaveLength(1);
    expect(store.getSnapshot().workspaceId).toBe("home");
    expect(favorites.inspection.rpcCalls).toContainEqual({
      method: "tabs_sync_activity",
      input: { workspaceId: "home", threads: [home], reopen: true },
    });
  });

  it.each([
    ["Офис", "О"],
    ["👩🏽‍💻 Development", "👩🏽‍💻"],
    ["e\u0301quipe", "e\u0301"],
  ])(
    "shows the first grapheme of %s while retaining its full dropdown label and tooltip",
    async (name, initial) => {
      const fx = fixture();
      const rename = fx.rpc.tabs_workspace_rename;
      if (!rename) throw new Error("Missing rename mock");
      const result = await rename({ workspaceId: "work", name });
      store.acceptCatalog(result.workspaces, undefined, result.stateRevision);
      const overlay = fx.renderOverlay();
      await within(overlay.container).findByRole("button", { name: "Work chat" });
      const trigger = within(overlay.container).getByRole("button", { name: "Workspace" });
      expect(trigger.title).toBe(name);
      expect(trigger.querySelector(".bb-chat-tabs-workspace-label")?.textContent).toBe(name);
      expect(trigger.getAttribute("aria-description")).toBe(name);
      fireEvent.keyDown(trigger, { key: "ArrowDown" });
      expect(
        within(document.body).getByRole("menuitemradio", { name }).getAttribute("aria-checked"),
      ).toBe("true");
      fireEvent.keyDown(within(document.body).getByRole("menu", { name: "Workspace" }), {
        key: "Escape",
      });
      const badge = overlay.container.querySelector(".bb-chat-tabs-workspace-initial");
      expect(badge?.textContent).toBe(initial);
      expect(badge?.getAttribute("aria-hidden")).toBe("true");
      choose(overlay.container, "home");
      await waitFor(() =>
        expect(
          overlay.container.querySelector(".bb-chat-tabs-workspace-initial")?.textContent,
        ).toBe("H"),
      );
      expect(within(overlay.container).getByRole("button", { name: "Workspace" }).title).toBe(
        "Home",
      );
    },
  );

  it("keeps the chat list first, moves workspace to the header and toggles it without changing sets or navigating", async () => {
    const fx = fixture();
    fx.changeState("home", (state) =>
      openTabCandidate(state, { ...home, threadId: "second-home", title: "Second home" }, 2),
    );
    store.observeRoute(current.threadId);
    store.select("home");
    const settings = { enableWorkspaces: true };
    const overlay = fx.renderOverlay({}, settings);
    await within(overlay.container).findByRole("button", { name: "Home chat" });
    const row = overlay.container.querySelector(".bb-chat-tabs-content-row");
    expect(row?.firstElementChild?.className).toBe("bb-chat-tabs-list-switcher");
    expect(row?.querySelector(".bb-chat-tabs-workspace-switcher")).toBeNull();
    expect(
      overlay
        .getByTestId("workspace-thread-header")
        .querySelector(".bb-chat-tabs-workspace-switcher"),
    ).not.toBeNull();
    const Component = ChatSurface;
    const beforeHome = fx.changeState("home", (state) => state);
    const beforeWork = fx.changeState("work", (state) => state);
    settings.enableWorkspaces = false;
    overlay.rerender(<Component />);
    const chat = await within(overlay.container).findByRole("button", { name: "Work chat" });
    expect(overlay.container.querySelector(".bb-chat-tabs-workspace-switcher")).toBeNull();
    fireEvent.contextMenu(chat);
    expect(within(document.body).queryByText("Show in workspaces")).toBeNull();
    expect(within(document.body).getByText("Unpin")).toBeTruthy();
    fireEvent.keyDown(within(document.body).getByRole("menu"), { key: "Escape" });
    settings.enableWorkspaces = true;
    overlay.rerender(<Component />);
    await within(overlay.container).findByRole("button", { name: "Home chat" });
    expect(within(overlay.container).getByRole("button", { name: "Workspace" }).title).toBe("Home");
    expect(fx.changeState("home", (state) => state)).toEqual(beforeHome);
    expect(fx.changeState("work", (state) => state)).toEqual(beforeWork);
    expect(overlay.inspection.sidebarActionCalls).toEqual([]);
    expect(overlay.inspection.navigateCalls).toEqual([]);
  });

  it.each(["pinned-tabs", "favorite-tabs"])(
    "hides workspace controls on %s when disabled",
    async (id) => {
      const fx = fixture();
      store.select("home");
      const section = fx.renderHomepage(id, {}, null, { enableWorkspaces: false });
      await waitFor(() => expect(store.getSnapshot().workspaceId).toBe("work"));
      await waitFor(() =>
        expect(
          section.inspection.rpcCalls.some(
            (call) =>
              call.method === "tabs_list" &&
              (call.input as { workspaceId?: string }).workspaceId === "work",
          ),
        ).toBe(true),
      );
      expect(section.container.querySelector(".bb-chat-tabs-workspace-switcher")).toBeNull();
      expect(section.inspection.sidebarActionCalls).toEqual([]);
    },
  );

  it("supports keyboard opening, radio navigation and Escape with restored trigger focus", async () => {
    const fx = fixture();
    const overlay = fx.renderOverlay();
    await within(overlay.container).findByRole("button", { name: "Work chat" });
    const trigger = within(overlay.container).getByRole("button", { name: "Workspace" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const work = within(document.body).getByRole("menuitemradio", { name: "Work" });
    const homeOption = within(document.body).getByRole("menuitemradio", { name: "Home" });
    await waitFor(() => expect(document.activeElement).toBe(work));
    fireEvent.keyDown(work, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(homeOption));
    fireEvent.keyDown(homeOption, { key: "Enter" });
    await within(overlay.container).findByRole("button", { name: "Home chat" });
    expect(within(document.body).queryByRole("menu", { name: "Workspace" })).toBeNull();
    const currentTrigger = within(overlay.container).getByRole("button", { name: "Workspace" });
    fireEvent.keyDown(currentTrigger, { key: "ArrowDown" });
    fireEvent.keyDown(within(document.body).getByRole("menu", { name: "Workspace" }), {
      key: "Escape",
    });
    await waitFor(() => expect(document.activeElement).toBe(currentTrigger));
    expect(overlay.inspection.sidebarActionCalls).toEqual([
      { method: "open", threadId: home.threadId },
    ]);
  });

  it("opens workspace hover without stealing focus, bridges the gap, closes on leave and latches on click", async () => {
    const overlay = fixture().renderOverlay();
    const chat = await within(overlay.container).findByRole("button", { name: "Work chat" });
    const trigger = within(overlay.container).getByRole("button", { name: "Workspace" });
    const menu = () => within(document.body).queryByRole("menu", { name: "Workspace" });
    const waitPastLeave = () =>
      act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 180));
      });
    chat.focus();
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    expect(menu()).toBeNull();
    await waitFor(() => expect(menu()).not.toBeNull(), { timeout: 900 });
    expect(document.activeElement).toBe(chat);
    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
    fireEvent.pointerEnter(menu()!, { pointerType: "mouse" });
    await waitPastLeave();
    expect(menu()).not.toBeNull();
    fireEvent.pointerMove(within(menu()!).getByRole("menuitemradio", { name: "Home" }), {
      pointerType: "mouse",
    });
    expect(document.activeElement).toBe(chat);
    fireEvent.pointerLeave(menu()!, { pointerType: "mouse" });
    await waitFor(() => expect(menu()).toBeNull());
    expect(document.activeElement).toBe(chat);

    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    await waitFor(() => expect(menu()).not.toBeNull(), { timeout: 900 });
    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
    fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0 });
    fireEvent.pointerLeave(menu()!, { pointerType: "mouse" });
    await waitPastLeave();
    expect(menu()).not.toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(menu()!).getByRole("menuitemradio", { name: "Work" }),
      ),
    );
    fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0 });
    await waitFor(() => expect(menu()).toBeNull());
    expect(overlay.inspection.sidebarActionCalls).toEqual([]);
  });

  it("cancels short hover and ignores touch/pen hover while retaining tap opening", async () => {
    const overlay = fixture().renderOverlay();
    await within(overlay.container).findByRole("button", { name: "Work chat" });
    const trigger = within(overlay.container).getByRole("button", { name: "Workspace" });
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
    fireEvent.pointerEnter(trigger, { pointerType: "touch" });
    fireEvent.pointerEnter(trigger, { pointerType: "pen" });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 360));
    });
    expect(within(document.body).queryByRole("menu", { name: "Workspace" })).toBeNull();
    fireEvent.pointerDown(trigger, { pointerType: "touch", button: 0 });
    expect(within(document.body).getByRole("menu", { name: "Workspace" })).toBeTruthy();
    expect(overlay.inspection.sidebarActionCalls).toEqual([]);
  });

  it("opens management from the separated last menu item without changing workspace and restores trigger focus", async () => {
    const fx = fixture();
    const overlay = fx.renderOverlay();
    await within(overlay.container).findByRole("button", { name: "Work chat" });
    const trigger = within(overlay.container).getByRole("button", { name: "Workspace" });
    expect(overlay.container.querySelector("select")).toBeNull();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const menu = within(document.body).getByRole("menu", { name: "Workspace" });
    expect(
      within(menu)
        .getAllByRole("menuitemradio")
        .map((item) => item.getAttribute("aria-label")),
    ).toEqual(["Work", "Home", "Other"]);
    expect(within(menu).getByRole("separator")).toBeTruthy();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Manage workspaces…" }));
    const dialog = await within(document.body).findByRole("dialog", { name: "Workspaces" });
    expect(store.getSnapshot().workspaceId).toBe("work");
    expect(trigger.title).toBe("Work");
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(overlay.inspection.sidebarActionCalls).toEqual([]);
  });

  it("keeps the new-workspace draft while inline rename and deletion are cancelled", async () => {
    const fx = fixture();
    const overlay = fx.renderOverlay();
    await within(overlay.container).findByRole("button", { name: "Work chat" });
    choose(overlay.container, "");
    const dialog = await within(document.body).findByRole("dialog", { name: "Workspaces" });
    expect(dialog.querySelectorAll(".bb-chat-tabs-workspace-current")).toHaveLength(1);
    expect(
      dialog.querySelector(".bb-chat-tabs-workspace-current")?.closest("li")?.textContent,
    ).toContain("Work");
    const draft = within(dialog).getByRole("textbox", { name: "Workspace name" });
    fireEvent.change(draft, { target: { value: "New draft" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename workspace: Home" }));
    const rename = within(dialog).getByRole("textbox", { name: "Rename workspace: Home" });
    expect(document.activeElement).toBe(rename);
    fireEvent.change(rename, { target: { value: "Cancelled name" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(within(dialog).getByRole("button", { name: "Rename workspace: Home" })).toBeTruthy();
    expect((draft as HTMLInputElement).value).toBe("New draft");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete workspace: Home" }));
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect((draft as HTMLInputElement).value).toBe("New draft");
    expect(
      overlay.inspection.rpcCalls.filter((call) =>
        /^tabs_workspace_(create|rename|delete)$/u.test(call.method),
      ),
    ).toEqual([]);
    expect(store.getSnapshot().workspaceId).toBe("work");
  });

  it("supports create/rename, validates names, confirms deletion and never archives chats", async () => {
    const fx = fixture();
    const overlay = fx.renderOverlay();
    await within(overlay.container).findByRole("button", { name: "Work chat" });
    choose(overlay.container, "");
    const dialog = await within(document.body).findByRole("dialog", { name: "Workspaces" });
    for (const button of within(dialog).getAllByRole("button", { name: /^Delete workspace:/ })) {
      expect(button.querySelector('[data-icon="Trash2"]')).not.toBeNull();
      expect(button.querySelector('[data-icon="Zap"]')).toBeNull();
    }
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Workspace name" }), {
      target: { value: "WORK" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(within(dialog).getByRole("alert").textContent).toContain("already exists");
    expect(
      overlay.inspection.rpcCalls.filter((call) => call.method === "tabs_workspace_create"),
    ).toEqual([]);
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Workspace name" }), {
      target: { value: "QA" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await within(dialog).findByRole("button", { name: "Rename workspace: QA" });
    expect(dialog.isConnected).toBe(true);
    expect(store.getSnapshot().workspaceId).toBe("work");
    expect(
      overlay.container
        .querySelector('.bb-chat-tab[data-active="true"] .bb-chat-tab-select')
        ?.getAttribute("aria-label"),
    ).toBe("Work chat");
    expect(
      (within(dialog).getByRole("textbox", { name: "Workspace name" }) as HTMLInputElement).value,
    ).toBe("");
    expect(overlay.inspection.sidebarActionCalls).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename workspace: QA" }));
    const renameInput = within(dialog).getByRole("textbox", { name: "Rename workspace: QA" });
    expect(renameInput.closest("li")?.getAttribute("data-editing")).toBe("true");
    expect(within(dialog).getByRole("textbox", { name: "Workspace name" })).toBeTruthy();
    fireEvent.change(renameInput, {
      target: { value: "Renamed" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await within(dialog).findByRole("button", { name: "Delete workspace: Renamed" });
    expect(store.getSnapshot().workspaceId).toBe("work");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete workspace: Renamed" }));
    expect(
      within(dialog)
        .getByRole("group", { name: "Delete workspace" })
        .closest("li")
        ?.getAttribute("data-confirming"),
    ).toBe("true");
    expect(within(dialog).getByRole("button", { name: "Delete workspace: Work" })).toBeTruthy();
    expect(within(dialog).getByText(/Chats and shared history will stay/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(store.getSnapshot().workspaces).toHaveLength(4);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete workspace: Renamed" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(store.getSnapshot().workspaces).toHaveLength(3));
    expect(store.getSnapshot().workspaceId).toBe("work");
    expect(overlay.inspection.rpcCalls).toContainEqual({
      method: "tabs_workspace_delete",
      input: { workspaceId: "qa" },
    });
    expect(overlay.inspection.sidebarActionCalls).toEqual([]);
  });

  it("scopes realtime content, shares metadata without selection changes, and falls back only if the selected mode is deleted", async () => {
    const fx = fixture();
    const overlay = fx.renderOverlay();
    await within(overlay.container).findByRole("button", { name: "Work chat" });
    choose(overlay.container, "home");
    await within(overlay.container).findByRole("button", { name: "Home chat" });
    await overlay.emitRealtime("tabs-changed", { version: 1, entries: [] });
    expect(within(overlay.container).getByRole("button", { name: "Home chat" })).toBeTruthy();
    await overlay.emitRealtime("tabs-changed:home", {
      workspaceId: "work",
      stateRevision: fx.revision() + 1000,
      state: { version: 1, entries: [] },
    });
    expect(within(overlay.container).getByRole("button", { name: "Home chat" })).toBeTruthy();
    const synced = fx.changeState("home", (state) => ({
      ...state,
      entries: [{ ...home, title: "Synced Home", openedAt: 1, pinned: true }],
    }));
    await overlay.emitRealtime("tabs-changed:home", {
      workspaceId: "home",
      stateRevision: fx.revision(),
      state: synced,
    });
    expect(within(overlay.container).getByRole("button", { name: "Synced Home" })).toBeTruthy();
    await overlay.emitRealtime("tabs-changed:home", {
      workspaceId: "home",
      stateRevision: fx.revision() - 1,
      state: { version: 1, entries: [] },
    });
    expect(within(overlay.container).getByRole("button", { name: "Synced Home" })).toBeTruthy();
    const remove = fx.rpc.tabs_workspace_delete;
    if (!remove) throw new Error("Missing delete mock");
    const firstCatalog = await remove({ workspaceId: "other" });
    await overlay.emitRealtime("tabs-workspaces-changed", firstCatalog);
    expect(store.getSnapshot().workspaceId).toBe("home");
    await overlay.emitRealtime("tabs-workspaces-changed", await remove({ workspaceId: "home" }));
    await within(overlay.container).findByRole("button", { name: "Work chat" });
    await overlay.emitRealtime("tabs-workspaces-changed", firstCatalog);
    expect(store.getSnapshot().workspaces.map((item) => item.id)).toEqual(["work"]);
    expect(store.getSnapshot().workspaceId).toBe("work");
    expect(overlay.inspection.sidebarActionCalls).toEqual([
      { method: "open", threadId: home.threadId },
    ]);
  });
});
