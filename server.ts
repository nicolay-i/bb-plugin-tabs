import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { LANGUAGE_OPTIONS } from "./lib/languages";
import { SETTINGS } from "./lib/settings";
import { fuzzyChatSearch } from "./lib/fuzzy-chat-search";
import { z } from "zod";
import {
  createEmptyTabHistory,
  normalizeTabHistory,
  setTabHistoryAvailability,
  tabHistoriesEqual,
  TABS_HISTORY_CHANGED_CHANNEL,
  visitTabHistory,
  type TabHistoryAvailability,
  type TabHistoryState,
  type TabHistoryUnavailableReason,
} from "./lib/tab-history";
import {
  addTabCandidates,
  closeTab,
  closeTabs,
  createEmptyTabsState,
  movePinnedTab,
  normalizeTabsState,
  openTabCandidate,
  setTabPinned,
  tabsStatesEqual,
  TABS_CHANGED_CHANNEL,
  type TabCandidate,
  type TabEntry,
  type TabsState,
} from "./lib/tabs-model";

const STATE_KEY = "tabs.state.v1";
const HISTORY_KEY = "tabs.history.v1";
const CLOSED_THREADS_KEY = "tabs.closedThreads.v1";
const MAX_WORKFLOW_RPC_CONCURRENCY = 8;
const MAX_THREAD_AVAILABILITY_CONCURRENCY = 8;
const THREAD_AVAILABILITY_RETRY_MS = 30_000;

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const tabCandidateSchema = z
  .object({
    threadId: z.string().trim().min(1).max(200),
    projectId: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(300),
  })
  .strict();

const tabEntrySchema = tabCandidateSchema.extend({
  pinned: z.boolean(),
  openedAt: z.number().finite().nonnegative(),
});

const tabHistoryEntrySchema = tabCandidateSchema.extend({
  visitedAt: z.number().finite().nonnegative(),
  // Optional preserves compatibility with V1 history saved before tombstones.
  unavailableReason: z.enum(["archived", "deleted"]).optional(),
});

const tabHistoryStateSchema = z
  .object({
    version: z.literal(1),
    entries: z.array(tabHistoryEntrySchema).max(100),
  })
  .strict();

const tabMoveSchema = z
  .object({
    sourceThreadId: z.string().trim().min(1).max(200),
    targetThreadId: z.string().trim().min(1).max(200),
    position: z.enum(["before", "after"]),
  })
  .strict();

const tabsStateSchema = z
  .object({
    version: z.literal(1),
    entries: z.array(tabEntrySchema).max(100),
  })
  .strict();

/*
 * `workflows` publishes this RPC through its standard public plugin API. Tabs
 * only needs its status; the full workflow view is intentionally not duplicated
 * here, so the tabs plugin does not depend on workflow UI details.
 */
const workflowActiveRunsResponseSchema = z
  .object({
    runs: z.array(z.object({ status: z.string() }).passthrough()),
  })
  .passthrough();

export const rpcContract = defineRpcContract({
  tabs_settings_update: {
    input: z.object({
      language: z.enum(LANGUAGE_OPTIONS).optional(),
      searchArchivedChats: z.boolean().optional(),
      showPinnedTabsList: z.boolean().optional(),
      showTabsOnDesktop: z.boolean().optional(),
      showTabsOnMobile: z.boolean().optional(),
      showTabListButton: z.boolean().optional(),
      showTabListPinned: z.boolean().optional(),
      showTabListHistory: z.boolean().optional(),
      tabListButtonPosition: z.enum(["Left", "Right"]).optional(),
    }).strict().refine((values) => Object.keys(values).length > 0, "No settings supplied"),
    output: z.object({ values: z.record(z.string(), z.union([z.string(), z.boolean(), z.number()])) }).strict(),
  },
  tabs_search: {
    input: z.object({ query: z.string().trim().min(1).max(300), includeArchived: z.boolean().optional() }).strict(),
    output: z.object({ candidates: z.array(tabCandidateSchema.extend({ archived: z.boolean().optional(), projectName: z.string().optional() })).max(30) }).strict(),
  },
  tabs_list: {
    // The frontend also supplies descendants of open tabs, so durable work in a
    // nested chat can be folded into its parent.
    input: z
      .object({
        workflowThreadIds: z
          .array(z.string().trim().min(1).max(200))
          .max(100),
      })
      .strict()
      .nullable(),
    output: z
      .object({
        state: tabsStateSchema,
        // Optional preserves compatibility with app bundles already loaded when
        // the plugin reloads.
        activeWorkflowThreadIds: z
          .array(z.string().trim().min(1).max(200))
          .max(100)
          .optional(),
        // Optional preserves compatibility with an app bundle loaded before
        // plugin-owned visit history was added.
        history: tabHistoryStateSchema.optional(),
      })
      .strict(),
  },
  /** Resolves the viewed chat when the sidebar snapshot omits it. */
  tabs_resolve_current: {
    input: z.object({ threadId: z.string().trim().min(1).max(200) }).strict(),
    output: z.object({
      candidate: tabCandidateSchema.nullable(),
      createdAt: z.number().finite().nonnegative().optional(),
    }).strict(),
  },
  /** Updates the one preview tab from the latest active candidate. */
  tabs_sync_activity: {
    input: z
      .object({
        threads: z.array(tabCandidateSchema).max(100),
        // A real route transition may reopen a closed tab; a stale renderer may not.
        reopen: z.boolean().optional(),
      })
      .strict(),
    output: z.object({ state: tabsStateSchema }).strict(),
  },
  /** Moves a visited chat to the start of the separate menu history. */
  tabs_history_visit: {
    input: tabCandidateSchema,
    output: z.object({ history: tabHistoryStateSchema }).strict(),
  },
  /** Explicitly pins the current chat, even if it has no active work. */
  tabs_open: {
    input: tabCandidateSchema,
    output: z.object({ state: tabsStateSchema }).strict(),
  },
  tabs_set_pinned: {
    input: z
      .object({ threadId: z.string().trim().min(1).max(200), pinned: z.boolean() })
      .strict(),
    output: z.object({ state: tabsStateSchema }).strict(),
  },
  tabs_close: {
    input: z.object({ threadId: z.string().trim().min(1).max(200) }).strict(),
    output: z
      .object({ state: tabsStateSchema, removed: z.boolean() })
      .strict(),
  },
  /** Moves two pinned tabs in their shared horizontal strip. */
  tabs_move: {
    input: tabMoveSchema,
    output: z.object({ state: tabsStateSchema }).strict(),
  },
});

/**
 * Persists the top-tab list in plugin-owned KV. Every change flows through one
 * queue so two windows cannot lose each other's tabs between `get` and `set`.
 */
export default async function plugin(bb: BbPluginApi) {
  const settingsHandle = bb.settings.define({
    ...SETTINGS,
    language: { ...SETTINGS.language, options: [...SETTINGS.language.options] },
    tabListButtonPosition: { ...SETTINGS.tabListButtonPosition, options: [...SETTINGS.tabListButtonPosition.options] },
  });

  type TabsSnapshot = {
    state: TabsState;
    history: TabHistoryState;
  };

  let mutationTail: Promise<void> = Promise.resolve();
  let workflowRpcRetryAt = 0;
  const tabsListInFlight = new Map<
    string,
    Promise<{
      state: TabsState;
      activeWorkflowThreadIds: string[];
      history: TabHistoryState;
    }>
  >();
  const activitySyncInFlight = new Map<string, Promise<{ state: TabsState }>>();
  const historyVisitInFlight = new Map<
    string,
    Promise<{ history: TabHistoryState }>
  >();
  const workflowStatusInFlight = new Map<string, Promise<boolean>>();
  // An ID is reconciled once per plugin generation; lifecycle events deliver
  // subsequent changes. This adds no polling to tabs_list.
  const threadAvailabilityById = new Map<string, TabHistoryAvailability>();
  const threadAvailabilityInFlight = new Map<
    string,
    Promise<TabHistoryAvailability | undefined>
  >();
  const threadAvailabilityRetryAt = new Map<string, number>();

  async function readState(): Promise<TabsState> {
    const stored = await bb.storage.kv.get<unknown>(STATE_KEY);
    return stored === undefined ? createEmptyTabsState() : normalizeTabsState(stored);
  }

  async function readClosedThreadIds(): Promise<string[]> {
    const stored = await bb.storage.kv.get<unknown>(CLOSED_THREADS_KEY);
    return Array.isArray(stored)
      ? [...new Set(stored.filter((id): id is string => typeof id === "string" && id.length > 0))].slice(-100)
      : [];
  }

  async function readHistory(): Promise<TabHistoryState> {
    const stored = await bb.storage.kv.get<unknown>(HISTORY_KEY);
    return stored === undefined ? createEmptyTabHistory() : normalizeTabHistory(stored);
  }

  async function readSnapshotAfterPendingMutations(): Promise<TabsSnapshot> {
    await mutationTail;
    const [state, history] = await Promise.all([readState(), readHistory()]);
    return { state, history };
  }

  /** One concurrent workflowActiveRuns query per thread across all tabs_list calls. */
  async function workflowThreadIsActive(threadId: string): Promise<boolean> {
    const existing = workflowStatusInFlight.get(threadId);
    if (existing !== undefined) return existing;

    const operation = (async () => {
      const result = await bb.sdk.plugins.callRpc<{
        runs: Array<{ status: string }>;
      }>({
        pluginId: "workflows",
        method: "workflowActiveRuns",
        input: { threadId },
        outputSchema: workflowActiveRunsResponseSchema,
      });
      return result.runs.some(
        (run) => run.status === "queued" || run.status === "running",
      );
    })();
    workflowStatusInFlight.set(threadId, operation);
    try {
      return await operation;
    } finally {
      if (workflowStatusInFlight.get(threadId) === operation) {
        workflowStatusInFlight.delete(threadId);
      }
    }
  }

  /**
   * A workflow can run in an origin chat while the sidebar still reports
   * `activity: 0`. Query the built-in plugin's official RPC, and quietly fall
   * back to sidebar activity when it is unavailable or incompatible.
   */
  async function activeWorkflowThreadIds(
    entries: readonly TabEntry[],
    additionalThreadIds: readonly string[] = [],
  ): Promise<string[]> {
    if (Date.now() < workflowRpcRetryAt) return [];

    const threadIds = [
      ...new Set([
        ...entries.map((entry) => entry.threadId),
        ...additionalThreadIds,
      ]),
    ].slice(0, 100);
    const activeThreadIds = new Set<string>();
    let nextIndex = 0;
    let failed = false;
    let failure: unknown;

    const worker = async () => {
      while (!failed) {
        const threadId = threadIds[nextIndex];
        nextIndex += 1;
        if (threadId === undefined) return;
        try {
          if (await workflowThreadIsActive(threadId)) {
            activeThreadIds.add(threadId);
          }
        } catch (cause) {
          failed = true;
          failure = cause;
        }
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(MAX_WORKFLOW_RPC_CONCURRENCY, threadIds.length) },
        () => worker(),
      ),
    );

    if (failed) {
      // A disabled workflows plugin is not a tabs error, and a failure must not
      // cause a hundred repeated requests on every poll.
      workflowRpcRetryAt = Date.now() + 30_000;
      bb.log.warn(
        `Could not read active workflows; using sidebar activity: ${errorMessage(failure)}`,
      );
    }

    // Preserve tab/descendant order independently of RPC response order.
    return threadIds.filter((threadId) => activeThreadIds.has(threadId));
  }

  /**
   * State and history share one serial queue. This is important for lifecycle:
   * archive → unarchive must not leave an old tombstone from independently
   * scheduled KV mutations.
   */
  function mutateSnapshots(
    apply: (current: TabsSnapshot) => TabsSnapshot,
  ): Promise<TabsSnapshot> {
    const operation = mutationTail.then(async () => {
      const [state, history] = await Promise.all([readState(), readHistory()]);
      const current: TabsSnapshot = { state, history };
      const changed = apply(current);
      const next: TabsSnapshot = {
        state: normalizeTabsState(changed.state),
        history: normalizeTabHistory(changed.history),
      };
      if (!tabsStatesEqual(current.state, next.state)) {
        await bb.storage.kv.set(STATE_KEY, next.state);
        bb.realtime.publish(TABS_CHANGED_CHANNEL, next.state);
      }
      if (!tabHistoriesEqual(current.history, next.history)) {
        await bb.storage.kv.set(HISTORY_KEY, next.history);
        bb.realtime.publish(TABS_HISTORY_CHANGED_CHANNEL, next.history);
      }
      return next;
    });
    mutationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  // Frequent activity, pin, and history operations retain their minimal I/O:
  // an atomic state-and-history pair is only needed for lifecycle reconciliation.
  function mutateHistory(
    apply: (current: TabHistoryState) => TabHistoryState,
  ): Promise<TabHistoryState> {
    const operation = mutationTail.then(async () => {
      const current = await readHistory();
      const next = normalizeTabHistory(apply(current));
      if (!tabHistoriesEqual(current, next)) {
        await bb.storage.kv.set(HISTORY_KEY, next);
        bb.realtime.publish(TABS_HISTORY_CHANGED_CHANNEL, next);
      }
      return next;
    });
    mutationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  function mutate(
    apply: (current: TabsState, closedIds: readonly string[]) => TabsState,
    updateClosedIds?: (current: TabsState, next: TabsState, closedIds: readonly string[]) => string[],
  ): Promise<TabsState> {
    const operation = mutationTail.then(async () => {
      const current = await readState();
      const closedIds = updateClosedIds === undefined ? [] : await readClosedThreadIds();
      const next = normalizeTabsState(apply(current, closedIds));
      const updatedClosedIds = updateClosedIds?.(current, next, closedIds);
      if (updatedClosedIds !== undefined &&
          (updatedClosedIds.length !== closedIds.length ||
            updatedClosedIds.some((id, index) => id !== closedIds[index]))) {
        await bb.storage.kv.set(CLOSED_THREADS_KEY, updatedClosedIds);
      }
      if (!tabsStatesEqual(current, next)) {
        await bb.storage.kv.set(STATE_KEY, next);
        bb.realtime.publish(TABS_CHANGED_CHANNEL, next);
      }
      return next;
    });
    mutationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  function isThreadNotFoundError(cause: unknown): boolean {
    if (typeof cause !== "object" || cause === null) return false;
    const error = cause as {
      code?: unknown;
      status?: unknown;
      statusCode?: unknown;
    };
    return (
      error.code === "not_found" ||
      error.status === 404 ||
      error.statusCode === 404
    );
  }

  /**
   * Returns `undefined` when the status cannot be verified without a risk of
   * falsely calling a chat deleted (for example, a transient or permission
   * failure).
   */
  async function resolveThreadAvailability(
    threadId: string,
  ): Promise<TabHistoryAvailability | undefined> {
    if (threadAvailabilityById.has(threadId)) {
      return threadAvailabilityById.get(threadId);
    }
    if ((threadAvailabilityRetryAt.get(threadId) ?? 0) > Date.now()) {
      return undefined;
    }
    const existing = threadAvailabilityInFlight.get(threadId);
    if (existing !== undefined) return existing;

    const operation = (async () => {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        const availability: TabHistoryAvailability =
          thread.deletedAt !== null
            ? "deleted"
            : thread.archivedAt !== null
              ? "archived"
              : null;
        threadAvailabilityById.set(threadId, availability);
        threadAvailabilityRetryAt.delete(threadId);
        return availability;
      } catch (cause) {
        if (isThreadNotFoundError(cause)) {
          threadAvailabilityById.set(threadId, "deleted");
          threadAvailabilityRetryAt.delete(threadId);
          return "deleted";
        }
        // Do not hide a chat after a transient or permission failure. Retry is
        // bounded so tabs_list does not become a frequent source of log errors.
        threadAvailabilityRetryAt.set(
          threadId,
          Date.now() + THREAD_AVAILABILITY_RETRY_MS,
        );
        return undefined;
      }
    })();
    threadAvailabilityInFlight.set(threadId, operation);
    try {
      return await operation;
    } finally {
      if (threadAvailabilityInFlight.get(threadId) === operation) {
        threadAvailabilityInFlight.delete(threadId);
      }
    }
  }

  async function resolveTrackedThreadAvailability(
    threadIds: Iterable<string>,
  ): Promise<Map<string, TabHistoryAvailability>> {
    const ids = [...new Set(threadIds)];
    const resolved = new Map<string, TabHistoryAvailability>();
    let nextIndex = 0;

    const worker = async () => {
      while (true) {
        const threadId = ids[nextIndex];
        nextIndex += 1;
        if (threadId === undefined) return;
        const availability = await resolveThreadAvailability(threadId);
        if (availability !== undefined) resolved.set(threadId, availability);
      }
    };

    await Promise.all(
      Array.from(
        {
          length: Math.min(MAX_THREAD_AVAILABILITY_CONCURRENCY, ids.length),
        },
        () => worker(),
      ),
    );
    return resolved;
  }

  /**
   * On cold start, reconcile no more than 200 plugin-owned IDs (100 tabs plus
   * 100 history records). The result remains cached until a lifecycle event.
   */
  async function reconcileTrackedThreadAvailability(
    snapshot: TabsSnapshot,
  ): Promise<TabsSnapshot> {
    const availability = await resolveTrackedThreadAvailability([
      ...snapshot.state.entries.map((entry) => entry.threadId),
      ...snapshot.history.entries.map((entry) => entry.threadId),
    ]);
    if (availability.size === 0) return snapshot;

    const unavailableThreadIds = [...availability]
      .filter(([, status]) => status !== null)
      .map(([threadId]) => threadId);
    return mutateSnapshots(({ state, history }) => ({
      state: closeTabs(state, unavailableThreadIds),
      history: setTabHistoryAvailability(history, availability),
    }));
  }

  async function applyThreadAvailability(
    threadId: string,
    availability: TabHistoryAvailability,
  ): Promise<void> {
    threadAvailabilityById.set(threadId, availability);
    threadAvailabilityRetryAt.delete(threadId);
    const updates = new Map<string, TabHistoryAvailability>([
      [threadId, availability],
    ]);
    await mutateSnapshots(({ state, history }) => ({
      // Unarchive makes the history entry clickable again, but deliberately
      // does not restore its old pin or preview: archive already closed state.
      state: availability === null ? state : closeTabs(state, [threadId]),
      history: setTabHistoryAvailability(history, updates),
    }));
  }

  // Events can also arrive for cascade-archived child chats. `closeTabs` is
  // idempotent, so it safely handles both roots and children.
  bb.events.on("thread.archived", async ({ thread }) => {
    await applyThreadAvailability(thread.id, "archived");
  });
  bb.events.on("thread.deleted", async ({ thread }) => {
    await applyThreadAvailability(thread.id, "deleted");
  });
  bb.events.on("thread.unarchived", async ({ thread }) => {
    await applyThreadAvailability(thread.id, null);
  });

  // Read only chat/project metadata, not message content. Shared across renderers.
  type SearchCandidate = TabCandidate & { archived?: boolean; projectName?: string };
  const searchCache = new Map<boolean, { candidates: SearchCandidate[]; expiresAt: number }>();
  const searchInFlight = new Map<boolean, Promise<SearchCandidate[]>>();
  const searchCandidates = async (includeArchived: boolean): Promise<SearchCandidate[]> => {
    const cached = searchCache.get(includeArchived);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.candidates;
    const existing = searchInFlight.get(includeArchived);
    if (existing !== undefined) return existing;
    const operation = (async () => {
      // Preserve title search if project metadata is temporarily unavailable.
      const projects = await bb.sdk.projects.list({ includePersonal: true }).catch(() => []);
      const projectNames = new Map(projects.map((project) => [project.id, project.name]));
      const candidates: SearchCandidate[] = [];
      const seen = new Set<string>();
      const pageSize = 200;
      for (const archived of includeArchived ? [false, true] : [false]) {
        for (let offset = 0; ; offset += pageSize) {
          const page = await bb.sdk.threads.list({ archived, includeHidden: false, limit: pageSize, offset });
          for (const thread of page) {
            if ((!includeArchived && thread.archivedAt !== null) || thread.deletedAt !== null || thread.visibility === "hidden" || seen.has(thread.id)) continue;
            seen.add(thread.id);
            candidates.push({ threadId: thread.id, projectId: thread.projectId,
              title: thread.title?.trim() || thread.titleFallback?.trim() || "Untitled",
              ...(projectNames.has(thread.projectId) ? { projectName: projectNames.get(thread.projectId) } : {}),
              ...(thread.archivedAt !== null ? { archived: true } : {}),
            });
          }
          if (page.length < pageSize) break;
        }
      }
      searchCache.set(includeArchived, { candidates, expiresAt: Date.now() + 30_000 });
      return candidates;
    })();
    searchInFlight.set(includeArchived, operation);
    try { return await operation; }
    finally { searchInFlight.delete(includeArchived); }
  };

  bb.rpc.register(rpcContract, {
    tabs_settings_update: async (values) => ({ values: await settingsHandle.experimental_set(values) }),
    tabs_search: async ({ query, includeArchived }) => ({ candidates: fuzzyChatSearch(await searchCandidates(includeArchived === true), query) }),
    tabs_list: async (input) => {
      // Multiple renderer surfaces or Strict Mode can request the same snapshot
      // together. Avoid duplicating KV reads and up to 100 nested workflow RPCs;
      // mutations and realtime still invalidate clients.
      const requestKey = [...new Set(input?.workflowThreadIds ?? [])]
        .sort()
        .join("\u0000");
      const existing = tabsListInFlight.get(requestKey);
      if (existing !== undefined) return existing;

      const operation = (async () => {
        // In a fresh server generation, one bounded lookup for each retained ID
        // lifts old archive/delete state into the event model. Afterwards cache
        // and lifecycle events add no network activity to polling.
        const snapshot = await reconcileTrackedThreadAvailability(
          await readSnapshotAfterPendingMutations(),
        );
        const activeWorkflowIds = await activeWorkflowThreadIds(
          snapshot.state.entries,
          input?.workflowThreadIds,
        );
        return {
          state: snapshot.state,
          activeWorkflowThreadIds: activeWorkflowIds,
          history: snapshot.history,
        };
      })();
      tabsListInFlight.set(requestKey, operation);
      try {
        return await operation;
      } finally {
        if (tabsListInFlight.get(requestKey) === operation) {
          tabsListInFlight.delete(requestKey);
        }
      }
    },
    tabs_resolve_current: async ({ threadId }) => {
      const thread = await bb.sdk.threads.get({ threadId });
      return {
        createdAt: thread.createdAt,
        candidate: thread.archivedAt !== null || thread.deletedAt !== null
          ? null
          : {
              threadId: thread.id,
              projectId: thread.projectId,
              title: thread.title?.trim() || thread.titleFallback?.trim() || "Untitled",
            },
      };
    },
    tabs_sync_activity: async ({ threads, reopen }) => {
      // Two windows can observe the same sidebar snapshot at once. Coalesce
      // exact input before the mutation queue while preserving candidate order
      // and therefore the “latest becomes preview” semantics.
      const requestKey = JSON.stringify({ threads, reopen: reopen === true });
      const existing = activitySyncInFlight.get(requestKey);
      if (existing !== undefined) return existing;

      const operation = (async () => ({
        state: await mutate(
          (current, closedIds) => {
            const candidate = threads.at(-1);
            if (candidate !== undefined && reopen !== true && closedIds.includes(candidate.threadId)) {
              return current;
            }
            return addTabCandidates(current, threads as TabCandidate[], Date.now());
          },
          (_current, _next, closedIds) => reopen === true
            ? closedIds.filter((id) => id !== threads.at(-1)?.threadId)
            : [...closedIds],
        ),
      }))();
      activitySyncInFlight.set(requestKey, operation);
      try {
        return await operation;
      } finally {
        if (activitySyncInFlight.get(requestKey) === operation) {
          activitySyncInFlight.delete(requestKey);
        }
      }
    },
    tabs_history_visit: async (candidate) => {
      const requestKey = JSON.stringify(candidate);
      const existing = historyVisitInFlight.get(requestKey);
      if (existing !== undefined) return existing;

      const operation = (async () => ({
        history: await mutateHistory((current) =>
          visitTabHistory(current, candidate as TabCandidate, Date.now()),
        ),
      }))();
      historyVisitInFlight.set(requestKey, operation);
      try {
        return await operation;
      } finally {
        if (historyVisitInFlight.get(requestKey) === operation) {
          historyVisitInFlight.delete(requestKey);
        }
      }
    },
    tabs_open: async (thread) => ({
      state: await mutate(
        (current) => openTabCandidate(current, thread as TabCandidate, Date.now()),
        (_current, _next, closedIds) => closedIds.filter((id) => id !== thread.threadId),
      ),
    }),
    tabs_set_pinned: async ({ threadId, pinned }) => ({
      state: await mutate((current) => setTabPinned(current, threadId, pinned)),
    }),
    tabs_close: async ({ threadId }) => {
      let removed = false;
      const state = await mutate(
        (current) => {
          const next = closeTab(current, threadId);
          removed = next.entries.length !== current.entries.length;
          return next;
        },
        (_current, _next, closedIds) => removed
          ? [...closedIds.filter((id) => id !== threadId), threadId].slice(-100)
          : [...closedIds],
      );
      return { state, removed };
    },
    tabs_move: async ({ sourceThreadId, targetThreadId, position }) => ({
      state: await mutate((current) =>
        movePinnedTab(current, sourceThreadId, targetThreadId, position),
      ),
    }),
  });

  bb.log.info("Chat tabs loaded");
}
