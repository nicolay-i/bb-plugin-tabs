/**
 * A deterministic model for the top chat tabs.
 *
 * State contains pinned tabs and no more than one temporary preview tab. A
 * preview is an entry with `pinned: false`; the next new active chat replaces
 * it, like VS Code's preview tab.
 *
 * This module does not depend on BB or React: the server writes the state and
 * the frontend safely renders state received through RPC.
 */

export const TAB_STATE_VERSION = 1 as const;
export const MAX_TAB_ENTRIES = 100;
export const TABS_CHANGED_CHANNEL = "tabs-changed";

export interface TabEntry {
  threadId: string;
  projectId: string;
  /** The latest known title, used while the sidebar is still loading. */
  title: string;
  /** `false` identifies the one temporary preview tab. */
  pinned: boolean;
  /** The time of first insertion into the top strip. */
  openedAt: number;
}

export interface TabsState {
  version: typeof TAB_STATE_VERSION;
  entries: TabEntry[];
}

export type TabMovePosition = "before" | "after";

export interface TabCandidate {
  threadId: string;
  projectId: string;
  title: string;
}

const EMPTY_STATE: TabsState = {
  version: TAB_STATE_VERSION,
  entries: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function readTimestamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function readEntry(value: unknown): TabEntry | null {
  if (!isRecord(value)) return null;
  const threadId = readNonEmptyString(value.threadId);
  const projectId = readNonEmptyString(value.projectId);
  const title = readNonEmptyString(value.title);
  if (threadId === null || projectId === null || title === null) return null;
  return {
    threadId,
    projectId,
    title,
    pinned: value.pinned === true,
    openedAt: readTimestamp(value.openedAt),
  };
}

function readCandidate(value: TabCandidate): TabCandidate | null {
  const threadId = readNonEmptyString(value.threadId);
  const projectId = readNonEmptyString(value.projectId);
  const title = readNonEmptyString(value.title);
  if (threadId === null || projectId === null || title === null) return null;
  return { threadId, projectId, title };
}

/** Returns empty state without a shared mutable entries array. */
export function createEmptyTabsState(): TabsState {
  return { ...EMPTY_STATE, entries: [] };
}

/**
 * Keeps the newest preview. This also migrates old V1 state that accumulated
 * more than one unpinned tab.
 */
function keepLatestPreview(entries: readonly TabEntry[]): TabEntry[] {
  let previewIndex = -1;
  let previewOpenedAt = -1;

  entries.forEach((entry, index) => {
    if (entry.pinned) return;
    // Equal timestamps choose the later entry because it was the latest
    // candidate in the server queue.
    if (entry.openedAt >= previewOpenedAt) {
      previewOpenedAt = entry.openedAt;
      previewIndex = index;
    }
  });

  return entries.filter((entry, index) => entry.pinned || index === previewIndex);
}

/**
 * Coerces an untrusted KV/RPC value to V1 while deduplicating identical chats.
 * Later entries win their metadata, while a pin survives if at least one
 * corrupt duplicate was pinned.
 */
export function normalizeTabsState(value: unknown): TabsState {
  if (!isRecord(value) || value.version !== TAB_STATE_VERSION) {
    return createEmptyTabsState();
  }
  if (!Array.isArray(value.entries)) return createEmptyTabsState();

  const byThreadId = new Map<string, TabEntry>();
  for (const rawEntry of value.entries) {
    const entry = readEntry(rawEntry);
    if (entry === null) continue;
    const previous = byThreadId.get(entry.threadId);
    byThreadId.set(entry.threadId, {
      ...entry,
      pinned: entry.pinned || previous?.pinned === true,
      openedAt:
        previous === undefined ? entry.openedAt : Math.min(previous.openedAt, entry.openedAt),
    });
  }

  return {
    version: TAB_STATE_VERSION,
    entries: trimEntries(keepLatestPreview([...byThreadId.values()])),
  };
}

function latestCandidate(candidates: readonly TabCandidate[]): TabCandidate | null {
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (candidate === undefined) continue;
    const normalized = readCandidate(candidate);
    if (normalized !== null) return normalized;
  }
  return null;
}

/**
 * Syncs the temporary preview tab with the latest candidate.
 *
 * If the chat is already pinned, only its metadata changes; selecting it must
 * not evict an unpinned preview. A new chat replaces the old preview without
 * affecting pinned entries.
 */
export function addTabCandidates(
  state: TabsState,
  candidates: readonly TabCandidate[],
  now: number,
): TabsState {
  const current = normalizeTabsState(state);
  const candidate = latestCandidate(candidates);
  if (candidate === null) return current;

  const existingIndex = current.entries.findIndex(
    (entry) => entry.threadId === candidate.threadId,
  );
  if (existingIndex !== -1) {
    const entries = current.entries.map((entry, index) =>
      index === existingIndex
        ? { ...entry, projectId: candidate.projectId, title: candidate.title }
        : entry,
    );
    return { version: TAB_STATE_VERSION, entries };
  }

  return {
    version: TAB_STATE_VERSION,
    entries: trimEntries([
      ...current.entries.filter((entry) => entry.pinned),
      { ...candidate, pinned: false, openedAt: now },
    ]),
  };
}

/**
 * Explicitly adds a chat as a pinned tab. If it was the preview tab, it becomes
 * ordinary and will no longer be replaced by the next active chat.
 */
export function openTabCandidate(
  state: TabsState,
  candidate: TabCandidate,
  now: number,
): TabsState {
  const current = normalizeTabsState(state);
  const normalized = readCandidate(candidate);
  if (normalized === null) return current;

  const existingIndex = current.entries.findIndex(
    (entry) => entry.threadId === normalized.threadId,
  );
  if (existingIndex !== -1) {
    const entries = current.entries.map((entry, index) =>
      index === existingIndex
        ? {
            ...entry,
            projectId: normalized.projectId,
            title: normalized.title,
            pinned: true,
          }
        : entry,
    );
    return { version: TAB_STATE_VERSION, entries };
  }

  return {
    version: TAB_STATE_VERSION,
    entries: trimEntries([
      ...current.entries,
      { ...normalized, pinned: true, openedAt: now },
    ]),
  };
}

export function setTabPinned(
  state: TabsState,
  threadId: string,
  pinned: boolean,
): TabsState {
  const current = normalizeTabsState(state);
  const target = current.entries.find((entry) => entry.threadId === threadId);
  if (target === undefined || target.pinned === pinned) return current;

  if (pinned) {
    return {
      version: TAB_STATE_VERSION,
      entries: current.entries.map((entry) =>
        entry.threadId === threadId ? { ...entry, pinned: true } : entry,
      ),
    };
  }

  // Preserve reversible unpinning in the public RPC for compatibility, while
  // preserving the one-preview invariant: the unpinned chat replaces preview.
  return {
    version: TAB_STATE_VERSION,
    entries: [
      ...current.entries.filter(
        (entry) => entry.pinned && entry.threadId !== threadId,
      ),
      { ...target, pinned: false },
    ],
  };
}

/**
 * Moves a pinned tab before or after another pinned tab in the one shared
 * horizontal sequence. A project never constrains the manual order; its name
 * is metadata and a hover hint only. Preview is deliberately excluded because
 * it is temporary and there can be only one.
 */
export function movePinnedTab(
  state: TabsState,
  sourceThreadId: string,
  targetThreadId: string,
  position: TabMovePosition,
): TabsState {
  const current = normalizeTabsState(state);
  if (sourceThreadId === targetThreadId) return current;

  const source = current.entries.find((entry) => entry.threadId === sourceThreadId);
  const target = current.entries.find((entry) => entry.threadId === targetThreadId);
  if (
    source === undefined ||
    target === undefined ||
    !source.pinned ||
    !target.pinned
  ) {
    return current;
  }

  const pinnedTabs = current.entries.filter((entry) => entry.pinned);
  const sourceIndex = pinnedTabs.findIndex(
    (entry) => entry.threadId === sourceThreadId,
  );
  const targetIndex = pinnedTabs.findIndex(
    (entry) => entry.threadId === targetThreadId,
  );
  if (sourceIndex === -1 || targetIndex === -1) return current;

  const orderedPins = [...pinnedTabs];
  const [moved] = orderedPins.splice(sourceIndex, 1);
  if (moved === undefined) return current;
  const nextTargetIndex = orderedPins.findIndex(
    (entry) => entry.threadId === targetThreadId,
  );
  if (nextTargetIndex === -1) return current;
  orderedPins.splice(
    nextTargetIndex + (position === "after" ? 1 : 0),
    0,
    moved,
  );

  let pinIndex = 0;
  return {
    version: TAB_STATE_VERSION,
    entries: current.entries.map((entry) => {
      if (!entry.pinned) return entry;
      const replacement = orderedPins[pinIndex];
      pinIndex += 1;
      return replacement ?? entry;
    }),
  };
}

export function closeTab(state: TabsState, threadId: string): TabsState {
  return closeTabs(state, [threadId]);
}

/** Removes several tabs in one state transition. */
export function closeTabs(
  state: TabsState,
  threadIds: Iterable<string>,
): TabsState {
  const current = normalizeTabsState(state);
  const closingIds = new Set(threadIds);
  if (closingIds.size === 0) return current;
  const entries = current.entries.filter((entry) => !closingIds.has(entry.threadId));
  return entries.length === current.entries.length
    ? current
    : { version: TAB_STATE_VERSION, entries };
}

export function tabsStatesEqual(left: TabsState, right: TabsState): boolean {
  if (left.version !== right.version || left.entries.length !== right.entries.length) {
    return false;
  }
  return left.entries.every((entry, index) => {
    const other = right.entries[index];
    return (
      other !== undefined &&
      entry.threadId === other.threadId &&
      entry.projectId === other.projectId &&
      entry.title === other.title &&
      entry.pinned === other.pinned &&
      entry.openedAt === other.openedAt
    );
  });
}

/**
 * Keeps the KV deliberately small. Normal overflow removes only the oldest
 * unpinned tabs; pins take priority.
 */
function trimEntries(entries: readonly TabEntry[]): TabEntry[] {
  if (entries.length <= MAX_TAB_ENTRIES) return [...entries];

  const excess = entries.length - MAX_TAB_ENTRIES;
  const removable = entries
    .filter((entry) => !entry.pinned)
    .sort((left, right) => left.openedAt - right.openedAt)
    .slice(0, excess)
    .map((entry) => entry.threadId);

  // The normal path never creates more than 100 pins. This branch only serves
  // corrupt or stale KV; the strict limit is more important than retaining all
  // pins, otherwise state cannot satisfy the RPC schema and load at all.
  if (removable.length < excess) {
    removable.push(
      ...entries
        .filter((entry) => entry.pinned)
        .sort((left, right) => left.openedAt - right.openedAt)
        .slice(0, excess - removable.length)
        .map((entry) => entry.threadId),
    );
  }

  const removed = new Set(removable);
  return entries.filter((entry) => !removed.has(entry.threadId));
}
