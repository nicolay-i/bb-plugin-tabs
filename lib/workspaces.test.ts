import { describe, expect, it } from "vitest";
import translations from "./plugin-translations.json";
import {
  closeTabs,
  createEmptyTabsState,
  openTabCandidate,
  setTabFavorite,
  setTabPinned,
} from "./tabs-model";
import {
  addWorkspace,
  closeWorkspaceThreads,
  createInitialWorkspaces,
  deleteWorkspace,
  getWorkspace,
  renameWorkspace,
  workspaceCollectionSchema,
  workspaceInfos,
} from "./workspaces";

const candidate = {
  threadId: "thread",
  projectId: "project",
  title: "Chat",
  parentThreadId: "parent",
};

describe("workspace model", () => {
  it("migrates pins, preview, favorites and closed guards into Work without modifying legacy state", () => {
    const pinned = setTabPinned(
      openTabCandidate(createEmptyTabsState(), candidate, 10),
      candidate.threadId,
      true,
    );
    const state = setTabPinned(
      openTabCandidate(
        setTabFavorite(pinned, candidate.threadId, true),
        { ...candidate, threadId: "preview" },
        20,
      ),
      "preview",
      false,
    );
    expect(state.entries.map((entry) => entry.pinned)).toEqual([true, false]);
    const original = structuredClone(state);
    const collection = createInitialWorkspaces(state, ["closed", "closed", null, "", 123]);
    expect(getWorkspace(collection).state).toEqual(original);
    expect(getWorkspace(collection).closedThreadIds).toEqual(["closed"]);
    expect(
      collection.workspaces
        .slice(1)
        .every((item) => item.state.entries.length === 0 && item.closedThreadIds.length === 0),
    ).toBe(true);
    expect(state).toEqual(original);
    expect(workspaceCollectionSchema.parse(collection)).toEqual(collection);
    expect(workspaceInfos(collection).map((item) => item.defaultName)).toEqual([
      "Work",
      "Home",
      "Other",
    ]);
  });

  it("retains guards for a full 100-tab and 100-favorite lifecycle removal", () => {
    const collection = createInitialWorkspaces(undefined, ["older"]);
    const work = getWorkspace(collection);
    const entries = Array.from({ length: 100 }, (_, index) => ({
      ...candidate,
      threadId: `tab-${index}`,
      openedAt: index,
      pinned: index !== 99,
    }));
    const favorites = entries.map((entry, index) => ({ ...entry, threadId: `favorite-${index}` }));
    const removed = closeWorkspaceThreads(
      { ...work, state: { ...work.state, entries, favorites } },
      [...entries, ...favorites].map((entry) => entry.threadId),
    );
    expect(removed.state.entries).toEqual([]);
    expect(removed.state.favorites).toEqual([]);
    expect(removed.closedThreadIds).toHaveLength(200);
    expect(removed.closedThreadIds).toContain("tab-0");
    expect(removed.closedThreadIds).toContain("tab-99");
    expect(
      workspaceCollectionSchema.parse({
        ...collection,
        workspaces: collection.workspaces.map((item) => (item.id === work.id ? removed : item)),
      }),
    ).toBeTruthy();
  });

  it("renames by stable ID, trims names, rejects duplicates and enforces Unicode name limits", () => {
    const initial = createInitialWorkspaces(undefined, undefined);
    const renamed = renameWorkspace(initial, "work", "  Office  ");
    expect(getWorkspace(renamed).name).toBe("Office");
    expect(getWorkspace(renamed).defaultName).toBeUndefined();
    expect(getWorkspace(initial).name).toBe("Work");
    expect(() => addWorkspace(renamed, "new", " office ")).toThrow("already exists");
    expect(() => renameWorkspace(renamed, "home", "OFFICE")).toThrow("already exists");
    expect(() => addWorkspace(initial, "new", " ")).toThrow("1–80");
    expect(() => addWorkspace(initial, "new", "😀".repeat(81))).toThrow("1–80");
    expect(
      workspaceCollectionSchema.parse(addWorkspace(initial, "new", "😀".repeat(80))).workspaces,
    ).toHaveLength(4);
    expect(() => renameWorkspace(initial, "missing", "Name")).toThrow("no longer exists");
  });

  it("reserves translated default labels while keeping renamed custom labels untranslated", () => {
    const initial = createInitialWorkspaces(undefined, undefined);
    for (const dictionary of Object.values(translations)) {
      for (const key of ["Work", "Home", "Other"] as const)
        expect(() => addWorkspace(initial, "new", dictionary[key])).toThrow("already exists");
    }
    const renamed = renameWorkspace(initial, "work", "Работа");
    expect(getWorkspace(renamed).name).toBe("Работа");
    expect(getWorkspace(renamed).defaultName).toBeUndefined();
  });

  it("allows 20 modes and refuses to delete the last one or silently replace a missing ID", () => {
    let collection = createInitialWorkspaces(undefined, undefined);
    for (let index = 3; index < 20; index++)
      collection = addWorkspace(collection, `qa-${index}`, `Mode ${index}`);
    expect(workspaceCollectionSchema.parse(collection).workspaces).toHaveLength(20);
    expect(() => addWorkspace(collection, "extra", "Extra")).toThrow("limit");
    expect(() => getWorkspace(collection, "missing")).toThrow("no longer exists");
    const remaining = deleteWorkspace(
      deleteWorkspace(createInitialWorkspaces(undefined, undefined), "work"),
      "home",
    );
    expect(() => deleteWorkspace(remaining, "other")).toThrow("at least one");
    expect(() => getWorkspace(remaining)).toThrow("no longer exists");
  });

  it("rejects duplicate IDs/names and emits JSON-safe state when archiving a chat without favorites", () => {
    const initial = createInitialWorkspaces(undefined, undefined);
    expect(
      workspaceCollectionSchema.safeParse({
        ...initial,
        workspaces: [initial.workspaces[0], initial.workspaces[0]],
      }).success,
    ).toBe(false);
    const state = closeTabs(
      openTabCandidate(createEmptyTabsState(), candidate, 1),
      [candidate.threadId],
      true,
    );
    expect(Object.hasOwn(state, "favorites")).toBe(false);
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });
});
