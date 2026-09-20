import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { toast } from "sonner";
import {
  definePluginApp,
  experimental_useSidebarThreadActions,
  experimental_useSidebarThreads,
  useBbContext,
  useRealtime,
  useSettings,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type {
  PluginHomepageSectionProps,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { chatStatusFor } from "./lib/chat-status";
import {
  createEmptyTabHistory,
  normalizeTabHistory,
  tabHistoriesEqual,
  TABS_HISTORY_CHANGED_CHANNEL,
  type TabHistoryState,
  type TabHistoryUnavailableReason,
} from "./lib/tab-history";
import {
  normalizeTabsState,
  tabsStatesEqual,
  TABS_CHANGED_CHANNEL,
  type TabCandidate,
  type TabEntry,
  type TabMovePosition,
  type TabsState,
} from "./lib/tabs-model";
import {
  subscribeToDesktopBrowserViewFocus,
  subscribeToDesktopCloseWindowRequest,
} from "./lib/desktop-close-request";
import { copyTextToClipboard } from "./lib/clipboard";
import { consumeHorizontalWheel } from "./lib/horizontal-wheel";
import { cycleTab, type TabCycleDirection } from "./lib/tab-cycle";
import { threadLinkUrl } from "./lib/thread-link";
import {
  buildThreadWorkIndex,
  hasNestedThreadWork,
  hasThreadTreeWork,
  rootThreadFor,
  type ThreadWorkIndex,
} from "./lib/thread-work";
import {
  normalizeTabTitle,
  RenameTabDialog,
  TabActionsContextMenu,
  type RenameTabTarget,
} from "./components/tab-actions";
import { PinnedTabsList } from "./components/pinned-tabs-list";
import { Icon } from "./components/ui/icon";
import "./tabs.css";

function candidateForThread(thread: PluginSidebarThread): TabCandidate {
  return {
    threadId: thread.id,
    projectId: thread.projectId,
    title: thread.title?.trim() || thread.titleFallback?.trim() || "Без названия",
  };
}

function candidateKey(candidate: TabCandidate | null): string {
  return candidate === null
    ? ""
    : `${candidate.threadId}\u0000${candidate.projectId}\u0000${candidate.title}`;
}

function latestWorkingCandidate(
  threads: readonly PluginSidebarThread[],
  workIndex: ThreadWorkIndex,
): TabCandidate | null {
  let latest: PluginSidebarThread | null = null;
  for (const thread of threads) {
    if (!workIndex.directlyWorkingThreadIds.has(thread.id)) continue;
    // При равном времени список sidebar уже упорядочен по свежести, поэтому
    // последняя запись считается более новым кандидатом.
    if (latest === null || thread.updatedAt >= latest.updatedAt) latest = thread;
  }
  // Workflow живёт в дочернем чате, но preview и active marker относятся к
  // корневому разговору, который пользователь видит в полосе вкладок.
  return latest === null ? null : candidateForThread(rootThreadFor(latest, workIndex));
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function unavailableHistoryLabel(
  reason: TabHistoryUnavailableReason,
): "В архиве" | "Удалён" {
  return reason === "archived" ? "В архиве" : "Удалён";
}

function isCloseCurrentTabShortcut(event: KeyboardEvent): boolean {
  return (
    event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.repeat &&
    event.key.toLowerCase() === "w"
  );
}

function isCyclePluginTabsShortcut(event: KeyboardEvent): boolean {
  return (
    event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.repeat &&
    event.key === "Tab"
  );
}

function isBrowserChromeKeyboardTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest("[data-app-browser]") !== null
  );
}

const COMPACT_TAB_LAYOUT_MEDIA_QUERY =
  "(max-width: 767px), (pointer: coarse)";

/** Держит HTML drag-and-drop desktop-only, как и CSS touch-компоновку. */
function useCompactTabLayout(): boolean {
  const [isCompact, setIsCompact] = useState(() => {
    if (typeof window.matchMedia !== "function") return false;
    return window.matchMedia(COMPACT_TAB_LAYOUT_MEDIA_QUERY).matches;
  });

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mediaQuery = window.matchMedia(COMPACT_TAB_LAYOUT_MEDIA_QUERY);
    const update = () => setIsCompact(mediaQuery.matches);
    update();
    mediaQuery.addEventListener("change", update);
    return () => mediaQuery.removeEventListener("change", update);
  }, []);

  return isCompact;
}

/* Durable workflow — лишь fallback к live sidebar/realtime, а не повод
 * опрашивать сервер несколько раз в секунду. */
const ACTIVE_WORKFLOW_REVALIDATION_MS = 15_000;
const IDLE_WORKFLOW_REVALIDATION_MS = 30_000;
const HISTORY_MENU_PAGE_SIZE = 8;
const HISTORY_MORE_HOVER_DELAY_MS = 1_000;

interface TabsListRequest {
  key: string;
  workflowThreadIds: string[];
}

interface ActivitySyncRequest {
  key: string;
  threads: TabCandidate[];
}

interface HistoryVisitRequest {
  candidate: TabCandidate;
  key: string;
}

function canonicalThreadIds(threadIds: Iterable<string>): string[] {
  return [...new Set(threadIds)].sort();
}

function workflowRequestKey(threadIds: readonly string[]): string {
  return threadIds.join("\u0000");
}

function activityRequestKey(threads: readonly TabCandidate[]): string {
  return threads.map(candidateKey).join("\u0001");
}

function historyStartsWithCandidate(
  history: TabHistoryState,
  candidate: TabCandidate,
): boolean {
  const first = history.entries[0];
  return (
    first !== undefined &&
    first.threadId === candidate.threadId &&
    first.projectId === candidate.projectId &&
    first.title === candidate.title
  );
}

function stateContainsCandidate(
  state: TabsState | null,
  candidate: TabCandidate,
): boolean {
  return (
    state?.entries.some(
      (entry) =>
        entry.threadId === candidate.threadId &&
        entry.projectId === candidate.projectId &&
        entry.title === candidate.title,
    ) ?? false
  );
}

function documentIsVisible(): boolean {
  return typeof document === "undefined" || document.hidden !== true;
}

function useDocumentVisibility(): boolean {
  const [visible, setVisible] = useState(documentIsVisible);

  useEffect(() => {
    const update = () => setVisible(documentIsVisible());
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  return visible;
}

function useTabsState(enabled = true) {
  const rpc = useRpc<typeof rpcContract>();
  // `useRpc()` не обязан сохранять object identity. Держим живой client в ref,
  // чтобы эффекты initial refresh не перезапускались после каждого рендера.
  const rpcRef = useRef(rpc);
  const enabledRef = useRef(enabled);
  rpcRef.current = rpc;
  enabledRef.current = enabled;
  const [state, setState] = useState<TabsState | null>(null);
  const stateRef = useRef<TabsState | null>(state);
  stateRef.current = state;
  const [history, setHistory] = useState<TabHistoryState>(
    createEmptyTabHistory,
  );
  const historyRef = useRef(history);
  historyRef.current = history;
  const [activeWorkflowThreadIds, setActiveWorkflowThreadIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const refreshInFlightKeyRef = useRef<string | null>(null);
  const queuedRefreshRef = useRef<TabsListRequest | null>(null);
  const activitySyncInFlightRef = useRef<Promise<void> | null>(null);
  const activitySyncInFlightKeyRef = useRef<string | null>(null);
  const queuedActivitySyncRef = useRef<ActivitySyncRequest | null>(null);
  const lastSyncedActivityKeyRef = useRef<string | null>(null);
  const historyVisitInFlightRef = useRef<Promise<void> | null>(null);
  const historyVisitInFlightKeyRef = useRef<string | null>(null);
  const queuedHistoryVisitRef = useRef<HistoryVisitRequest | null>(null);
  const lastRecordedHistoryKeyRef = useRef<string | null>(null);

  const acceptState = useCallback((next: TabsState) => {
    const normalized = normalizeTabsState(next);
    stateRef.current = normalized;
    setState((previous) =>
      previous !== null && tabsStatesEqual(previous, normalized)
        ? previous
        : normalized,
    );
    setError(null);
  }, []);

  const acceptHistory = useCallback((next: TabHistoryState) => {
    const normalized = normalizeTabHistory(next);
    historyRef.current = normalized;
    setHistory((previous) =>
      tabHistoriesEqual(previous, normalized) ? previous : normalized,
    );
  }, []);

  const acceptWorkflowActivity = useCallback(
    (threadIds: readonly string[] | undefined) => {
      const next = new Set(threadIds ?? []);
      setActiveWorkflowThreadIds((previous) => {
        if (
          previous.size === next.size &&
          [...previous].every((threadId) => next.has(threadId))
        ) {
          return previous;
        }
        return next;
      });
    },
    [],
  );

  /**
   * В одну JS-сессию не уходит несколько параллельных `tabs_list`: одинаковый
   * запрос присоединяется к in-flight promise, а изменившийся вход хранит
   * только самый свежий trailing request.
   */
  const refresh = useCallback(
    (workflowThreadIds: readonly string[] = []): Promise<void> => {
      if (!enabledRef.current) return Promise.resolve();
      const canonicalIds = canonicalThreadIds(workflowThreadIds);
      const request: TabsListRequest = {
        key: workflowRequestKey(canonicalIds),
        workflowThreadIds: canonicalIds,
      };
      const inFlight = refreshInFlightRef.current;
      if (inFlight !== null) {
        if (
          refreshInFlightKeyRef.current === request.key ||
          queuedRefreshRef.current?.key === request.key
        ) {
          return inFlight;
        }
        queuedRefreshRef.current = request;
        return inFlight;
      }

      const drain = async () => {
        let next: TabsListRequest | null = request;
        while (next !== null) {
          if (!enabledRef.current) {
            queuedRefreshRef.current = null;
            break;
          }
          refreshInFlightKeyRef.current = next.key;
          try {
            const result = await rpcRef.current.call(
              "tabs_list",
              next.workflowThreadIds.length === 0
                ? null
                : { workflowThreadIds: next.workflowThreadIds },
            );
            acceptState(result.state);
            acceptWorkflowActivity(result.activeWorkflowThreadIds);
            if (result.history !== undefined) acceptHistory(result.history);
          } catch (cause) {
            setError(errorMessage(cause));
          }

          const queued = queuedRefreshRef.current;
          queuedRefreshRef.current = null;
          next = queued !== null && queued.key !== next.key ? queued : null;
        }
      };

      const operation = drain();
      refreshInFlightRef.current = operation;
      const clear = () => {
        if (refreshInFlightRef.current !== operation) return;
        refreshInFlightRef.current = null;
        refreshInFlightKeyRef.current = null;
      };
      void operation.then(clear, clear);
      return operation;
    },
    [acceptHistory, acceptState, acceptWorkflowActivity],
  );

  // Initial read один раз при активной видимой поверхности. Возврат из
  // background обрабатывает workflow scheduler ниже уже с актуальным input.
  useEffect(() => {
    if (!enabled || !documentIsVisible()) return;
    void refresh();
  }, [enabled, refresh]);

  useRealtime(TABS_CHANGED_CHANNEL, (payload) => {
    if (!enabled) return;
    acceptState(normalizeTabsState(payload));
  });

  useRealtime(TABS_HISTORY_CHANGED_CHANNEL, (payload) => {
    if (!enabled) return;
    acceptHistory(normalizeTabHistory(payload));
  });

  /**
   * `tabs_sync_activity` — mutation, поэтому её нельзя спамить одинаковым
   * sidebar snapshot. Как и list, разные обновления сериализуются до latest.
   */
  const syncActivity = useCallback(
    (threads: readonly TabCandidate[]): Promise<void> => {
      const candidates = [...threads];
      if (candidates.length === 0) return Promise.resolve();
      const request: ActivitySyncRequest = {
        key: activityRequestKey(candidates),
        threads: candidates,
      };
      const inFlight = activitySyncInFlightRef.current;
      if (inFlight !== null) {
        if (
          activitySyncInFlightKeyRef.current === request.key ||
          queuedActivitySyncRef.current?.key === request.key
        ) {
          return inFlight;
        }
        queuedActivitySyncRef.current = request;
        return inFlight;
      }

      const latestCandidate = request.threads.at(-1);
      if (
        lastSyncedActivityKeyRef.current === request.key ||
        (latestCandidate !== undefined &&
          stateContainsCandidate(stateRef.current, latestCandidate))
      ) {
        lastSyncedActivityKeyRef.current = request.key;
        return Promise.resolve();
      }

      const drain = async () => {
        let next: ActivitySyncRequest | null = request;
        while (next !== null) {
          activitySyncInFlightKeyRef.current = next.key;
          const latest = next.threads.at(-1);
          if (
            lastSyncedActivityKeyRef.current === next.key ||
            (latest !== undefined && stateContainsCandidate(stateRef.current, latest))
          ) {
            lastSyncedActivityKeyRef.current = next.key;
          } else {
            try {
              const result = await rpcRef.current.call("tabs_sync_activity", {
                threads: next.threads,
              });
              acceptState(result.state);
              lastSyncedActivityKeyRef.current = next.key;
            } catch (cause) {
              setError(errorMessage(cause));
            }
          }

          const queued = queuedActivitySyncRef.current;
          queuedActivitySyncRef.current = null;
          next = queued !== null && queued.key !== next.key ? queued : null;
        }
      };

      const operation = drain();
      activitySyncInFlightRef.current = operation;
      const clear = () => {
        if (activitySyncInFlightRef.current !== operation) return;
        activitySyncInFlightRef.current = null;
        activitySyncInFlightKeyRef.current = null;
      };
      void operation.then(clear, clear);
      return operation;
    },
    [acceptState],
  );

  /**
   * История не должна создавать параллельные KV-mutation при быстром переходе
   * A → B → C. Одинаковый current chat пропускается, а latest visit ждёт
   * окончания текущего RPC.
   */
  const recordHistory = useCallback(
    (candidate: TabCandidate): Promise<void> => {
      if (!enabledRef.current) return Promise.resolve();
      const request: HistoryVisitRequest = {
        candidate,
        key: candidateKey(candidate),
      };
      const inFlight = historyVisitInFlightRef.current;
      if (inFlight !== null) {
        if (
          historyVisitInFlightKeyRef.current === request.key ||
          queuedHistoryVisitRef.current?.key === request.key
        ) {
          return inFlight;
        }
        queuedHistoryVisitRef.current = request;
        return inFlight;
      }

      if (
        lastRecordedHistoryKeyRef.current === request.key ||
        historyStartsWithCandidate(historyRef.current, request.candidate)
      ) {
        lastRecordedHistoryKeyRef.current = request.key;
        return Promise.resolve();
      }

      const drain = async () => {
        let next: HistoryVisitRequest | null = request;
        while (next !== null) {
          if (!enabledRef.current) {
            queuedHistoryVisitRef.current = null;
            break;
          }
          historyVisitInFlightKeyRef.current = next.key;
          if (
            lastRecordedHistoryKeyRef.current === next.key ||
            historyStartsWithCandidate(historyRef.current, next.candidate)
          ) {
            lastRecordedHistoryKeyRef.current = next.key;
          } else {
            try {
              const result = await rpcRef.current.call(
                "tabs_history_visit",
                next.candidate,
              );
              acceptHistory(result.history);
              lastRecordedHistoryKeyRef.current = next.key;
            } catch (cause) {
              setError(errorMessage(cause));
            }
          }

          const queued = queuedHistoryVisitRef.current;
          queuedHistoryVisitRef.current = null;
          next = queued !== null && queued.key !== next.key ? queued : null;
        }
      };

      const operation = drain();
      historyVisitInFlightRef.current = operation;
      const clear = () => {
        if (historyVisitInFlightRef.current !== operation) return;
        historyVisitInFlightRef.current = null;
        historyVisitInFlightKeyRef.current = null;
      };
      void operation.then(clear, clear);
      return operation;
    },
    [acceptHistory],
  );

  const setPinned = useCallback(
    async (threadId: string, pinned: boolean) => {
      try {
        const result = await rpcRef.current.call("tabs_set_pinned", {
          threadId,
          pinned,
        });
        acceptState(result.state);
        return result.state;
      } catch (cause) {
        setError(errorMessage(cause));
        return null;
      }
    },
    [acceptState],
  );

  const close = useCallback(
    async (threadId: string) => {
      try {
        const result = await rpcRef.current.call("tabs_close", { threadId });
        acceptState(result.state);
        return result;
      } catch (cause) {
        setError(errorMessage(cause));
        return null;
      }
    },
    [acceptState],
  );

  const move = useCallback(
    async (
      sourceThreadId: string,
      targetThreadId: string,
      position: TabMovePosition,
    ) => {
      try {
        const result = await rpcRef.current.call("tabs_move", {
          sourceThreadId,
          targetThreadId,
          position,
        });
        acceptState(result.state);
        return result.state;
      } catch (cause) {
        setError(errorMessage(cause));
        return null;
      }
    },
    [acceptState],
  );

  return {
    activeWorkflowThreadIds,
    close,
    error,
    history,
    move,
    recordHistory,
    refresh,
    setPinned,
    state,
    syncActivity,
  };
}

/**
 * Realtime tabs state и sidebar activity покрывают обычный idle. Таймер нужен
 * только как редкий fallback для durable workflow, который временно не попал
 * ни в одно из этих событий. В hidden document он полностью остановлен.
 */
function useWorkflowRevalidation({
  activeWorkflowThreadIds,
  enabled,
  refresh,
  state,
  workflowThreadIds,
}: {
  activeWorkflowThreadIds: ReadonlySet<string>;
  enabled: boolean;
  refresh: (workflowThreadIds?: readonly string[]) => Promise<void>;
  state: TabsState | null;
  workflowThreadIds: readonly string[];
}): void {
  const visible = useDocumentVisibility();
  const stateReady = state !== null;
  const workflowIdsKey = workflowRequestKey(
    canonicalThreadIds(workflowThreadIds),
  );
  const stableWorkflowIds = useMemo(
    () => (workflowIdsKey === "" ? [] : workflowIdsKey.split("\u0000")),
    [workflowIdsKey],
  );
  const stateEntryKey = workflowRequestKey(
    canonicalThreadIds(state?.entries.map((entry) => entry.threadId) ?? []),
  );
  const hasAdditionalWorkflowIds = stableWorkflowIds.some(
    (threadId) => !stateEntryKey.split("\u0000").includes(threadId),
  );
  const additionalWorkflowProbeKey = `${stateEntryKey}\u0001${workflowIdsKey}`;
  const lastAdditionalWorkflowProbeKeyRef = useRef<string | null>(null);
  const activeWorkflowKey = workflowRequestKey(
    canonicalThreadIds(activeWorkflowThreadIds),
  );
  const intervalMs =
    activeWorkflowKey === ""
      ? IDLE_WORKFLOW_REVALIDATION_MS
      : ACTIVE_WORKFLOW_REVALIDATION_MS;
  const wasVisibleRef = useRef(visible);

  // Редкий, но семантически важный initial fallback: если у открытой tab
  // есть дочерние thread IDs, первый list не мог проверить их до чтения state.
  // Это не timer и выполняется только при материальном расширении probe-set.
  useEffect(() => {
    if (
      !enabled ||
      !stateReady ||
      !visible ||
      !hasAdditionalWorkflowIds ||
      lastAdditionalWorkflowProbeKeyRef.current === additionalWorkflowProbeKey
    ) {
      return;
    }
    lastAdditionalWorkflowProbeKeyRef.current = additionalWorkflowProbeKey;
    void refresh(stableWorkflowIds);
  }, [
    additionalWorkflowProbeKey,
    enabled,
    hasAdditionalWorkflowIds,
    refresh,
    stableWorkflowIds,
    stateReady,
    visible,
  ]);

  // После возврата на foreground делаем один свежий запрос. При первом mount
  // initial refresh выполняет useTabsState, поэтому второй запрос не нужен.
  useEffect(() => {
    const wasVisible = wasVisibleRef.current;
    wasVisibleRef.current = visible;
    if (!enabled || !visible || wasVisible) return;
    void refresh(stateReady ? stableWorkflowIds : []);
  }, [enabled, refresh, stableWorkflowIds, stateReady, visible]);

  useEffect(() => {
    if (
      !enabled ||
      !stateReady ||
      !visible ||
      stableWorkflowIds.length === 0
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      if (documentIsVisible()) void refresh(stableWorkflowIds);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [enabled, intervalMs, refresh, stableWorkflowIds, stateReady, visible]);
}

interface InlineRenameTarget extends RenameTabTarget {
  value: string;
}

interface DraggedTab {
  threadId: string;
}

interface TabDropTarget {
  position: TabMovePosition;
  targetThreadId: string;
}

function isNoopPinnedMove(
  entries: readonly TabEntry[],
  sourceThreadId: string,
  targetThreadId: string,
  position: TabMovePosition,
): boolean {
  const pinnedThreadIds = entries
    .filter((entry) => entry.pinned)
    .map((entry) => entry.threadId);
  const sourceIndex = pinnedThreadIds.indexOf(sourceThreadId);
  const targetIndex = pinnedThreadIds.indexOf(targetThreadId);
  if (sourceIndex === -1 || targetIndex === -1) return true;
  if (sourceIndex === targetIndex) return true;
  return position === "before"
    ? sourceIndex === targetIndex - 1
    : sourceIndex === targetIndex + 1;
}

interface PresentedTab {
  entry: TabEntry;
  hasNestedWork: boolean;
  isUnread: boolean;
  isWorking: boolean;
  projectName: string;
  title: string;
  /** Только history может быть недоступным tombstone. */
  unavailableReason: TabHistoryUnavailableReason | null;
}

/**
 * Полоса намеренно плоская: порядок `entries` — это ручной горизонтальный
 * порядок всех pinned tab, независимо от проекта. Стабильный sort лишь
 * удерживает единственную временную preview после закреплённых вкладок.
 */
function buildPresentedTabs(
  state: TabsState,
  threads: readonly PluginSidebarThread[],
  projects: readonly { id: string; name: string; isPersonal: boolean }[],
  workIndex: ThreadWorkIndex,
): PresentedTab[] {
  const threadsById = new Map(threads.map((thread) => [thread.id, thread]));
  const projectsById = new Map(projects.map((project) => [project.id, project]));

  return [...state.entries]
    .sort((left, right) => Number(right.pinned) - Number(left.pinned))
    .map((entry) => {
      const liveThread = threadsById.get(entry.threadId);
      const liveProject = projectsById.get(entry.projectId);
      return {
        entry,
        hasNestedWork:
          liveThread !== undefined &&
          hasNestedThreadWork(liveThread.id, workIndex),
        isUnread: liveThread?.isUnread ?? false,
        isWorking:
          liveThread !== undefined && hasThreadTreeWork(liveThread.id, workIndex),
        projectName: liveProject?.isPersonal
          ? "Личное"
          : liveProject?.name || "Проект",
        title:
          liveThread?.title?.trim() ||
          liveThread?.titleFallback?.trim() ||
          entry.title,
        unavailableReason: null,
      };
    });
}

/**
 * History не становится вторым набором tab-state: это только recent menu,
 * упорядоченное по `visitedAt` и отображающее live sidebar metadata.
 */
function buildPresentedHistoryTabs(
  history: TabHistoryState,
  threads: readonly PluginSidebarThread[],
  projects: readonly { id: string; name: string; isPersonal: boolean }[],
  workIndex: ThreadWorkIndex,
): PresentedTab[] {
  const unavailableByThreadId = new Map(
    history.entries.map((entry) => [
      entry.threadId,
      entry.unavailableReason ?? null,
    ]),
  );
  return buildPresentedTabs(
    {
      version: 1,
      entries: history.entries.map((entry) => ({
        threadId: entry.threadId,
        projectId: entry.projectId,
        title: entry.title,
        pinned: false,
        openedAt: entry.visitedAt,
      })),
    },
    threads,
    projects,
    workIndex,
  ).map((tab) => ({
    ...tab,
    unavailableReason: unavailableByThreadId.get(tab.entry.threadId) ?? null,
  }));
}

function fallbackTab(entries: readonly TabEntry[], closing: TabEntry): TabEntry | null {
  const remaining = entries.filter((entry) => entry.threadId !== closing.threadId);
  return (
    remaining.find((entry) => entry.projectId === closing.projectId) ??
    remaining[0] ??
    null
  );
}

function belongsToOpenTabTree(
  thread: PluginSidebarThread,
  openTabIds: ReadonlySet<string>,
  sidebarWorkIndex: ThreadWorkIndex,
): boolean {
  let current: PluginSidebarThread | undefined = thread;
  const seen = new Set<string>();
  while (current !== undefined && !seen.has(current.id)) {
    if (openTabIds.has(current.id)) return true;
    seen.add(current.id);
    current =
      current.parentThreadId === null
        ? undefined
        : sidebarWorkIndex.threadsById.get(current.parentThreadId);
  }
  return false;
}

function workflowProbeThreadIds(
  state: TabsState | null,
  threads: readonly PluginSidebarThread[],
  sidebarWorkIndex: ThreadWorkIndex,
): string[] {
  if (state === null) return [];

  // Сначала сами вкладки: они не должны выпадать из лимита, даже если у одной
  // из них много потомков. Затем добавляем только их реальные поддеревья.
  const openTabIds = new Set(state.entries.map((entry) => entry.threadId));
  const seenThreadIds = new Set(openTabIds);
  const threadIds = [...openTabIds];
  for (const thread of threads) {
    if (!belongsToOpenTabTree(thread, openTabIds, sidebarWorkIndex)) continue;
    if (seenThreadIds.has(thread.id)) continue;
    seenThreadIds.add(thread.id);
    threadIds.push(thread.id);
  }
  return threadIds.slice(0, 100);
}

function wheelTargetsTabs(
  event: WheelEvent,
  elements: readonly (HTMLElement | null)[],
): boolean {
  const targets = elements.filter(
    (element): element is HTMLElement => element !== null,
  );
  const path = event.composedPath();
  if (path.length > 0) return targets.some((element) => path.includes(element));
  const target = event.target;
  return target instanceof Node && targets.some((element) => element.contains(target));
}

function ChatTabsOverlay() {
  const context = useBbContext();
  const isCompactTabLayout = useCompactTabLayout();
  const settings = useSettings();
  const sidebar = experimental_useSidebarThreads();
  const threadActions = experimental_useSidebarThreadActions();
  // Compact здесь совпадает с уже существующей touch/mobile-компоновкой
  // (`max-width: 767px` или coarse pointer), чтобы настройки не создавали
  // третье, расходящееся определение «телефона».
  const showTabsOnCurrentLayout = isCompactTabLayout
    ? settings.values?.showTabsOnMobile !== false
    : settings.values?.showTabsOnDesktop !== false;
  const showTabListButton = settings.values?.showTabListButton !== false;
  const showTabListPinned = settings.values?.showTabListPinned !== false;
  const showTabListHistory = settings.values?.showTabListHistory !== false;
  const tabListButtonPosition =
    settings.values?.tabListButtonPosition === "Справа" ? "right" : "left";
  const {
    activeWorkflowThreadIds,
    close,
    error,
    history,
    move,
    recordHistory,
    refresh,
    setPinned,
    state,
    syncActivity,
  } = useTabsState(context.threadId !== null && showTabsOnCurrentLayout);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const topScrollbarRef = useRef<HTMLDivElement | null>(null);
  const topScrollbarSpacerRef = useRef<HTMLDivElement | null>(null);
  const tabElementsRef = useRef(new Map<string, HTMLDivElement>());
  const [inlineRename, setInlineRename] = useState<InlineRenameTarget | null>(
    null,
  );
  const [renameDialogTarget, setRenameDialogTarget] =
    useState<RenameTabTarget | null>(null);
  const [hasHorizontalOverflow, setHasHorizontalOverflow] = useState(false);
  const [tabListMenuOpen, setTabListMenuOpen] = useState(false);
  const [historyVisibleCount, setHistoryVisibleCount] = useState(
    HISTORY_MENU_PAGE_SIZE,
  );
  const [historyMorePending, setHistoryMorePending] = useState(false);
  const [draggedTab, setDraggedTab] = useState<DraggedTab | null>(null);
  const [dropTarget, setDropTarget] = useState<TabDropTarget | null>(null);
  const draggedTabRef = useRef<DraggedTab | null>(null);
  const embeddedBrowserFocused = useRef(false);
  const inlineRenameSubmitting = useRef(false);
  const inlineRenameCancelled = useRef(false);
  const historyMoreTimerRef = useRef<number | null>(null);

  const renameTab = useCallback(
    async (entry: TabEntry, title: string) => {
      const normalizedTitle = normalizeTabTitle(title);
      if (normalizedTitle === null) {
        throw new Error("Введите название от 1 до 300 символов.");
      }
      await threadActions.rename(entry.threadId, normalizedTitle);
      // Sidebar обновится realtime; это сохраняет title и в plugin-owned KV,
      // чтобы fallback не показывал прежнее имя во время следующей загрузки.
      await syncActivity([
        {
          threadId: entry.threadId,
          projectId: entry.projectId,
          title: normalizedTitle,
        },
      ]);
    },
    [syncActivity, threadActions],
  );

  const beginInlineRename = useCallback((entry: TabEntry, title: string) => {
    inlineRenameCancelled.current = false;
    setInlineRename({ entry, title, value: title });
  }, []);

  const cancelInlineRename = useCallback(() => {
    if (inlineRenameSubmitting.current) return;
    // React может послать blur при размонтировании input после Escape.
    // Флаг не даёт этому blur неожиданно сохранить отменённый текст.
    inlineRenameCancelled.current = true;
    setInlineRename(null);
  }, []);

  const commitInlineRename = useCallback(async () => {
    const target = inlineRename;
    if (
      target === null ||
      inlineRenameSubmitting.current ||
      inlineRenameCancelled.current
    ) {
      return;
    }

    inlineRenameSubmitting.current = true;
    setInlineRename(null);
    try {
      const normalizedTitle = normalizeTabTitle(target.value);
      if (normalizedTitle === null) {
        toast.error("Введите название чата от 1 до 300 символов.");
        return;
      }
      if (normalizedTitle !== target.title) {
        await renameTab(target.entry, normalizedTitle);
      }
    } catch (cause) {
      toast.error(`Не удалось переименовать чат: ${errorMessage(cause)}`);
    } finally {
      inlineRenameSubmitting.current = false;
    }
  }, [inlineRename, renameTab]);

  const copyThreadLink = useCallback(
    async (entry: TabEntry) => {
      const copied = await copyTextToClipboard(
        threadLinkUrl(entry, context.threadId),
      );
      if (copied) {
        toast.success("Ссылка на чат скопирована");
      } else {
        toast.error("Не удалось скопировать ссылку на чат");
      }
    },
    [context.threadId],
  );

  const markTabUnread = useCallback(
    async (entry: TabEntry) => {
      try {
        await threadActions.setRead(entry.threadId, false);
      } catch (cause) {
        toast.error(`Не удалось пометить чат непрочитанным: ${errorMessage(cause)}`);
      }
    },
    [threadActions],
  );

  const archiveTab = useCallback(
    (entry: TabEntry) => {
      try {
        // Host archive закрывает native pane и потомков; отдельно убираем
        // только plugin-вкладку, не меняя архивный статус повторно.
        threadActions.archive(entry.threadId);
        void close(entry.threadId);
      } catch (cause) {
        toast.error(`Не удалось архивировать чат: ${errorMessage(cause)}`);
      }
    },
    [close, threadActions],
  );

  const clearTabDrag = useCallback(() => {
    draggedTabRef.current = null;
    setDraggedTab(null);
    setDropTarget(null);
  }, []);

  const scrollStripDuringDrag = useCallback((clientX: number) => {
    const strip = stripRef.current;
    if (strip === null) return;
    const rect = strip.getBoundingClientRect();
    const edgeSize = 48;
    const maxStep = 20;
    let delta = 0;
    if (clientX < rect.left + edgeSize) {
      delta =
        -Math.min(1, (rect.left + edgeSize - clientX) / edgeSize) * maxStep;
    } else if (clientX > rect.right - edgeSize) {
      delta =
        Math.min(1, (clientX - (rect.right - edgeSize)) / edgeSize) * maxStep;
    }
    if (delta !== 0) strip.scrollLeft += delta;
  }, []);

  const handleTabDragStart = useCallback(
    (event: DragEvent<HTMLDivElement>, entry: TabEntry) => {
      // Кнопка Close не должна становиться источником drag, даже если курсор
      // начал движение непосредственно с её SVG.
      const target = event.target;
      if (
        !entry.pinned ||
        (target instanceof Element && target.closest(".bb-chat-tab-action"))
      ) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", entry.threadId);
      const next: DraggedTab = { threadId: entry.threadId };
      draggedTabRef.current = next;
      setDraggedTab(next);
      setDropTarget(null);
    },
    [],
  );

  const handleDropSlotDragOver = useCallback(
    (
      event: DragEvent<HTMLDivElement>,
      targetThreadId: string,
      position: TabMovePosition,
    ) => {
      const source = draggedTabRef.current;
      if (
        source === null ||
        state === null ||
        isNoopPinnedMove(
          state.entries,
          source.threadId,
          targetThreadId,
          position,
        )
      ) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const nextTarget: TabDropTarget = { position, targetThreadId };
      setDropTarget((previous) =>
        previous?.targetThreadId === nextTarget.targetThreadId &&
        previous.position === nextTarget.position
          ? previous
          : nextTarget,
      );
      scrollStripDuringDrag(event.clientX);
    },
    [scrollStripDuringDrag, state],
  );

  const handleDropSlotDrop = useCallback(
    (
      event: DragEvent<HTMLDivElement>,
      targetThreadId: string,
      position: TabMovePosition,
    ) => {
      const source = draggedTabRef.current;
      if (
        source === null ||
        state === null ||
        isNoopPinnedMove(
          state.entries,
          source.threadId,
          targetThreadId,
          position,
        )
      ) {
        clearTabDrag();
        return;
      }
      event.preventDefault();
      clearTabDrag();
      void move(source.threadId, targetThreadId, position);
    },
    [clearTabDrag, move, state],
  );

  const handleStripWheel = useCallback((event: WheelEvent) => {
    if (event.ctrlKey || event.metaKey) return;
    const strip = stripRef.current;
    if (
      strip === null ||
      !wheelTargetsTabs(event, [strip, topScrollbarRef.current])
    ) {
      return;
    }

    if (!consumeHorizontalWheel(strip, event)) return;
    // Мы уже применили scrollLeft вручную. Останавливаем дальнейшие host
    // wheel handlers, иначе активная button/главная timeline могут попытаться
    // обработать тот же жест повторно.
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
  }, []);

  useEffect(() => {
    // Слушаем на window в capture phase, а не на самом strip: BB или UI-kit
    // могут остановить событие выше кнопки вкладки ещё до bubbling. Проверка
    // composedPath гарантирует, что мы не перехватываем wheel вне полосы.
    window.addEventListener("wheel", handleStripWheel, {
      capture: true,
      passive: false,
    });
    return () => window.removeEventListener("wheel", handleStripWheel, true);
  }, [handleStripWheel]);

  const sidebarWorkIndex = useMemo(
    () => buildThreadWorkIndex(sidebar.threads),
    [sidebar.threads],
  );
  const workIndex = useMemo(
    () => buildThreadWorkIndex(sidebar.threads, activeWorkflowThreadIds),
    [activeWorkflowThreadIds, sidebar.threads],
  );

  const currentCandidate = useMemo(() => {
    if (sidebar.status !== "ready" || context.threadId === null) return null;
    const current = sidebar.threads.find((thread) => thread.id === context.threadId);
    return current === undefined ? null : candidateForThread(current);
  }, [context.threadId, sidebar.status, sidebar.threads]);
  const currentKey = candidateKey(currentCandidate);

  // Регистрирует переход из sidebar, Ctrl+Tab, menu или прямого URL. История
  // намеренно отдельна от preview: закрытие tab не стирает recent navigation.
  useEffect(() => {
    if (currentCandidate === null) return;
    void recordHistory(currentCandidate);
  }, [currentCandidate, currentKey, recordHistory]);

  const latestActivity = useMemo(
    () =>
      sidebar.status === "ready"
        ? latestWorkingCandidate(sidebar.threads, workIndex)
        : null,
    [sidebar.status, sidebar.threads, workIndex],
  );
  // `updatedAt` нужен только чтобы выбрать самый свежий чат. Не включаем его
  // в dependency key: runtime может обновлять timestamp много раз в секунду,
  // хотя preview и её подпись при этом не меняются.
  const activityKey =
    latestActivity === null ? "" : candidateKey(latestActivity);

  const lastCurrentKey = useRef<string | null>(null);
  const lastActivityKey = useRef<string | null>(null);
  useEffect(() => {
    // Сначала получаем один snapshot plugin-owned state. Это исключает гонку
    // initial `tabs_list` ↔ `tabs_sync_activity` и позволяет не отправлять
    // mutation, если candidate уже отражён в KV/realtime state.
    // Отключённая верхняя поверхность не мутирует состояние текущего чата,
    // но root route сохраняет прежний путь: background activity всё равно
    // может подготовить preview родительского разговора.
    if (!showTabsOnCurrentLayout && context.threadId !== null) return;
    if (state === null && context.threadId !== null) return;

    const currentChanged = currentKey !== lastCurrentKey.current;
    const activityChanged = activityKey !== lastActivityKey.current;
    lastCurrentKey.current = currentKey;
    lastActivityKey.current = activityKey;

    // Переход на любой новый чат создаёт/обновляет preview, даже если в нём
    // нет runtime-работы. Совпадающая запись не нуждается в server mutation.
    if (
      currentCandidate !== null &&
      currentChanged &&
      !stateContainsCandidate(state, currentCandidate)
    ) {
      void syncActivity([currentCandidate]);
      return;
    }

    // Если маршрут не менялся, новая наиболее свежая работа всё ещё попадает
    // в preview: так не теряется автоматическое обнаружение фоновых чатов.
    if (
      latestActivity !== null &&
      activityChanged &&
      !stateContainsCandidate(state, latestActivity)
    ) {
      void syncActivity([latestActivity]);
    }
  }, [
    activityKey,
    currentCandidate,
    currentKey,
    latestActivity,
    showTabsOnCurrentLayout,
    state,
    syncActivity,
  ]);

  const tabs = useMemo(
    () =>
      state === null
        ? []
        : buildPresentedTabs(state, sidebar.threads, sidebar.projects, workIndex),
    [sidebar.projects, sidebar.threads, state, workIndex],
  );
  // Когда раздел pinned включён, он идёт раньше history и исключает дубли.
  // Если раздел скрыт настройкой, закреплённый recent chat остаётся доступен
  // в истории; закрытие preview/tab её не стирает.
  const pinnedMenuTabs = useMemo(
    () => tabs.filter((tab) => tab.entry.pinned),
    [tabs],
  );
  const historyMenuTabs = useMemo(() => {
    const pinnedIds = new Set(pinnedMenuTabs.map((tab) => tab.entry.threadId));
    const presented = buildPresentedHistoryTabs(
      history,
      sidebar.threads,
      sidebar.projects,
      workIndex,
    ).filter(
      (tab) => !showTabListPinned || !pinnedIds.has(tab.entry.threadId),
    );
    const knownIds = new Set(presented.map((tab) => tab.entry.threadId));
    // Не ждём round-trip history mutation, чтобы только что созданная preview
    // сразу была доступна в навигационном подменю.
    const preview = tabs.find((tab) => !tab.entry.pinned);
    if (
      preview !== undefined &&
      !pinnedIds.has(preview.entry.threadId) &&
      !knownIds.has(preview.entry.threadId)
    ) {
      presented.unshift(preview);
    }
    return presented;
  }, [
    history,
    pinnedMenuTabs,
    showTabListPinned,
    sidebar.projects,
    sidebar.threads,
    tabs,
    workIndex,
  ]);
  // Настройки управляют только представлением меню: pin/history state и
  // ручной порядок верхней полосы остаются неизменными.
  const menuPinnedTabs = showTabListPinned ? pinnedMenuTabs : [];
  const menuHistoryTabs = showTabListHistory ? historyMenuTabs : [];
  const visibleHistoryMenuTabs = menuHistoryTabs.slice(0, historyVisibleCount);
  const hasMoreHistory = visibleHistoryMenuTabs.length < menuHistoryTabs.length;
  const tabListMenuHasNavigation =
    showTabListButton && menuPinnedTabs.length + menuHistoryTabs.length > 1;

  useEffect(() => {
    setHistoryVisibleCount((current) =>
      Math.min(Math.max(HISTORY_MENU_PAGE_SIZE, current), historyMenuTabs.length),
    );
  }, [historyMenuTabs.length]);

  const loadMoreHistory = useCallback(() => {
    setHistoryVisibleCount((current) =>
      Math.min(current + HISTORY_MENU_PAGE_SIZE, historyMenuTabs.length),
    );
  }, [historyMenuTabs.length]);

  const clearHistoryMoreTimer = useCallback(() => {
    if (historyMoreTimerRef.current !== null) {
      window.clearTimeout(historyMoreTimerRef.current);
      historyMoreTimerRef.current = null;
    }
    setHistoryMorePending(false);
  }, []);

  const scheduleHistoryMore = useCallback(() => {
    clearHistoryMoreTimer();
    setHistoryMorePending(true);
    historyMoreTimerRef.current = window.setTimeout(() => {
      historyMoreTimerRef.current = null;
      setHistoryMorePending(false);
      loadMoreHistory();
    }, HISTORY_MORE_HOVER_DELAY_MS);
  }, [clearHistoryMoreTimer, loadMoreHistory]);

  useEffect(() => clearHistoryMoreTimer, [clearHistoryMoreTimer]);
  useEffect(() => {
    const strip = stripRef.current;
    const topScrollbar = topScrollbarRef.current;
    const spacer = topScrollbarSpacerRef.current;
    if (strip === null || topScrollbar === null || spacer === null) return;

    const syncMetrics = () => {
      // Верхняя proxy-scrollbar нужна только при реальном переполнении.
      // Позиция по-прежнему принадлежит strip с фактическими вкладками.
      const nextHasHorizontalOverflow = strip.scrollWidth > strip.clientWidth;
      setHasHorizontalOverflow(
        (previous) =>
          previous === nextHasHorizontalOverflow
            ? previous
            : nextHasHorizontalOverflow,
      );
      spacer.style.width = `${Math.max(strip.scrollWidth, strip.clientWidth)}px`;
      if (topScrollbar.scrollLeft !== strip.scrollLeft) {
        topScrollbar.scrollLeft = strip.scrollLeft;
      }
    };
    const syncFromStrip = () => {
      if (topScrollbar.scrollLeft !== strip.scrollLeft) {
        topScrollbar.scrollLeft = strip.scrollLeft;
      }
    };
    const syncFromTopScrollbar = () => {
      if (strip.scrollLeft !== topScrollbar.scrollLeft) {
        strip.scrollLeft = topScrollbar.scrollLeft;
      }
    };

    strip.addEventListener("scroll", syncFromStrip, { passive: true });
    topScrollbar.addEventListener("scroll", syncFromTopScrollbar, {
      passive: true,
    });
    syncMetrics();

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(syncMetrics);
    resizeObserver?.observe(strip);
    resizeObserver?.observe(topScrollbar);
    // Fallback для окружений без ResizeObserver и для jsdom-проверки.
    window.addEventListener("resize", syncMetrics);

    return () => {
      strip.removeEventListener("scroll", syncFromStrip);
      topScrollbar.removeEventListener("scroll", syncFromTopScrollbar);
      window.removeEventListener("resize", syncMetrics);
      resizeObserver?.disconnect();
    };
  }, [error, tabs]);

  const shouldDock =
    showTabsOnCurrentLayout && context.threadId !== null && tabs.length > 0;
  useEffect(() => {
    if (!shouldDock || !tabListMenuHasNavigation) {
      setTabListMenuOpen(false);
      clearHistoryMoreTimer();
      return;
    }
    if (!tabListMenuOpen || !showTabListHistory) clearHistoryMoreTimer();
  }, [
    clearHistoryMoreTimer,
    shouldDock,
    showTabListHistory,
    tabListMenuHasNavigation,
    tabListMenuOpen,
  ]);

  const workflowThreadIds = useMemo(
    () => workflowProbeThreadIds(state, sidebar.threads, sidebarWorkIndex),
    [sidebar.threads, sidebarWorkIndex, state],
  );

  useWorkflowRevalidation({
    activeWorkflowThreadIds,
    enabled: shouldDock,
    refresh,
    state,
    workflowThreadIds,
  });

  // Все вкладки остаются в одной горизонтальной линии: длинные наборы
  // прокручиваются общей верхней scrollbar, без вложенной вертикали.
  const rowCount = 1;

  const openThread = useCallback(
    (candidate: TabCandidate) => {
      void recordHistory(candidate);
      threadActions.open(candidate.threadId);
    },
    [recordHistory, threadActions],
  );

  const closeTab = useCallback(
    async (entry: TabEntry) => {
      const result = await close(entry.threadId);
      if (result === null || context.threadId !== entry.threadId) return;
      const fallback = fallbackTab(result.state.entries, entry);
      // Закрытие вкладки не архивирует чат и не останавливает его runtime.
      // Если есть соседняя — переключаемся на неё, иначе оставляем текущий чат
      // открытым без верхней вкладки.
      if (fallback !== null) {
        openThread({
          threadId: fallback.threadId,
          projectId: fallback.projectId,
          title: fallback.title,
        });
      }
    },
    [close, context.threadId, openThread],
  );

  const cycleTabsByKeyboard = useCallback(
    (direction: TabCycleDirection): boolean => {
      // Не уводим пользователя из inline/modal rename или незавершённого drag.
      if (
        inlineRename !== null ||
        renameDialogTarget !== null ||
        draggedTab !== null
      ) {
        return false;
      }
      const target = cycleTab(
        tabs.map((tab) => tab.entry),
        context.threadId,
        direction,
      );
      if (target === null) return false;

      const targetElement = tabElementsRef.current.get(target.threadId);
      if (typeof targetElement?.scrollIntoView === "function") {
        targetElement.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
      openThread({
        threadId: target.threadId,
        projectId: target.projectId,
        title: target.title,
      });
      return true;
    },
    [
      context.threadId,
      draggedTab,
      inlineRename,
      openThread,
      renameDialogTarget,
      tabs,
    ],
  );

  const currentEntry =
    !shouldDock || state === null
      ? null
      : state.entries.find((entry) => entry.threadId === context.threadId) ?? null;
  const currentEntryRef = useRef<TabEntry | null>(null);
  const closingCurrentTab = useRef(false);
  currentEntryRef.current = currentEntry;

  const closeCurrentTab = useCallback(async () => {
    if (currentEntry === null || closingCurrentTab.current) return;
    closingCurrentTab.current = true;
    try {
      await closeTab(currentEntry);
    } finally {
      closingCurrentTab.current = false;
    }
  }, [closeTab, currentEntry]);
  const closeCurrentTabRef = useRef(closeCurrentTab);
  closeCurrentTabRef.current = closeCurrentTab;

  useEffect(() => {
    // Focus нативного BrowserView не отражается в document.activeElement.
    // Bridge и renderer-chrome ведут один marker текущего фокуса; обычный
    // переход pointer/focus обратно в host сбрасывает его.
    const syncEmbeddedBrowserFocus = (event: Event) => {
      embeddedBrowserFocused.current = isBrowserChromeKeyboardTarget(
        event.target,
      );
    };
    const unsubscribe = subscribeToDesktopBrowserViewFocus(() => {
      embeddedBrowserFocused.current = true;
    });
    window.addEventListener("pointerdown", syncEmbeddedBrowserFocus, true);
    window.addEventListener("focusin", syncEmbeddedBrowserFocus, true);
    return () => {
      window.removeEventListener(
        "pointerdown",
        syncEmbeddedBrowserFocus,
        true,
      );
      window.removeEventListener("focusin", syncEmbeddedBrowserFocus, true);
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    // В Desktop accelerator CommandOrControl+W обрабатывает нативное меню
    // раньше renderer keydown. Пока BrowserView в фокусе, плагин вообще не
    // обрабатывает shortcut и оставляет его штатному handler BB.
    const unsubscribe = subscribeToDesktopCloseWindowRequest(() => {
      if (embeddedBrowserFocused.current) return false;
      if (currentEntryRef.current === null) return false;
      void closeCurrentTabRef.current();
      return true;
    });
    return unsubscribe ?? undefined;
  }, []);

  useLayoutEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      if (isCyclePluginTabsShortcut(event)) {
        const direction: TabCycleDirection = event.shiftKey
          ? "previous"
          : "next";
        if (!cycleTabsByKeyboard(direction)) return;
        // В Desktop иначе accelerator/native focus traversal может забрать
        // Ctrl+Tab раньше, чем откроется выбранный plugin tab.
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (!isCloseCurrentTabShortcut(event)) {
        return;
      }

      // Native BrowserView получает shortcut вне DOM, а его chrome остаётся
      // в renderer. В обоих случаях не перехватываем Ctrl+W: BB должен закрыть
      // active browser tab своим штатным panel handler.
      if (
        embeddedBrowserFocused.current ||
        isBrowserChromeKeyboardTarget(event.target)
      ) {
        return;
      }

      if (currentEntry === null || closingCurrentTab.current) {
        return;
      }

      // Ctrl+W обычно закрывает окно/вкладку браузера. В пределах открытого
      // plugin tab отменяем это действие и закрываем только plugin-owned tab.
      event.preventDefault();
      event.stopPropagation();
      void closeCurrentTab();
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [closeCurrentTab, currentEntry, cycleTabsByKeyboard]);

  const lastPinnedThreadId = useMemo(
    () =>
      tabs.reduce<string | null>(
        (last, tab) => (tab.entry.pinned ? tab.entry.threadId : last),
        null,
      ),
    [tabs],
  );

  const renderDropSlot = (
    targetThreadId: string,
    position: TabMovePosition,
  ) => {
    if (
      draggedTab !== null &&
      (state === null ||
        isNoopPinnedMove(
          state.entries,
          draggedTab.threadId,
          targetThreadId,
          position,
        ))
    ) {
      return null;
    }
    const active =
      dropTarget?.targetThreadId === targetThreadId &&
      dropTarget.position === position;
    return (
      <div
        className="bb-chat-tab-drop-slot"
        data-active={active ? "true" : "false"}
        data-drop-position={position}
        data-drop-target={targetThreadId}
        aria-hidden="true"
        onDragOver={(event) =>
          handleDropSlotDragOver(event, targetThreadId, position)
        }
        onDrop={(event) => handleDropSlotDrop(event, targetThreadId, position)}
      >
        <span className="bb-chat-tab-drop-slot-hit" aria-hidden="true" />
      </div>
    );
  };

  const renderTabListMenuItem = (tab: PresentedTab) => {
    const unavailableReason = tab.unavailableReason;
    const unavailableLabel =
      unavailableReason === null
        ? null
        : unavailableHistoryLabel(unavailableReason);
    const active =
      unavailableReason === null && tab.entry.threadId === context.threadId;
    const status = chatStatusFor(tab);
    return (
      <DropdownMenu.Item
        key={tab.entry.threadId}
        className="bb-chat-tabs-list-menu-item"
        disabled={unavailableReason !== null}
        aria-current={active ? "page" : undefined}
        aria-label={
          unavailableLabel === null
            ? undefined
            : `${tab.title}. Проект: ${tab.projectName}. ${unavailableLabel}. Чат недоступен.`
        }
        data-active={active ? "true" : "false"}
        data-thread-id={tab.entry.threadId}
        data-unavailable={unavailableReason ?? undefined}
        onSelect={
          unavailableReason === null
            ? () => {
                setTabListMenuOpen(false);
                openThread({
                  threadId: tab.entry.threadId,
                  projectId: tab.entry.projectId,
                  title: tab.title,
                });
              }
            : undefined
        }
      >
        {unavailableReason !== null ? (
          <Icon
            name={unavailableReason === "archived" ? "Archive" : "Trash2"}
            className="bb-chat-tabs-list-menu-unavailable-icon"
            aria-hidden
          />
        ) : null}
        <span className="bb-chat-tabs-list-menu-copy">
          <span
            className="bb-chat-tabs-list-menu-title"
            data-unavailable={unavailableReason ?? undefined}
            title={
              unavailableLabel === null
                ? tab.title
                : `${unavailableLabel}: ${tab.title}`
            }
          >
            {tab.title}
          </span>
          <span className="bb-chat-tabs-list-menu-meta">
            <span
              className="bb-chat-tabs-list-menu-project"
              title={tab.projectName}
            >
              {tab.projectName}
            </span>
            {unavailableLabel !== null ? (
              <span
                className="bb-chat-tabs-list-menu-unavailable-label"
                title={unavailableLabel}
              >
                {unavailableLabel}
              </span>
            ) : status !== null ? (
              <span
                className="bb-chat-tabs-list-menu-status"
                data-status={status.kind}
                title={status.text}
              >
                <span
                  className="bb-chat-tabs-list-menu-status-dot"
                  aria-hidden
                />
                {status.text}
              </span>
            ) : null}
          </span>
        </span>
        {active ? (
          <Icon
            name="Check"
            className="bb-chat-tabs-list-menu-check"
            aria-hidden
          />
        ) : null}
      </DropdownMenu.Item>
    );
  };

  const tabListSwitcher = tabListMenuHasNavigation ? (
    <div
      className="bb-chat-tabs-list-switcher"
      data-position={tabListButtonPosition}
    >
      <DropdownMenu.Root
        open={tabListMenuOpen}
        onOpenChange={(open) => {
          setTabListMenuOpen(open);
          if (!open) clearHistoryMoreTimer();
        }}
      >
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="bb-chat-tabs-list-trigger"
            aria-label="Список открытых чатов"
            title="Открыть список вкладок"
          >
            <Icon name="ListView" className="bb-chat-tabs-list-icon" aria-hidden />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="bb-chat-tabs-list-menu"
            aria-label="Список открытых чатов"
            side="bottom"
            align={tabListButtonPosition === "right" ? "end" : "start"}
            sideOffset={6}
            collisionPadding={8}
          >
            {menuPinnedTabs.length > 0 ? (
              <DropdownMenu.Group className="bb-chat-tabs-list-menu-group">
                <DropdownMenu.Label className="bb-chat-tabs-list-menu-group-label">
                  Закреплённые
                </DropdownMenu.Label>
                {menuPinnedTabs.map(renderTabListMenuItem)}
              </DropdownMenu.Group>
            ) : null}
            {visibleHistoryMenuTabs.length > 0 ? (
              <DropdownMenu.Group className="bb-chat-tabs-list-menu-group">
                <DropdownMenu.Label className="bb-chat-tabs-list-menu-group-label">
                  История
                </DropdownMenu.Label>
                {visibleHistoryMenuTabs.map((tab, index) => (
                  <Fragment key={tab.entry.threadId}>
                    {index > 0 && index % HISTORY_MENU_PAGE_SIZE === 0 ? (
                      <DropdownMenu.Separator
                        className="bb-chat-tabs-list-menu-history-page-separator"
                        aria-label="Следующая страница истории"
                      />
                    ) : null}
                    {renderTabListMenuItem(tab)}
                  </Fragment>
                ))}
              </DropdownMenu.Group>
            ) : null}
            {hasMoreHistory ? (
              <DropdownMenu.Item
                className="bb-chat-tabs-list-menu-more"
                data-pending={historyMorePending ? "true" : "false"}
                aria-label={`Показать ещё ${Math.min(
                  HISTORY_MENU_PAGE_SIZE,
                  menuHistoryTabs.length - visibleHistoryMenuTabs.length,
                )} чатов истории`}
                onPointerEnter={(event) => {
                  if (event.pointerType === "mouse") scheduleHistoryMore();
                }}
                onPointerLeave={clearHistoryMoreTimer}
                onPointerCancel={clearHistoryMoreTimer}
                onSelect={(event) => {
                  // Click, tap и keyboard раскрывают страницу сразу. Hover на
                  // desktop остаётся вторым быстрым путём и не должен успеть
                  // открыть ту же порцию повторно после click.
                  event.preventDefault();
                  clearHistoryMoreTimer();
                  loadMoreHistory();
                }}
              >
                <span>Ещё</span>
                <span className="bb-chat-tabs-list-menu-more-count">
                  {menuHistoryTabs.length - visibleHistoryMenuTabs.length}
                </span>
              </DropdownMenu.Item>
            ) : null}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  ) : null;

  return (
    <aside
      id="bb-chat-tabs-overlay"
      data-docked={shouldDock ? "true" : "false"}
      data-row-count={String(rowCount)}
      data-scrollable={hasHorizontalOverflow ? "true" : "false"}
      aria-hidden={!shouldDock}
    >
      <div
        className="bb-chat-tabs-shell"
        data-scrollable={hasHorizontalOverflow ? "true" : "false"}
      >
        <div
          ref={topScrollbarRef}
          className="bb-chat-tabs-top-scrollbar"
          aria-hidden={!hasHorizontalOverflow}
          aria-label="Горизонтальная прокрутка вкладок"
          tabIndex={hasHorizontalOverflow ? 0 : -1}
        >
          <div
            ref={topScrollbarSpacerRef}
            className="bb-chat-tabs-top-scrollbar-spacer"
            aria-hidden
          />
        </div>
        <div className="bb-chat-tabs-content-row">
          {tabListButtonPosition === "left" ? tabListSwitcher : null}
          <div
            ref={stripRef}
            className="bb-chat-tabs-strip"
            data-dragging={draggedTab === null ? "false" : "true"}
            aria-label="Открытые чаты"
          >
          {tabs.map(
            ({
              entry,
              hasNestedWork,
              isUnread,
              isWorking,
              projectName,
              title,
            }) => {
                    const active = entry.threadId === context.threadId;
                    const preview = !entry.pinned;
                    const editing = inlineRename?.entry.threadId === entry.threadId;
                    const draggable =
                      entry.pinned && !editing && !isCompactTabLayout;
                    const dragging = draggedTab?.threadId === entry.threadId;
                    const workLabel = hasNestedWork
                      ? "выполняется вложенная работа"
                      : "работа выполняется";
                    const tabHint = [
                      `Проект: ${projectName}`,
                      `Чат: ${title}`,
                      hasNestedWork ? "Выполняется вложенная работа." : "",
                      isUnread ? "Есть непрочитанные сообщения." : "",
                      "Кликните, чтобы открыть чат.",
                      entry.pinned
                        ? "Перетаскивайте, чтобы изменить порядок."
                        : "",
                      preview ? "Двойной щелчок закрепляет вкладку." : "",
                      "Щелчок колёсиком закрывает вкладку.",
                    ]
                      .filter(Boolean)
                      .join("\n");
                    return (
                      <Fragment key={entry.threadId}>
                        {entry.pinned
                          ? renderDropSlot(entry.threadId, "before")
                          : null}
                      <TabActionsContextMenu
                        entry={entry}
                        isPinned={entry.pinned}
                        title={title}
                        onArchive={archiveTab}
                        onCopyLink={(target) => void copyThreadLink(target)}
                        onMarkUnread={(target) => void markTabUnread(target)}
                        onRename={setRenameDialogTarget}
                        onSetPinned={(target, pinned) =>
                          void setPinned(target.threadId, pinned)
                        }
                      >
                        <div
                          ref={(element) => {
                            if (element === null) {
                              tabElementsRef.current.delete(entry.threadId);
                            } else {
                              tabElementsRef.current.set(entry.threadId, element);
                            }
                          }}
                          className="bb-chat-tab"
                          data-active={active ? "true" : "false"}
                          data-dragging={dragging ? "true" : "false"}
                          data-draggable={draggable ? "true" : "false"}
                          data-editing={editing ? "true" : "false"}
                          data-nested-work={hasNestedWork ? "true" : "false"}
                          data-preview={preview ? "true" : "false"}
                          data-unread={isUnread ? "true" : "false"}
                          draggable={draggable}
                          onDragEnd={clearTabDrag}
                          onDragStart={(event) => handleTabDragStart(event, entry)}
                        >
                          {editing ? (
                            <input
                              autoFocus
                              className="bb-chat-tab-inline-rename"
                              aria-label={`Переименовать вкладку «${title}»`}
                              maxLength={300}
                              value={inlineRename?.value ?? title}
                              onBlur={() => void commitInlineRename()}
                              onChange={(event) => {
                                const value = event.target.value;
                                setInlineRename((current) =>
                                  current?.entry.threadId === entry.threadId
                                    ? { ...current, value }
                                    : current,
                                );
                              }}
                              onClick={(event) => event.stopPropagation()}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  void commitInlineRename();
                                } else if (event.key === "Escape") {
                                  event.preventDefault();
                                  cancelInlineRename();
                                }
                                event.stopPropagation();
                              }}
                            />
                          ) : (
                            <button
                              type="button"
                              className="bb-chat-tab-select"
                              aria-current={active ? "page" : undefined}
                              aria-description={`Клик открывает чат. Проект: ${projectName}.${
                                preview
                                  ? " Предварительная вкладка."
                                  : " Закреплённая вкладка. Её можно перетаскивать для изменения порядка."
                              } Щелчок колёсиком закрывает вкладку.`}
                              aria-label={`${title}${
                                isWorking ? `, ${workLabel}` : ""
                              }${
                                isUnread ? ", есть непрочитанные сообщения" : ""
                              }`}
                              title={tabHint}
                              onMouseDown={(event) => {
                                // Не запускаем browser autoscroll до auxclick.
                                if (event.button === 1) event.preventDefault();
                              }}
                              onAuxClick={(event) => {
                                if (event.button !== 1) return;
                                event.preventDefault();
                                event.stopPropagation();
                                void closeTab(entry);
                              }}
                              onClick={() =>
                                openThread({
                                  threadId: entry.threadId,
                                  projectId: entry.projectId,
                                  title,
                                })
                              }
                              onDoubleClick={() => {
                                if (preview) void setPinned(entry.threadId, true);
                              }}
                            >
                              {isWorking ? (
                                <span className="bb-chat-tab-working" aria-hidden />
                              ) : null}
                              <span className="bb-chat-tab-copy">
                                <span
                                  className="bb-chat-tab-title"
                                  onDoubleClick={(event) => {
                                    if (!entry.pinned) return;
                                    event.preventDefault();
                                    event.stopPropagation();
                                    beginInlineRename(entry, title);
                                  }}
                                >
                                  {title}
                                </span>
                              </span>
                              {isUnread ? (
                                <span className="bb-chat-tab-unread" aria-hidden />
                              ) : null}
                            </button>
                          )}
                          <button
                            type="button"
                            className="bb-chat-tab-action"
                            aria-label={`Закрыть вкладку «${title}»`}
                            title="Закрыть вкладку"
                            onClick={(event) => {
                              event.stopPropagation();
                              void closeTab(entry);
                            }}
                          >
                            <Icon name="X" className="size-3.5" aria-hidden />
                          </button>
                        </div>
                      </TabActionsContextMenu>
                      {entry.pinned && entry.threadId === lastPinnedThreadId
                        ? renderDropSlot(entry.threadId, "after")
                        : null}
                      </Fragment>
                    );
            },
          )}
            {error === null ? null : (
              <span className="bb-chat-tabs-error" role="status" title={error}>
                Вкладки недоступны
              </span>
            )}
          </div>
          {tabListButtonPosition === "right" ? tabListSwitcher : null}
        </div>
      </div>
      <RenameTabDialog
        target={renameDialogTarget}
        onClose={() => setRenameDialogTarget(null)}
        onRename={renameTab}
      />
    </aside>
  );
}

/**
 * Root-compose surface под штатным полем «Новый чат». В отличие от overlay,
 * этот slot виден и без открытого thread и не требует CSS-вмешательства в
 * native chat chrome.
 */
function PinnedTabsHomepageSection(_props: PluginHomepageSectionProps) {
  const settings = useSettings();
  const sidebar = experimental_useSidebarThreads();
  const threadActions = experimental_useSidebarThreadActions();
  // Пока settings загружаются, сохраняем default `true`, чтобы section не
  // мигал при первом рендере root compose.
  const showPinnedTabsList = settings.values?.showPinnedTabsList !== false;
  const { activeWorkflowThreadIds, refresh, state } = useTabsState(
    showPinnedTabsList,
  );
  const sidebarWorkIndex = useMemo(
    () => buildThreadWorkIndex(sidebar.threads),
    [sidebar.threads],
  );
  const workIndex = useMemo(
    () => buildThreadWorkIndex(sidebar.threads, activeWorkflowThreadIds),
    [activeWorkflowThreadIds, sidebar.threads],
  );
  const tabs = useMemo(
    () =>
      state === null
        ? []
        : buildPresentedTabs(state, sidebar.threads, sidebar.projects, workIndex),
    [sidebar.projects, sidebar.threads, state, workIndex],
  );
  const pinnedTabs = useMemo(
    () =>
      tabs
        .filter((tab) => tab.entry.pinned)
        .map(({ entry, isUnread, isWorking, projectName, title }) => ({
          isUnread,
          isWorking,
          projectName,
          threadId: entry.threadId,
          title,
        })),
    [tabs],
  );
  const workflowThreadIds = useMemo(
    () => workflowProbeThreadIds(state, sidebar.threads, sidebarWorkIndex),
    [sidebar.threads, sidebarWorkIndex, state],
  );

  useWorkflowRevalidation({
    activeWorkflowThreadIds,
    enabled: showPinnedTabsList && pinnedTabs.length > 0,
    refresh,
    state,
    workflowThreadIds,
  });

  return (
    <PinnedTabsList
      visible={showPinnedTabsList}
      tabs={pinnedTabs}
      onOpenThread={(threadId) => threadActions.open(threadId)}
    />
  );
}

export default definePluginApp((app) => {
  app.slots.homepageSection({
    id: "pinned-tabs",
    title: "Закреплённые чаты",
    component: PinnedTabsHomepageSection,
  });
  app.slots.experimental_appOverlay({
    id: "chat-tabs",
    component: ChatTabsOverlay,
  });
});
