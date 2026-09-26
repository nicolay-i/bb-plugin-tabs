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
import { NewChatSwitcher } from "./components/new-chat-switcher";
import { recentProjects } from "./lib/recent-projects";
import { fuzzyChatSearch } from "./lib/fuzzy-chat-search";
import { Icon } from "./components/ui/icon";
import "./tabs.css";

function candidateForThread(thread: PluginSidebarThread): TabCandidate {
  return {
    threadId: thread.id,
    projectId: thread.projectId,
    title: thread.title?.trim() || thread.titleFallback?.trim() || "Untitled",
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
): { candidate: TabCandidate; updatedAt: number } | null {
  let latest: PluginSidebarThread | null = null;
  for (const thread of threads) {
    if (!workIndex.directlyWorkingThreadIds.has(thread.id)) continue;
    if (latest === null || thread.updatedAt >= latest.updatedAt) latest = thread;
  }
  return latest === null
    ? null
    : {
        candidate: candidateForThread(rootThreadFor(latest, workIndex)),
        updatedAt: latest.updatedAt,
      };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function unavailableHistoryLabel(
  reason: TabHistoryUnavailableReason,
): "Archived" | "Deleted" {
  return reason === "archived" ? "Archived" : "Deleted";
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
const LEGACY_RIGHT_TAB_LIST_BUTTON_POSITION =
  "\u0421\u043f\u0440\u0430\u0432\u0430";

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

const ACTIVE_WORKFLOW_REVALIDATION_MS = 15_000;
const IDLE_WORKFLOW_REVALIDATION_MS = 30_000;
const HISTORY_MENU_PAGE_SIZE = 8;
const HISTORY_MORE_HOVER_DELAY_MS = 300;
const DOUBLE_SHIFT_INTERVAL_MS = 350;
const MENU_HOVER_DELAY_MS = 300;
const MENU_LEAVE_DELAY_MS = 120;

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
  const historyVisitInFlightRef = useRef<Promise<void> | null>(null);
  const historyVisitInFlightKeyRef = useRef<string | null>(null);
  const queuedHistoryVisitRef = useRef<HistoryVisitRequest | null>(null);

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
      if (latestCandidate !== undefined &&
          stateContainsCandidate(stateRef.current, latestCandidate)) {
        return Promise.resolve();
      }

      const drain = async () => {
        let next: ActivitySyncRequest | null = request;
        while (next !== null) {
          activitySyncInFlightKeyRef.current = next.key;
          const latest = next.threads.at(-1);
          if (latest === undefined || !stateContainsCandidate(stateRef.current, latest)) {
            try {
              const result = await rpcRef.current.call("tabs_sync_activity", {
                threads: next.threads,
              });
              acceptState(result.state);
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

      if (historyStartsWithCandidate(historyRef.current, request.candidate)) {
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
          if (!historyStartsWithCandidate(historyRef.current, next.candidate)) {
            try {
              const result = await rpcRef.current.call(
                "tabs_history_visit",
                next.candidate,
              );
              acceptHistory(result.history);
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
  unavailableReason: TabHistoryUnavailableReason | null;
}

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
          ? "Personal"
          : liveProject?.name || "Project",
        title:
          liveThread?.title?.trim() ||
          liveThread?.titleFallback?.trim() ||
          entry.title,
        unavailableReason: null,
      };
    });
}

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
  const resolveRpc = useRpc<typeof rpcContract>();
  const resolveRpcRef = useRef(resolveRpc);
  resolveRpcRef.current = resolveRpc;
  const isCompactTabLayout = useCompactTabLayout();
  const settings = useSettings();
  const sidebar = experimental_useSidebarThreads();
  const threadActions = experimental_useSidebarThreadActions();
  const showTabsOnCurrentLayout = isCompactTabLayout
    ? settings.values?.showTabsOnMobile !== false
    : settings.values?.showTabsOnDesktop !== false;
  const showTabListButton = settings.values?.showTabListButton !== false;
  const showTabListPinned = settings.values?.showTabListPinned !== false;
  const showTabListHistory = settings.values?.showTabListHistory !== false;
  const tabListButtonPosition =
    settings.values?.tabListButtonPosition === "Right" ||
    settings.values?.tabListButtonPosition === LEGACY_RIGHT_TAB_LIST_BUTTON_POSITION
      ? "right"
      : "left";
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
  const [tabSearch, setTabSearch] = useState("");
  const [selectedSearchIndex, setSelectedSearchIndex] = useState(-1);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const lastShiftReleaseRef = useRef<number | null>(null);
  const [historyVisibleCount, setHistoryVisibleCount] = useState(
    HISTORY_MENU_PAGE_SIZE,
  );
  const [historyMorePending, setHistoryMorePending] = useState(false);
  const [draggedTab, setDraggedTab] = useState<DraggedTab | null>(null);
  const [dropTarget, setDropTarget] = useState<TabDropTarget | null>(null);
  const draggedTabRef = useRef<DraggedTab | null>(null);
  const dropTargetRef = useRef<TabDropTarget | null>(null);
  const embeddedBrowserFocused = useRef(false);
  const inlineRenameSubmitting = useRef(false);
  const inlineRenameCancelled = useRef(false);
  const historyMoreTimerRef = useRef<number | null>(null);
  const listHoverOpenTimerRef = useRef<number | null>(null);
  const listHoverCloseTimerRef = useRef<number | null>(null);
  const listOpenedByHoverRef = useRef(false);

  const clearListHoverTimers = useCallback(() => {
    if (listHoverOpenTimerRef.current !== null) window.clearTimeout(listHoverOpenTimerRef.current);
    if (listHoverCloseTimerRef.current !== null) window.clearTimeout(listHoverCloseTimerRef.current);
    listHoverOpenTimerRef.current = null;
    listHoverCloseTimerRef.current = null;
  }, []);

  const enterTabListMenu = (pointerType: string) => {
    if (pointerType !== "mouse") return;
    if (listHoverCloseTimerRef.current !== null) window.clearTimeout(listHoverCloseTimerRef.current);
    listHoverCloseTimerRef.current = null;
    if (tabListMenuOpen || listHoverOpenTimerRef.current !== null) return;
    listHoverOpenTimerRef.current = window.setTimeout(() => {
      listHoverOpenTimerRef.current = null;
      listOpenedByHoverRef.current = true;
      setTabListMenuOpen(true);
    }, MENU_HOVER_DELAY_MS);
  };

  const leaveTabListMenu = (pointerType: string) => {
    if (pointerType !== "mouse") return;
    if (listHoverOpenTimerRef.current !== null) window.clearTimeout(listHoverOpenTimerRef.current);
    listHoverOpenTimerRef.current = null;
    if (!tabListMenuOpen) return;
    listHoverCloseTimerRef.current = window.setTimeout(() => {
      listHoverCloseTimerRef.current = null;
      setTabListMenuOpen(false);
    }, MENU_LEAVE_DELAY_MS);
  };

  useEffect(() => clearListHoverTimers, [clearListHoverTimers]);

  const renameTab = useCallback(
    async (entry: TabEntry, title: string) => {
      const normalizedTitle = normalizeTabTitle(title);
      if (normalizedTitle === null) {
        throw new Error("Enter a title between 1 and 300 characters.");
      }
      await threadActions.rename(entry.threadId, normalizedTitle);
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
        toast.error("Enter a chat title between 1 and 300 characters.");
        return;
      }
      if (normalizedTitle !== target.title) {
        await renameTab(target.entry, normalizedTitle);
      }
    } catch (cause) {
      toast.error(`Could not rename the chat: ${errorMessage(cause)}`);
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
        toast.success("Chat link copied");
      } else {
        toast.error("Could not copy the chat link");
      }
    },
    [context.threadId],
  );

  const markTabUnread = useCallback(
    async (entry: TabEntry) => {
      try {
        await threadActions.setRead(entry.threadId, false);
      } catch (cause) {
        toast.error(`Could not mark the chat as unread: ${errorMessage(cause)}`);
      }
    },
    [threadActions],
  );

  const archiveTab = useCallback(
    (entry: TabEntry) => {
      try {
        threadActions.archive(entry.threadId);
        void close(entry.threadId);
      } catch (cause) {
        toast.error(`Could not archive the chat: ${errorMessage(cause)}`);
      }
    },
    [close, threadActions],
  );

  const clearTabDrag = useCallback(() => {
    draggedTabRef.current = null;
    dropTargetRef.current = null;
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
      dropTargetRef.current = null;
      setDropTarget(null);
    },
    [],
  );

  const dropTargetForTab = useCallback(
    (entry: TabEntry, clientX: number, element: HTMLDivElement): TabDropTarget => {
      const rect = element.getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2 || state === null) {
        return { targetThreadId: entry.threadId, position: "before" };
      }
      const pinned = state.entries.filter((tab) => tab.pinned);
      const index = pinned.findIndex((tab) => tab.threadId === entry.threadId);
      const next = pinned[index + 1];
      return next === undefined
        ? { targetThreadId: entry.threadId, position: "after" }
        : { targetThreadId: next.threadId, position: "before" };
    },
    [state],
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
        dropTargetRef.current = null;
        setDropTarget(null);
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const nextTarget: TabDropTarget = { position, targetThreadId };
      dropTargetRef.current = nextTarget;
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

  const commitTabDrop = useCallback(
    (event: DragEvent<HTMLDivElement>, target: TabDropTarget | null) => {
      const source = draggedTabRef.current;
      if (
        source === null ||
        target === null ||
        state === null ||
        isNoopPinnedMove(
          state.entries,
          source.threadId,
          target.targetThreadId,
          target.position,
        )
      ) {
        clearTabDrag();
        return;
      }
      event.preventDefault();
      clearTabDrag();
      void move(source.threadId, target.targetThreadId, target.position);
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
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
  }, []);

  useEffect(() => {
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

  const sidebarCurrent = useMemo(() =>
    context.threadId === null ? null :
      sidebar.threads.find((thread) => thread.id === context.threadId) ?? null,
  [context.threadId, sidebar.threads]);
  const [resolvedCurrent, setResolvedCurrent] = useState<{
    threadId: string;
    candidate: TabCandidate | null;
  } | null>(null);
  useEffect(() => {
    if (context.threadId === null || sidebar.status !== "ready" || sidebarCurrent !== null) return;
    const threadId = context.threadId;
    let cancelled = false;
    let retryTimer: number | null = null;
    const resolve = () => {
      void resolveRpcRef.current.call("tabs_resolve_current", { threadId }).then(
        ({ candidate }) => {
          if (!cancelled) setResolvedCurrent({ threadId, candidate });
        },
        () => {
          // Transient SDK failures must neither create a fake chat nor leave
          // the viewed thread without a tab for the rest of this route visit.
          if (!cancelled) retryTimer = window.setTimeout(resolve, 5_000);
        },
      );
    };
    resolve();
    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [context.threadId, sidebar.status, sidebarCurrent !== null]);
  const currentCandidate = useMemo(() => {
    if (sidebar.status !== "ready" || context.threadId === null) return null;
    if (sidebarCurrent !== null) return candidateForThread(sidebarCurrent);
    return resolvedCurrent?.threadId === context.threadId
      ? resolvedCurrent.candidate : null;
  }, [context.threadId, sidebar.status, sidebarCurrent, resolvedCurrent]);
  const currentKey = candidateKey(currentCandidate);

  const currentHistoryId = currentCandidate?.threadId ?? null;
  useEffect(() => {
    if (!showTabsOnCurrentLayout || currentCandidate === null) return;
    void recordHistory(currentCandidate);
  }, [currentHistoryId, recordHistory, showTabsOnCurrentLayout]);

  const workingActivity = useMemo(
    () =>
      sidebar.status === "ready"
        ? latestWorkingCandidate(sidebar.threads, workIndex)
        : null,
    [sidebar.status, sidebar.threads, workIndex],
  );
  const latestActivity = workingActivity?.candidate ?? null;
  const activityKey = workingActivity === null
    ? ""
    : `${candidateKey(workingActivity.candidate)}\u0000${workingActivity.updatedAt}`;
  const workingHistory = useMemo(() => {
    const roots = new Map<string, { candidate: TabCandidate; updatedAt: number }>();
    if (sidebar.status !== "ready") return roots;
    for (const thread of sidebar.threads) {
      if (!workIndex.directlyWorkingThreadIds.has(thread.id)) continue;
      const candidate = candidateForThread(rootThreadFor(thread, workIndex));
      const previous = roots.get(candidate.threadId);
      if (previous === undefined || previous.updatedAt < thread.updatedAt) {
        roots.set(candidate.threadId, { candidate, updatedAt: thread.updatedAt });
      }
    }
    return roots;
  }, [sidebar.status, sidebar.threads, workIndex]);
  const lastRecordedActivityKeys = useRef(new Map<string, string>());
  const lastActivityVisitAt = useRef(new Map<string, number>());
  useEffect(() => {
    if (!showTabsOnCurrentLayout || context.threadId === null) return;
    const previous = lastRecordedActivityKeys.current;
    const lastVisitAt = lastActivityVisitAt.current;
    for (const id of previous.keys()) {
      if (!workingHistory.has(id)) {
        previous.delete(id);
        lastVisitAt.delete(id);
      }
    }
    const now = Date.now();
    const updates = [...workingHistory.values()]
      .filter(({ candidate, updatedAt }) => {
        const key = `${candidateKey(candidate)}\u0000${updatedAt}`;
        const previousKey = previous.get(candidate.threadId);
        if (previousKey === key) return false;
        // Runtime timestamps can change many times a second. A running chat
        // needs recent placement, not one history write per sidebar update.
        if (previousKey !== undefined &&
            now - (lastVisitAt.get(candidate.threadId) ?? 0) < 5_000) return false;
        previous.set(candidate.threadId, key);
        lastVisitAt.set(candidate.threadId, now);
        return true;
      })
      .sort((a, b) => a.updatedAt - b.updatedAt);
    void (async () => {
      for (const { candidate } of updates) await recordHistory(candidate);
    })();
  }, [context.threadId === null, recordHistory, showTabsOnCurrentLayout, workingHistory]);

  const lastCurrentKey = useRef<string | null>(null);
  const lastActivityKey = useRef<string | null>(null);
  useEffect(() => {
    if (!showTabsOnCurrentLayout && context.threadId !== null) return;
    if (state === null && context.threadId !== null) return;

    const currentChanged = currentKey !== lastCurrentKey.current;
    const activityChanged = activityKey !== lastActivityKey.current;
    lastCurrentKey.current = currentKey;
    if (
      currentCandidate !== null &&
      (currentChanged || !state?.entries.some((entry) => !entry.pinned)) &&
      !stateContainsCandidate(state, currentCandidate)
    ) {
      void syncActivity([currentCandidate]);
      return;
    }

    // The viewed chat owns the single preview. Background work can use it
    // only when the viewed chat is already pinned (or there is no current chat).
    const currentIsPinned = state?.entries.some(
      (entry) => entry.threadId === currentCandidate?.threadId && entry.pinned,
    );
    if (currentCandidate !== null && !currentIsPinned) return;
    lastActivityKey.current = activityKey;
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
  const newChatProjects = useMemo(
    () => recentProjects(sidebar.projects, sidebar.threads),
    [sidebar.projects, sidebar.threads],
  );
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
  const menuPinnedTabs = showTabListPinned ? pinnedMenuTabs : [];
  const menuHistoryTabs = showTabListHistory ? historyMenuTabs : [];
  const searchableTabs = useMemo(() => {
    const seen = new Set<string>();
    return [...menuPinnedTabs, ...menuHistoryTabs].filter((tab) => {
      if (tab.unavailableReason !== null || seen.has(tab.entry.threadId)) return false;
      seen.add(tab.entry.threadId);
      return true;
    });
  }, [menuPinnedTabs, menuHistoryTabs]);
  const searchActive = tabSearch.trim().length > 0;
  const searchResults = useMemo(
    () => fuzzyChatSearch(searchableTabs, tabSearch),
    [searchableTabs, tabSearch],
  );
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
    if (!tabListMenuOpen) {
      setTabSearch("");
      setSelectedSearchIndex(-1);
      return;
    }
    const timer = window.setTimeout(() => searchInputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [tabListMenuOpen]);
  useEffect(() => {
    const strip = stripRef.current;
    const topScrollbar = topScrollbarRef.current;
    const spacer = topScrollbarSpacerRef.current;
    if (strip === null || topScrollbar === null || spacer === null) return;

    const syncMetrics = () => {
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
      clearListHoverTimers();
      setTabListMenuOpen(false);
      clearHistoryMoreTimer();
      return;
    }
    if (!tabListMenuOpen || !showTabListHistory) clearHistoryMoreTimer();
  }, [
    clearHistoryMoreTimer,
    clearListHoverTimers,
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
      if (event.key !== "Shift") lastShiftReleaseRef.current = null;
      if (event.defaultPrevented) return;

      if (isCyclePluginTabsShortcut(event)) {
        const direction: TabCycleDirection = event.shiftKey
          ? "previous"
          : "next";
        if (!cycleTabsByKeyboard(direction)) return;
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (!isCloseCurrentTabShortcut(event)) {
        return;
      }

      if (
        embeddedBrowserFocused.current ||
        isBrowserChromeKeyboardTarget(event.target)
      ) {
        return;
      }

      if (currentEntry === null || closingCurrentTab.current) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      void closeCurrentTab();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== "Shift" || event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;
      if (!shouldDock || !tabListMenuHasNavigation || embeddedBrowserFocused.current ||
          inlineRename !== null || renameDialogTarget !== null ||
          isBrowserChromeKeyboardTarget(event.target)) return;
      const now = Date.now();
      if (lastShiftReleaseRef.current !== null &&
          now - lastShiftReleaseRef.current <= DOUBLE_SHIFT_INTERVAL_MS) {
        lastShiftReleaseRef.current = null;
        event.preventDefault();
        event.stopPropagation();
        clearListHoverTimers();
        setTabListMenuOpen(true);
        searchInputRef.current?.focus();
      } else {
        lastShiftReleaseRef.current = now;
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [closeCurrentTab, currentEntry, cycleTabsByKeyboard, shouldDock,
      tabListMenuHasNavigation, inlineRename, renameDialogTarget,
      clearListHoverTimers]);

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
        onDrop={(event) => commitTabDrop(event, { targetThreadId, position })}
      >
        <span className="bb-chat-tab-drop-slot-hit" aria-hidden="true" />
      </div>
    );
  };

  const renderTabListMenuItem = (tab: PresentedTab, searchIndex?: number) => {
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
        id={searchIndex === undefined ? undefined : `bb-chat-tabs-search-result-${searchIndex}`}
        data-selected={searchIndex === selectedSearchIndex ? "true" : undefined}
        className="bb-chat-tabs-list-menu-item"
        disabled={unavailableReason !== null}
        aria-current={active ? "page" : undefined}
        aria-label={
          unavailableLabel === null
            ? undefined
            : `${tab.title}. Project: ${tab.projectName}. ${unavailableLabel}. Chat unavailable.`
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
          if (!open) {
            clearListHoverTimers();
            clearHistoryMoreTimer();
          }
        }}
      >
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="bb-chat-tabs-list-trigger"
            aria-label="Open chat list"
            title="Open tab list"
            onPointerDown={() => { listOpenedByHoverRef.current = false; clearListHoverTimers(); }}
            onPointerEnter={(event) => enterTabListMenu(event.pointerType)}
            onPointerLeave={(event) => leaveTabListMenu(event.pointerType)}
            onPointerCancel={clearListHoverTimers}
          >
            <Icon name="ListView" className="bb-chat-tabs-list-icon" aria-hidden />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="bb-chat-tabs-list-menu"
            aria-label="Open chat list"
            side="bottom"
            align={tabListButtonPosition === "right" ? "end" : "start"}
            sideOffset={6}
            collisionPadding={8}
            onCloseAutoFocus={(event) => {
              if (listOpenedByHoverRef.current) event.preventDefault();
            }}
            onPointerEnter={(event) => enterTabListMenu(event.pointerType)}
            onPointerLeave={(event) => leaveTabListMenu(event.pointerType)}
          >
            <div className="bb-chat-tabs-list-menu-search">
              <Icon name="Search" className="bb-chat-tabs-list-menu-search-icon" aria-hidden />
              <input
                ref={searchInputRef}
                type="search"
                className="bb-chat-tabs-list-menu-search-input"
                aria-label="Search chats by title"
                aria-controls={searchActive ? "bb-chat-tabs-search-results" : undefined}
                aria-activedescendant={searchActive && selectedSearchIndex >= 0
                  ? `bb-chat-tabs-search-result-${selectedSearchIndex}` : undefined}
                placeholder="Search chats..."
                value={tabSearch}
                onChange={(event) => {
                  setTabSearch(event.target.value);
                  setSelectedSearchIndex(-1);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") return;
                  event.stopPropagation();
                  if (!searchActive) return;
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    setSelectedSearchIndex((current) => searchResults.length === 0 ? -1 :
                      event.key === "ArrowDown"
                        ? (current + 1) % searchResults.length
                        : (current - 1 + searchResults.length) % searchResults.length);
                  } else if (event.key === "Enter" && searchResults.length > 0) {
                    event.preventDefault();
                    const result = searchResults[selectedSearchIndex] ?? searchResults[0];
                    if (result !== undefined) {
                      setTabListMenuOpen(false);
                      openThread({ threadId: result.entry.threadId,
                        projectId: result.entry.projectId, title: result.title });
                    }
                  }
                }}
              />
            </div>
            {searchActive ? (
              <DropdownMenu.Group id="bb-chat-tabs-search-results" className="bb-chat-tabs-list-menu-search-results" aria-label="Search results">
                {searchResults.length > 0 ? searchResults.map((tab, index) =>
                  renderTabListMenuItem(tab, index)
                ) : <span className="bb-chat-tabs-list-menu-search-empty">No matching chats</span>}
              </DropdownMenu.Group>
            ) : null}
            {!searchActive && menuPinnedTabs.length > 0 ? (
              <DropdownMenu.Group className="bb-chat-tabs-list-menu-group">
                <DropdownMenu.Label className="bb-chat-tabs-list-menu-group-label">
                  Pinned
                </DropdownMenu.Label>
                {menuPinnedTabs.map(renderTabListMenuItem)}
              </DropdownMenu.Group>
            ) : null}
            {!searchActive && visibleHistoryMenuTabs.length > 0 ? (
              <DropdownMenu.Group className="bb-chat-tabs-list-menu-group">
                <DropdownMenu.Label className="bb-chat-tabs-list-menu-group-label">
                  History
                </DropdownMenu.Label>
                {visibleHistoryMenuTabs.map((tab, index) => (
                  <Fragment key={tab.entry.threadId}>
                    {index > 0 && index % HISTORY_MENU_PAGE_SIZE === 0 ? (
                      <DropdownMenu.Separator
                        className="bb-chat-tabs-list-menu-history-page-separator"
                        aria-label="Next history page"
                      />
                    ) : null}
                    {renderTabListMenuItem(tab)}
                  </Fragment>
                ))}
              </DropdownMenu.Group>
            ) : null}
            {!searchActive && hasMoreHistory ? (
              <DropdownMenu.Item
                className="bb-chat-tabs-list-menu-more"
                data-pending={historyMorePending ? "true" : "false"}
                aria-label={`Show ${Math.min(
                  HISTORY_MENU_PAGE_SIZE,
                  menuHistoryTabs.length - visibleHistoryMenuTabs.length,
                )} more history chats`}
                onPointerEnter={(event) => {
                  if (event.pointerType === "mouse") scheduleHistoryMore();
                }}
                onPointerLeave={clearHistoryMoreTimer}
                onPointerCancel={clearHistoryMoreTimer}
                onSelect={(event) => {
                  event.preventDefault();
                  clearHistoryMoreTimer();
                  loadMoreHistory();
                }}
              >
                <span>More</span>
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
          aria-label="Horizontal tab scroll"
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
            aria-label="Open chats"
            onDragOver={(event) => {
              if (draggedTabRef.current === null || dropTargetRef.current === null) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
            }}
            onDrop={(event) => commitTabDrop(event, dropTargetRef.current)}
            onDragLeave={(event) => {
              const next = event.relatedTarget;
              if (next instanceof Node && event.currentTarget.contains(next)) return;
              const rect = event.currentTarget.getBoundingClientRect();
              if (next === null && event.clientX >= rect.left && event.clientX <= rect.right &&
                  event.clientY >= rect.top && event.clientY <= rect.bottom) return;
              dropTargetRef.current = null;
              setDropTarget(null);
            }}
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
                      ? "nested work is running"
                      : "work is running";
                    const tabHint = [
                      `Project: ${projectName}`,
                      `Chat: ${title}`,
                      hasNestedWork ? "Nested work is running." : "",
                      isUnread ? "There are unread messages." : "",
                      "Click to open the chat.",
                      entry.pinned
                        ? "Drag to change the order."
                        : "",
                      preview ? "Double-click to pin this tab." : "",
                      "Middle-click to close this tab.",
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
                          onDragOver={entry.pinned ? (event) => {
                            const target = dropTargetForTab(entry, event.clientX, event.currentTarget);
                            handleDropSlotDragOver(event, target.targetThreadId, target.position);
                          } : undefined}
                          onDrop={entry.pinned ? (event) => {
                            const target = dropTargetForTab(entry, event.clientX, event.currentTarget);
                            commitTabDrop(event, target);
                          } : undefined}
                        >
                          {editing ? (
                            <input
                              autoFocus
                              className="bb-chat-tab-inline-rename"
                              aria-label={`Rename tab “${title}”`}
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
                              aria-description={`Click opens the chat. Project: ${projectName}.${
                                preview
                                  ? " Preview tab."
                                  : " Pinned tab. Drag it to change the order."
                              } Middle-click closes this tab.`}
                              aria-label={`${title}${
                                isWorking ? `, ${workLabel}` : ""
                              }${
                                isUnread ? ", unread messages" : ""
                              }`}
                              title={tabHint}
                              onMouseDown={(event) => {
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
                            aria-label={`Close tab “${title}”`}
                            title="Close tab"
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
            <NewChatSwitcher
              projects={newChatProjects}
              openNewThread={threadActions.openNewThread}
            />
            {error === null ? null : (
              <span className="bb-chat-tabs-error" role="status" title={error}>
                Tabs unavailable
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

function PinnedTabsHomepageSection(_props: PluginHomepageSectionProps) {
  const settings = useSettings();
  const sidebar = experimental_useSidebarThreads();
  const threadActions = experimental_useSidebarThreadActions();
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
    title: "Pinned chats",
    component: PinnedTabsHomepageSection,
  });
  app.slots.experimental_appOverlay({
    id: "chat-tabs",
    component: ChatTabsOverlay,
  });
});
