/**
 * Детерминированная модель верхних вкладок.
 *
 * Состояние содержит закреплённые вкладки и не более одной предварительной
 * (preview) вкладки. Preview — это запись с `pinned: false`: следующий новый
 * активный чат заменяет её, как временная вкладка в VS Code.
 *
 * Модуль не зависит от BB или React: сервер использует его для записи,
 * а фронтенд — для безопасного отображения состояния, пришедшего по RPC.
 */

export const TAB_STATE_VERSION = 1 as const;
export const MAX_TAB_ENTRIES = 100;
export const TABS_CHANGED_CHANNEL = "tabs-changed";

export interface TabEntry {
  threadId: string;
  projectId: string;
  /** Последний известный заголовок: нужен, пока sidebar ещё загружается. */
  title: string;
  /** `false` обозначает единственную временную preview-вкладку. */
  pinned: boolean;
  /** Момент первого добавления в верхнюю полосу. */
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

/** Возвращает пустое состояние без разделяемого изменяемого массива. */
export function createEmptyTabsState(): TabsState {
  return { ...EMPTY_STATE, entries: [] };
}

/**
 * Оставляет самый новый preview. Это также миграция прежней V1-модели,
 * в которой могло накопиться несколько незакреплённых вкладок.
 */
function keepLatestPreview(entries: readonly TabEntry[]): TabEntry[] {
  let previewIndex = -1;
  let previewOpenedAt = -1;

  entries.forEach((entry, index) => {
    if (entry.pinned) return;
    // При одинаковом времени выбираем запись, расположенную позже: она была
    // последним кандидатом в серверской очереди.
    if (entry.openedAt >= previewOpenedAt) {
      previewOpenedAt = entry.openedAt;
      previewIndex = index;
    }
  });

  return entries.filter((entry, index) => entry.pinned || index === previewIndex);
}

/**
 * Приводит не доверенное KV/RPC-значение к V1, дедуплицируя одинаковые чаты.
 * Более поздняя запись побеждает по метаданным, но pin сохраняется, если он
 * присутствовал хотя бы в одной повреждённой дублирующей записи.
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
 * Синхронизирует временную preview-вкладку с последним кандидатом.
 *
 * Если чат уже закреплён, обновляются только его метаданные: выбор такого
 * чата не должен вытеснять незакреплённую preview-вкладку. Новый чат заменяет
 * прежнюю preview, но не затрагивает закреплённые записи.
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
 * Явно добавляет чат как закреплённую вкладку. Если это была preview-вкладка,
 * она становится обычной и больше не будет заменена следующим активным чатом.
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

  // В публичном RPC оставляем обратимый unpin для совместимости, но сохраняем
  // инвариант одной preview: раззакрепляемый чат заменяет старую preview.
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
 * Перемещает закреплённую вкладку перед или после другой закреплённой вкладки
 * в общей горизонтальной последовательности. Проект не ограничивает ручной
 * порядок: имя проекта остаётся только метаданными/hover-подсказкой. Preview
 * намеренно не участвует, потому что она временная и всегда одна.
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

/** Убирает несколько вкладок одним переходом состояния. */
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
 * Держим KV заведомо маленьким. При обычном переполнении удаляются только
 * самые старые незакреплённые вкладки; pin имеет приоритет.
 */
function trimEntries(entries: readonly TabEntry[]): TabEntry[] {
  if (entries.length <= MAX_TAB_ENTRIES) return [...entries];

  const excess = entries.length - MAX_TAB_ENTRIES;
  const removable = entries
    .filter((entry) => !entry.pinned)
    .sort((left, right) => left.openedAt - right.openedAt)
    .slice(0, excess)
    .map((entry) => entry.threadId);

  // Обычный путь никогда не создаёт больше 100 pinned entries. Эта ветка
  // нужна только для повреждённого/устаревшего KV: жёсткий лимит важнее
  // сохранения всех pin, иначе состояние не пройдёт RPC-схему и не загрузится.
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
