import type { TabCandidate } from "./tabs-model";

/** Отдельная от preview/pinned история посещённых разговоров. */
export const TAB_HISTORY_VERSION = 1 as const;
export const MAX_TAB_HISTORY_ENTRIES = 100;
export const TABS_HISTORY_CHANGED_CHANNEL = "tabs-history-changed";

/**
 * Недоступный чат остаётся в истории как tombstone, но больше не открывается.
 * Отсутствие значения означает доступный чат: это совместимо с уже сохранённой
 * V1-историей до появления признака архивирования/удаления.
 */
export const TAB_HISTORY_UNAVAILABLE_REASONS = [
  "archived",
  "deleted",
] as const;

export type TabHistoryUnavailableReason =
  (typeof TAB_HISTORY_UNAVAILABLE_REASONS)[number];

/** `null` означает, что чат снова доступен. */
export type TabHistoryAvailability = TabHistoryUnavailableReason | null;

export interface TabHistoryEntry extends TabCandidate {
  /** Время последнего перехода в этот чат. */
  visitedAt: number;
  /** Причина, по которой запись нельзя открыть, если она известна. */
  unavailableReason?: TabHistoryUnavailableReason;
}

export interface TabHistoryState {
  version: typeof TAB_HISTORY_VERSION;
  entries: TabHistoryEntry[];
}

const EMPTY_HISTORY: TabHistoryState = {
  version: TAB_HISTORY_VERSION,
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

function normalizeCandidate(value: TabCandidate): TabCandidate | null {
  const threadId = readNonEmptyString(value.threadId);
  const projectId = readNonEmptyString(value.projectId);
  const title = readNonEmptyString(value.title);
  if (threadId === null || projectId === null || title === null) return null;
  return { threadId, projectId, title };
}

function readUnavailableReason(value: unknown): TabHistoryUnavailableReason | null {
  return TAB_HISTORY_UNAVAILABLE_REASONS.includes(
    value as TabHistoryUnavailableReason,
  )
    ? (value as TabHistoryUnavailableReason)
    : null;
}

function readEntry(value: unknown): TabHistoryEntry | null {
  if (!isRecord(value)) return null;
  const candidate = normalizeCandidate({
    threadId: value.threadId,
    projectId: value.projectId,
    title: value.title,
  } as TabCandidate);
  if (candidate === null) return null;
  const unavailableReason = readUnavailableReason(value.unavailableReason);
  return {
    ...candidate,
    visitedAt: readTimestamp(value.visitedAt),
    ...(unavailableReason === null ? {} : { unavailableReason }),
  };
}

function trim(entries: readonly TabHistoryEntry[]): TabHistoryEntry[] {
  return [...entries].slice(0, MAX_TAB_HISTORY_ENTRIES);
}

export function createEmptyTabHistory(): TabHistoryState {
  return { ...EMPTY_HISTORY, entries: [] };
}

/**
 * История всегда уникальна по threadId и отсортирована от последнего визита
 * к старому. Стабильный sort удерживает исходный порядок при равных time.
 */
export function normalizeTabHistory(value: unknown): TabHistoryState {
  if (!isRecord(value) || value.version !== TAB_HISTORY_VERSION) {
    return createEmptyTabHistory();
  }
  if (!Array.isArray(value.entries)) return createEmptyTabHistory();

  const entriesById = new Map<string, TabHistoryEntry>();
  for (const rawEntry of value.entries) {
    const entry = readEntry(rawEntry);
    if (entry === null) continue;
    const previous = entriesById.get(entry.threadId);
    if (previous === undefined || entry.visitedAt >= previous.visitedAt) {
      entriesById.set(entry.threadId, entry);
    }
  }

  return {
    version: TAB_HISTORY_VERSION,
    entries: trim(
      [...entriesById.values()].sort(
        (left, right) => right.visitedAt - left.visitedAt,
      ),
    ),
  };
}

/** Перемещает посещённый чат в начало истории и обновляет его метаданные. */
export function visitTabHistory(
  state: TabHistoryState,
  candidate: TabCandidate,
  now: number,
): TabHistoryState {
  const normalized = normalizeCandidate(candidate);
  const current = normalizeTabHistory(state);
  if (normalized === null) return current;

  return {
    version: TAB_HISTORY_VERSION,
    entries: trim([
      // Визит возможен только для открываемого чата, поэтому прежний
      // tombstone намеренно снимается вместе с обновлением metadata.
      { ...normalized, visitedAt: readTimestamp(now) },
      ...current.entries.filter((entry) => entry.threadId !== normalized.threadId),
    ]),
  };
}

/**
 * Помечает уже существующие history-записи как архивные/удалённые либо снова
 * доступные. Не создаёт новую запись: lifecycle-событие не является визитом.
 */
export function setTabHistoryAvailability(
  state: TabHistoryState,
  availabilityByThreadId: ReadonlyMap<string, TabHistoryAvailability>,
): TabHistoryState {
  const current = normalizeTabHistory(state);
  let changed = false;
  const entries = current.entries.map((entry) => {
    const availability = availabilityByThreadId.get(entry.threadId);
    if (availability === undefined) return entry;

    if (availability === null) {
      if (entry.unavailableReason === undefined) return entry;
      changed = true;
      const { unavailableReason: _unavailableReason, ...availableEntry } = entry;
      return availableEntry;
    }

    if (entry.unavailableReason === availability) return entry;
    changed = true;
    return { ...entry, unavailableReason: availability };
  });

  return changed ? { version: TAB_HISTORY_VERSION, entries } : current;
}

export function tabHistoriesEqual(
  left: TabHistoryState,
  right: TabHistoryState,
): boolean {
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
      entry.visitedAt === other.visitedAt &&
      entry.unavailableReason === other.unavailableReason
    );
  });
}
