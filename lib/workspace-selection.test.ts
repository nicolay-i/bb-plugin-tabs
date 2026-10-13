import { describe, expect, it, vi } from "vitest";
import { createWorkspaceSelectionStore } from "./workspace-selection";

const infos = [
  { id: "work", name: "Work", defaultName: "Work" },
  { id: "home", name: "Home", defaultName: "Home" },
  { id: "other", name: "Other", defaultName: "Other" },
];
function storage(saved: string | null = null) {
  const values = new Map<string, string>();
  if (saved !== null) values.set("bb.tabs.workspace.v1", saved);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, next: string) => {
      values.set(key, next);
    },
  };
}

describe("window-local workspace selection", () => {
  it("tracks explicit selection/settings intent without counting catalog fallback or rename", () => {
    const store = createWorkspaceSelectionStore(null);
    store.acceptCatalog(infos);
    const before = store.getSelectionRevision();
    store.select("work");
    store.acceptCatalog(infos.map((info) => ({ ...info, name: `${info.name}!` })));
    expect(store.getSelectionRevision()).toBe(before);
    store.select("home");
    store.select("work");
    expect(store.getSelectionRevision()).toBe(before + 2);
    store.acceptCatalog(infos.filter((info) => info.id !== "work"));
    expect(store.getSnapshot().workspaceId).toBe("home");
    expect(store.getSelectionRevision()).toBe(before + 2);
    store.setWorkspacesEnabled(false);
    store.setWorkspacesEnabled(false);
    store.select("other");
    store.setWorkspacesEnabled(true);
    expect(store.getSelectionRevision()).toBe(before + 4);
  });
  it("uses a single default set while disabled, retains the window preference through reload and preserves visit guards", () => {
    const session = storage("home");
    const a = createWorkspaceSelectionStore(session);
    a.acceptCatalog(infos);
    a.observeRoute("home-thread");
    const before = a.getSnapshot();
    a.setWorkspacesEnabled(false);
    expect(a.getSnapshot().workspaceId).toBe("work");
    expect(a.getSnapshot().generation).toBe(before.generation + 1);
    expect(a.isParkedRoute("home-thread")).toBe(true);
    a.select("other");
    expect(a.getSnapshot().workspaceId).toBe("work");
    expect(a.getSnapshot().workspaces).toEqual(infos);
    const reloaded = createWorkspaceSelectionStore(session);
    reloaded.setWorkspacesEnabled(false);
    reloaded.observeRoute("home-thread");
    reloaded.acceptCatalog(infos);
    expect(reloaded.getSnapshot().workspaceId).toBe("work");
    expect(reloaded.isParkedRoute("home-thread")).toBe(true);
    reloaded.setWorkspacesEnabled(true);
    expect(reloaded.getSnapshot().workspaceId).toBe("home");
    a.setWorkspacesEnabled(true);
    expect(a.getSnapshot().workspaceId).toBe("home");
  });

  it("falls back to the first remaining set when Work or the preferred set is deleted while disabled", () => {
    const a = createWorkspaceSelectionStore(storage("other"));
    const b = createWorkspaceSelectionStore(storage("home"));
    for (const store of [a, b]) {
      store.acceptCatalog(infos);
      store.setWorkspacesEnabled(false);
      store.acceptCatalog(infos.filter((item) => item.id !== "work"));
      expect(store.getSnapshot().workspaceId).toBe("home");
    }
    a.setWorkspacesEnabled(true);
    expect(a.getSnapshot().workspaceId).toBe("other");
    b.acceptCatalog(infos.filter((item) => item.id === "other"));
    b.setWorkspacesEnabled(true);
    expect(b.getSnapshot().workspaceId).toBe("other");
  });
  it("orders undo by the close action even when network replies finish out of order", () => {
    const store = createWorkspaceSelectionStore(null);
    store.acceptCatalog(infos);
    const entry = {
      threadId: "first",
      projectId: "project",
      title: "Chat",
      pinned: true,
      openedAt: 1,
    };
    const first = store.nextCloseSequence();
    const second = store.nextCloseSequence();
    store.rememberClosed("work", { ...entry, threadId: "second" }, 1, second);
    store.rememberClosed("work", entry, 0, first);
    expect(store.lastClosed("work")?.entry.threadId).toBe("second");
    store.rememberClosed("work", { ...entry, title: "New" }, 0, store.nextCloseSequence());
    store.rememberClosed("work", entry, 0, first);
    expect(store.lastClosed("work")?.entry.title).toBe("New");
    store.forgetClosed("work", entry.threadId, first);
    expect(store.lastClosed("work")?.entry.title).toBe("New");
  });

  it("keeps a bounded closed-tab stack per window/mode, persists undo and prunes deleted modes", () => {
    const session = storage();
    const store = createWorkspaceSelectionStore(session);
    store.acceptCatalog(infos);
    const entry = {
      threadId: "first",
      projectId: "project",
      title: "Chat",
      pinned: true,
      openedAt: 1,
    };
    store.rememberClosed("work", entry, 0);
    store.rememberClosed("home", { ...entry, threadId: "home-chat" }, 1);
    store.rememberClosed("work", { ...entry, threadId: "second" }, 1);
    expect(store.lastClosed("work")?.entry.threadId).toBe("second");
    store.forgetClosed("work", "second");
    expect(store.lastClosed("work")).toMatchObject({ workspaceId: "work", entry, index: 0 });
    const reloaded = createWorkspaceSelectionStore(session);
    reloaded.acceptCatalog(infos);
    expect(reloaded.lastClosed("home")?.entry.threadId).toBe("home-chat");
    expect(createWorkspaceSelectionStore(null).lastClosed("work")).toBeNull();
    reloaded.acceptCatalog(infos.filter((item) => item.id !== "home"));
    expect(reloaded.lastClosed("home")).toBeNull();
    for (let i = 0; i < 105; i++)
      reloaded.rememberClosed("work", { ...entry, threadId: `closed-${i}` }, 0);
    expect(JSON.parse(session.getItem("bb.tabs.closed.v1") ?? "[]")).toHaveLength(100);
    const corrupt = storage();
    corrupt.setItem("bb.tabs.closed.v1", "not JSON");
    expect(createWorkspaceSelectionStore(corrupt).lastClosed("work")).toBeNull();
  });

  it("persists independent last-active tabs per mode/window, survives rename and forgets deleted modes", () => {
    const session = storage();
    const a = createWorkspaceSelectionStore(session);
    const b = createWorkspaceSelectionStore(storage());
    a.acceptCatalog(infos);
    b.acceptCatalog(infos);
    a.rememberActive("work", "work-second");
    a.select("home");
    a.rememberActive("home", "home-second");
    const restored = createWorkspaceSelectionStore(session);
    restored.acceptCatalog(
      infos.map((info) => (info.id === "home" ? { id: "home", name: "House" } : info)),
    );
    expect(restored.lastActiveThreadId("work")).toBe("work-second");
    expect(restored.lastActiveThreadId("home")).toBe("home-second");
    expect(b.lastActiveThreadId("work")).toBeNull();
    restored.acceptCatalog(infos.filter((info) => info.id !== "home"));
    expect(restored.lastActiveThreadId("home")).toBeNull();
    restored.rememberActive("other", "wrong-scope");
    expect(restored.lastActiveThreadId("other")).toBeNull();
  });
  it("tracks real route transitions separately from workspace generations and un-parks only the intended route", () => {
    const store = createWorkspaceSelectionStore(null);
    store.acceptCatalog(infos);
    store.observeRoute("work-chat");
    const before = store.getRouteRevision();
    store.select("home");
    expect(store.getRouteRevision()).toBe(before);
    store.unparkRoute("home-chat");
    expect(store.isParkedRoute("work-chat")).toBe(true);
    store.observeRoute("other-chat");
    store.observeRoute("work-chat");
    expect(store.getRouteRevision()).toBe(before + 2);
    store.select("work");
    store.unparkRoute("work-chat");
    expect(store.isParkedRoute("work-chat")).toBe(false);
  });
  it("shares one observable selection within a window and restores it after reload", () => {
    const session = storage();
    const store = createWorkspaceSelectionStore(session);
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribe = store.subscribe(first);
    store.subscribe(second);
    expect(store.getSnapshot().workspaceId).toBeNull();
    store.acceptCatalog(infos);
    store.select("home");
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);
    unsubscribe();
    store.select("other");
    expect(first).toHaveBeenCalledTimes(2);
    const reloaded = createWorkspaceSelectionStore(session);
    reloaded.acceptCatalog(infos);
    expect(reloaded.getSnapshot().workspaceId).toBe("other");
  });

  it("does not propagate selection between windows while sharing catalog changes", () => {
    const a = createWorkspaceSelectionStore(storage());
    const b = createWorkspaceSelectionStore(storage());
    a.acceptCatalog(infos);
    b.acceptCatalog(infos);
    a.select("home");
    expect(b.getSnapshot().workspaceId).toBe("work");
    const renamed = infos.map((item) =>
      item.id === "home" ? { id: "home", name: "House" } : item,
    );
    a.acceptCatalog(renamed);
    b.acceptCatalog(renamed);
    expect(a.getSnapshot().workspaceId).toBe("home");
    expect(b.getSnapshot().workspaceId).toBe("work");
    const withoutHome = renamed.filter((item) => item.id !== "home");
    a.acceptCatalog(withoutHome);
    b.acceptCatalog(withoutHome);
    expect(a.getSnapshot().workspaceId).toBe("work");
    expect(b.getSnapshot().generation).toBe(1);
  });

  it("falls back from missing saved IDs and works without session storage", () => {
    const missing = createWorkspaceSelectionStore(storage("deleted"));
    missing.acceptCatalog(infos.slice(1));
    expect(missing.getSnapshot().workspaceId).toBe("home");
    const denied = createWorkspaceSelectionStore({
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    denied.acceptCatalog(infos);
    denied.select("other");
    expect(denied.getSnapshot().workspaceId).toBe("other");
    const absent = createWorkspaceSelectionStore(null);
    absent.acceptCatalog(infos);
    absent.select("home");
    expect(absent.getSnapshot().workspaceId).toBe("home");
  });

  it("preserves a parked route after reload and clears it after explicit navigation", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    const store = createWorkspaceSelectionStore(storage);
    store.acceptCatalog(infos);
    store.observeRoute("work-thread");
    store.select("home");
    expect(store.isParkedRoute("work-thread")).toBe(true);
    const reloaded = createWorkspaceSelectionStore(storage);
    reloaded.acceptCatalog(infos);
    reloaded.observeRoute("work-thread");
    expect(reloaded.isParkedRoute("work-thread")).toBe(true);
    reloaded.observeRoute("other-thread");
    expect(reloaded.isParkedRoute("work-thread")).toBe(false);
    expect(reloaded.getSnapshot().workspaceId).toBe("home");
  });

  it("rejects older state and metadata revisions without sharing content clocks between modes", () => {
    const store = createWorkspaceSelectionStore(null);
    store.acceptCatalog(infos, undefined, 10);
    expect(store.acceptStateRevision("work", 20)).toBe(true);
    expect(store.acceptStateRevision("home", 2)).toBe(true);
    expect(store.acceptStateRevision("work", 19)).toBe(false);
    expect(store.acceptStateRevision("work", NaN)).toBe(false);
    store.acceptCatalog(
      infos.filter((item) => item.id !== "home"),
      undefined,
      22,
    );
    store.acceptCatalog(infos, undefined, 21);
    expect(store.getSnapshot().workspaces.map((item) => item.id)).toEqual(["work", "other"]);
  });

  it("gives A → B → A distinct visits and ignores stale metadata after rename/delete", () => {
    const store = createWorkspaceSelectionStore(null);
    store.acceptCatalog(infos);
    const initial = store.getSnapshot();
    store.select("home");
    store.select("work");
    expect(store.getSnapshot().workspaceId).toBe(initial.workspaceId);
    expect(store.getSnapshot().generation).toBe(initial.generation + 2);
    store.acceptCatalog(infos.filter((item) => item.id !== "home"));
    store.acceptCatalog(infos, initial.revision);
    expect(store.getSnapshot().workspaces.map((item) => item.id)).toEqual(["work", "other"]);
    expect(() => store.select("home")).toThrow("no longer exists");
    const revision = store.getSnapshot().revision;
    store.acceptCatalog([]);
    store.acceptCatalog([{ id: "bad", name: "" }]);
    store.acceptCatalog([infos[0], infos[0]]);
    expect(store.getSnapshot().revision).toBe(revision);
  });
});
