import { useLayoutEffect, useSyncExternalStore } from "react";
import { z } from "zod";
import { tabCandidateSchema, tabEntrySchema, type TabEntry } from "./tabs-model";
import { DEFAULT_WORKSPACE_ID, workspaceInfoSchema, type WorkspaceInfo } from "./workspaces";

const SELECTION_KEY = "bb.tabs.workspace.v1";
const PERSISTED_SELECTION_KEY = "bb.tabs.workspace.last.v1";
const PARKED_ROUTE_KEY = "bb.tabs.workspace.parked.v1";
const ACTIVE_TABS_KEY = "bb.tabs.workspace.active.v1";
const CLOSED_TABS_KEY = "bb.tabs.closed.v1";
const closedTabsSchema = z
  .array(
    z
      .object({
        workspaceId: workspaceInfoSchema.shape.id,
        entry: tabEntrySchema,
        index: z.number().int().min(0).max(99),
        sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
      })
      .strict(),
  )
  .max(100);
const parkedRouteSchema = workspaceInfoSchema
  .pick({ id: true })
  .extend({ threadId: tabCandidateSchema.shape.threadId });
const infosSchema = workspaceInfoSchema.array().min(1).max(20);

type SelectionStorage = Pick<Storage, "getItem" | "setItem">;
export interface WorkspaceSelection {
  workspaceId: string | null;
  generation: number;
  revision: number;
  workspaces: readonly WorkspaceInfo[];
}

/** One store per window; generation distinguishes A → B → A visits as well. */
export function createWorkspaceSelectionStore(
  storage: SelectionStorage | null,
  persistentStorage: SelectionStorage | null = storage,
) {
  let saved: string | null = null;
  let parkedRoute: ReturnType<typeof parkedRouteSchema.parse> | null = null;
  let currentThreadId: string | null = null;
  let routeRevision = 0;
  let selectionRevision = 0;
  const activeTabs = new Map<string, string>();
  let closedTabs: z.infer<typeof closedTabsSchema> = [];
  const persistClosedTabs = () => {
    try {
      storage?.setItem(CLOSED_TABS_KEY, JSON.stringify(closedTabs));
    } catch {
      /* Memory fallback. */
    }
  };
  try {
    const raw = storage?.getItem(CLOSED_TABS_KEY);
    if (raw) {
      const parsed = closedTabsSchema.safeParse(JSON.parse(raw));
      if (parsed.success) closedTabs = parsed.data;
    }
  } catch {
    /* Ignore damaged undo metadata without losing selection. */
  }
  closedTabs = closedTabs.map((item, index) => ({ ...item, sequence: item.sequence ?? index + 1 }));
  let closeSequence = Math.max(0, ...closedTabs.map((item) => item.sequence ?? 0));
  const persistActiveTabs = () => {
    try {
      storage?.setItem(
        ACTIVE_TABS_KEY,
        JSON.stringify([...activeTabs].map(([id, threadId]) => ({ id, threadId }))),
      );
    } catch {
      /* Memory fallback. */
    }
  };
  try {
    const rawActive = storage?.getItem(ACTIVE_TABS_KEY);
    if (rawActive) {
      const parsed = parkedRouteSchema.array().max(20).safeParse(JSON.parse(rawActive));
      if (parsed.success) for (const item of parsed.data) activeTabs.set(item.id, item.threadId);
    }
  } catch {
    /* Ignore damaged active-tab metadata; selection remains independently readable. */
  }
  try {
    saved =
      storage?.getItem(SELECTION_KEY)?.trim() ||
      (persistentStorage !== storage
        ? persistentStorage?.getItem(PERSISTED_SELECTION_KEY)?.trim()
        : null) ||
      null;
    const raw = storage?.getItem(PARKED_ROUTE_KEY);
    if (raw) {
      const parsed = parkedRouteSchema.safeParse(JSON.parse(raw));
      if (parsed.success) parkedRoute = parsed.data;
    }
  } catch {
    /* Memory fallback. */
  }
  if (saved !== null && saved.length > 200) saved = null;
  let snapshot: WorkspaceSelection = {
    workspaceId: saved,
    generation: 0,
    revision: 0,
    workspaces: [],
  };
  let workspacesEnabled = true;
  let preferredWorkspaceId = saved;
  const singleWorkspaceId = (workspaces = snapshot.workspaces) =>
    workspaces.find((item) => item.id === DEFAULT_WORKSPACE_ID)?.id ?? workspaces[0]?.id ?? null;
  const listeners = new Set<() => void>();
  const stateRevisions = new Map<string, number>();
  let newestCatalogRevision = -1;
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const persist = (explicitSelection = false) => {
    const id = workspacesEnabled
      ? snapshot.workspaceId
      : (preferredWorkspaceId ?? snapshot.workspaceId);
    if (id === null) return;
    const targets =
      explicitSelection && persistentStorage !== storage
        ? [[storage, SELECTION_KEY] as const, [persistentStorage, PERSISTED_SELECTION_KEY] as const]
        : [[storage, SELECTION_KEY] as const];
    for (const [target, key] of targets) {
      try {
        target?.setItem(key, id);
      } catch {
        /* Keep the in-memory selection. */
      }
    }
  };
  const parkRoute = (workspaceId: string | null) => {
    parkedRoute =
      workspaceId !== null && currentThreadId !== null
        ? { id: workspaceId, threadId: currentThreadId }
        : null;
    try {
      storage?.setItem(PARKED_ROUTE_KEY, JSON.stringify(parkedRoute));
    } catch {
      /* Memory fallback. */
    }
  };
  return {
    getSnapshot: () => snapshot,
    getRouteRevision: () => routeRevision,
    // Explicit intent only: a delete's own catalog fallback must not cancel its navigation.
    getSelectionRevision: () => selectionRevision,
    nextCloseSequence: () => ++closeSequence,
    lastClosed(workspaceId: string) {
      return closedTabs.filter((item) => item.workspaceId === workspaceId).at(-1) ?? null;
    },
    forgetClosed(workspaceId: string, threadId: string, sequence?: number) {
      closedTabs = closedTabs.filter(
        (item) =>
          item.workspaceId !== workspaceId ||
          item.entry.threadId !== threadId ||
          (sequence !== undefined && item.sequence !== sequence),
      );
      persistClosedTabs();
    },
    rememberClosed(
      workspaceId: string,
      entry: TabEntry,
      index: number,
      sequence = ++closeSequence,
    ) {
      if (!snapshot.workspaces.some((item) => item.id === workspaceId)) return;
      if (
        closedTabs.some(
          (item) =>
            item.workspaceId === workspaceId &&
            item.entry.threadId === entry.threadId &&
            (item.sequence ?? 0) > sequence,
        )
      )
        return;
      const parsed = closedTabsSchema.element.safeParse({ workspaceId, entry, index, sequence });
      if (!parsed.success) return;
      closedTabs = [
        ...closedTabs.filter(
          (item) => item.workspaceId !== workspaceId || item.entry.threadId !== entry.threadId,
        ),
        parsed.data,
      ]
        .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
        .slice(-100);
      persistClosedTabs();
    },
    lastActiveThreadId: (workspaceId: string) => activeTabs.get(workspaceId) ?? null,
    rememberActive(workspaceId: string, threadId: string) {
      if (
        snapshot.workspaceId !== workspaceId ||
        !tabCandidateSchema.shape.threadId.safeParse(threadId).success
      )
        return;
      if (activeTabs.get(workspaceId) !== threadId) {
        activeTabs.set(workspaceId, threadId);
        persistActiveTabs();
      }
    },
    unparkRoute(threadId: string | null) {
      if (currentThreadId === threadId) parkRoute(null);
    },
    observeRoute(threadId: string | null) {
      if (currentThreadId !== threadId) routeRevision++;
      currentThreadId = threadId;
      if (
        parkedRoute !== null &&
        (parkedRoute.id !== snapshot.workspaceId || parkedRoute.threadId !== threadId)
      )
        parkRoute(null);
    },
    isParkedRoute(threadId: string) {
      return parkedRoute?.id === snapshot.workspaceId && parkedRoute.threadId === threadId;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setWorkspacesEnabled(enabled: boolean) {
      if (workspacesEnabled === enabled) return;
      selectionRevision++;
      if (!enabled) preferredWorkspaceId = snapshot.workspaceId;
      workspacesEnabled = enabled;
      const workspaceId =
        enabled && snapshot.workspaces.some((item) => item.id === preferredWorkspaceId)
          ? preferredWorkspaceId
          : singleWorkspaceId();
      parkRoute(workspaceId);
      snapshot = { ...snapshot, workspaceId, generation: snapshot.generation + 1 };
      persist();
      notify();
    },
    select(workspaceId: string) {
      if (!workspacesEnabled) return;
      if (!snapshot.workspaces.some((item) => item.id === workspaceId))
        throw new Error("Workspace no longer exists.");
      if (snapshot.workspaceId === workspaceId) return;
      selectionRevision++;
      parkRoute(workspaceId);
      snapshot = { ...snapshot, workspaceId, generation: snapshot.generation + 1 };
      persist(true);
      notify();
    },
    acceptStateRevision(workspaceId: string, revision?: number) {
      if (revision === undefined) return true;
      if (!Number.isSafeInteger(revision) || revision < (stateRevisions.get(workspaceId) ?? 0))
        return false;
      stateRevisions.set(workspaceId, revision);
      return true;
    },
    acceptCatalog(payload: unknown, expectedRevision?: number, serverRevision?: number) {
      if (expectedRevision !== undefined && expectedRevision !== snapshot.revision) return;
      if (
        serverRevision !== undefined &&
        (!Number.isSafeInteger(serverRevision) ||
          serverRevision < 0 ||
          serverRevision < newestCatalogRevision)
      )
        return;
      const parsed = infosSchema.safeParse(payload);
      if (
        !parsed.success ||
        new Set(parsed.data.map((item) => item.id)).size !== parsed.data.length
      )
        return;
      if (serverRevision !== undefined) newestCatalogRevision = serverRevision;
      const workspaces = parsed.data;
      try {
        const lastSelected = persistentStorage?.getItem(PERSISTED_SELECTION_KEY);
        if (lastSelected && !workspaces.some((item) => item.id === lastSelected)) {
          persistentStorage?.setItem(PERSISTED_SELECTION_KEY, singleWorkspaceId(workspaces)!);
        }
      } catch {
        /* Keep the window selection if persistent storage is unavailable. */
      }
      for (const id of stateRevisions.keys()) {
        if (!workspaces.some((item) => item.id === id)) stateRevisions.delete(id);
      }
      let activeTabsChanged = false;
      for (const id of activeTabs.keys()) {
        if (!workspaces.some((item) => item.id === id)) {
          activeTabs.delete(id);
          activeTabsChanged = true;
        }
      }
      if (activeTabsChanged) persistActiveTabs();
      const retainedClosed = closedTabs.filter((item) =>
        workspaces.some((workspace) => workspace.id === item.workspaceId),
      );
      if (retainedClosed.length !== closedTabs.length) {
        closedTabs = retainedClosed;
        persistClosedTabs();
      }
      const workspaceId =
        workspacesEnabled && workspaces.some((item) => item.id === snapshot.workspaceId)
          ? snapshot.workspaceId
          : workspacesEnabled
            ? workspaces[0]!.id
            : singleWorkspaceId(workspaces);
      if (
        workspaceId === snapshot.workspaceId &&
        JSON.stringify(workspaces) === JSON.stringify(snapshot.workspaces)
      )
        return;
      if (
        workspaceId !== snapshot.workspaceId &&
        (snapshot.workspaceId !== null || !workspacesEnabled)
      )
        parkRoute(workspaceId);
      snapshot = {
        workspaceId,
        workspaces,
        revision: snapshot.revision + 1,
        generation: snapshot.generation + (workspaceId === snapshot.workspaceId ? 0 : 1),
      };
      persist();
      notify();
    },
  };
}

const stores = new WeakMap<Window, ReturnType<typeof createWorkspaceSelectionStore>>();
export function workspaceSelectionStore(target: Window = window) {
  let store = stores.get(target);
  if (store === undefined) {
    let storage: SelectionStorage | null = null;
    let persistentStorage: SelectionStorage | null = null;
    try {
      storage = target.sessionStorage;
    } catch {
      /* Private/embedded windows can deny storage. */
    }
    try {
      persistentStorage = target.localStorage;
    } catch {
      /* Private/embedded windows can deny storage. */
    }
    store = createWorkspaceSelectionStore(storage, persistentStorage);
    stores.set(target, store);
  }
  return store;
}

export function useWorkspaceSelection(enabled = true) {
  const store = workspaceSelectionStore();
  useLayoutEffect(() => store.setWorkspacesEnabled(enabled), [store, enabled]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
