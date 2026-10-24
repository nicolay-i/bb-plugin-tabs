import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { randomUUID } from "node:crypto";
import { LANGUAGE_OPTIONS } from "./lib/languages";
import { SETTINGS } from "./lib/settings";
import {
  appearanceUpdateSchema,
  readTabAppearance,
  updateTabAppearance,
} from "./lib/tab-appearance";
import {
  sidechatActivitySchema,
  SIDECHAT_ACTIVITY_CHANGED_CHANNEL,
  type SidechatActivity,
} from "./lib/thread-work";
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
} from "./lib/tab-history";
import {
  addTabCandidates,
  closeTab,
  createEmptyTabsState,
  tabCandidateSchema,
  tabEntrySchema,
  tabsStateSchema,
  restoreClosedTab,
  movePinnedTab,
  normalizeTabsState,
  openTabCandidate,
  setTabPinned,
  setTabFavorite,
  tabsStatesEqual,
  TABS_CHANGED_CHANNEL,
  type TabCandidate,
  type TabEntry,
  type TabsState,
} from "./lib/tabs-model";

import {
  addWorkspace,
  createInitialWorkspaces,
  closeWorkspaceThreads,
  DEFAULT_WORKSPACE_ID,
  deleteWorkspace,
  getWorkspace,
  renameWorkspace,
  workspaceCollectionSchema,
  workspaceInfos,
  workspaceInfoSchema,
  workspaceStateChannel,
  MAX_WORKSPACE_CLOSED_IDS,
  stateRevisionSchema,
  WORKSPACES_CHANGED_CHANNEL,
  WORKSPACE_MEMBERSHIPS_CHANGED_CHANNEL,
  type WorkspaceCollection,
} from "./lib/workspaces";

const workspaceIdSchema = z.string().trim().min(1).max(200);
const workspaceInput = { workspaceId: workspaceIdSchema.optional() };
const workspaceNameSchema = workspaceInfoSchema.shape.name;
const workspaceListOutput = z
  .object({
    workspaces: z.array(workspaceInfoSchema).min(1).max(20),
    stateRevision: stateRevisionSchema.optional(),
  })
  .strict();

const tabsResultSchema = z
  .object({ state: tabsStateSchema, stateRevision: stateRevisionSchema.optional() })
  .strict();

const STATE_KEY = "tabs.state.v1";
const HISTORY_KEY = "tabs.history.v1";
const CLOSED_THREADS_KEY = "tabs.closedThreads.v1";
const MAX_WORKFLOW_RPC_CONCURRENCY = 8;
const MAX_THREAD_AVAILABILITY_CONCURRENCY = 8;
const THREAD_AVAILABILITY_RETRY_MS = 30_000;

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

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
  tabs_workspaces_list: { input: z.null(), output: workspaceListOutput },
  tabs_pinned_list: {
    input: z.null(),
    output: z
      .object({
        entries: z.array(tabEntrySchema).max(2000),
        stateRevision: stateRevisionSchema,
      })
      .strict(),
  },
  tabs_workspace_memberships: {
    input: z.object({ threadId: tabCandidateSchema.shape.threadId }).strict(),
    output: z
      .object({
        stateRevision: stateRevisionSchema,
        workspaces: z
          .array(workspaceInfoSchema.extend({ included: z.boolean() }))
          .min(1)
          .max(20),
      })
      .strict(),
  },
  tabs_workspace_create: {
    input: z.object({ name: workspaceNameSchema }).strict(),
    output: workspaceListOutput.extend({ workspaceId: workspaceIdSchema }),
  },
  tabs_workspace_rename: {
    input: z.object({ workspaceId: workspaceIdSchema, name: workspaceNameSchema }).strict(),
    output: workspaceListOutput,
  },
  tabs_workspace_delete: {
    input: z.object({ workspaceId: workspaceIdSchema }).strict(),
    output: workspaceListOutput,
  },
  tabs_appearance_update: {
    input: appearanceUpdateSchema,
    output: z
      .object({ values: z.record(z.string(), z.union([z.string(), z.boolean(), z.number()])) })
      .strict(),
  },
  tabs_settings_update: {
    input: z
      .object({
        language: z.enum(LANGUAGE_OPTIONS).optional(),
        searchArchivedChats: z.boolean().optional(),
        enableWorkspaces: z.boolean().optional(),
        showPinnedTabsList: z.boolean().optional(),
        showTabsOnDesktop: z.boolean().optional(),
        showTabsOnMobile: z.boolean().optional(),
        showTabListButton: z.boolean().optional(),
        showTabListPinned: z.boolean().optional(),
        showTabListHistory: z.boolean().optional(),
        showChatListAsTree: z.boolean().optional(),
        tabListButtonPosition: z.enum(["Left", "Right"]).optional(),
      })
      .strict()
      .refine((values) => Object.keys(values).length > 0, "No settings supplied"),
    output: z
      .object({ values: z.record(z.string(), z.union([z.string(), z.boolean(), z.number()])) })
      .strict(),
  },
  tabs_search: {
    input: z
      .object({ query: z.string().trim().min(1).max(300), includeArchived: z.boolean().optional() })
      .strict(),
    output: z
      .object({
        candidates: z
          .array(
            tabCandidateSchema.extend({
              archived: z.boolean().optional(),
              projectName: z.string().optional(),
            }),
          )
          .max(30),
      })
      .strict(),
  },
  tabs_list: {
    // The frontend also supplies descendants of open tabs, so durable work in a
    // nested chat can be folded into its parent.
    input: z
      .object({
        workflowThreadIds: z.array(z.string().trim().min(1).max(200)).max(100),
        // null explicitly discovers the first workspace; absent preserves legacy Work.
        workspaceId: workspaceIdSchema.nullable().optional(),
      })
      .strict()
      .nullable(),
    output: z
      .object({
        state: tabsStateSchema,
        stateRevision: stateRevisionSchema.optional(),
        workspaceId: workspaceIdSchema.optional(),
        workspaces: z.array(workspaceInfoSchema).min(1).max(20).optional(),
        // Optional preserves compatibility with app bundles already loaded when
        // the plugin reloads.
        activeWorkflowThreadIds: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
        sidechatActivity: sidechatActivitySchema.optional(),
        // Optional preserves compatibility with an app bundle loaded before
        // plugin-owned visit history was added.
        history: tabHistoryStateSchema.optional(),
      })
      .strict(),
  },
  /** Resolves the viewed chat when the sidebar snapshot omits it. */
  tabs_resolve_current: {
    input: z.object({ threadId: z.string().trim().min(1).max(200) }).strict(),
    output: z
      .object({
        candidate: tabCandidateSchema.nullable(),
        createdAt: z.number().finite().nonnegative().optional(),
      })
      .strict(),
  },
  /** Updates the one preview tab from the latest active candidate. */
  tabs_sync_activity: {
    input: z
      .object({
        ...workspaceInput,
        threads: z.array(tabCandidateSchema).max(100),
        // A real route transition may reopen a closed tab; a stale renderer may not.
        reopen: z.boolean().optional(),
      })
      .strict(),
    output: tabsResultSchema,
  },
  /** Moves a visited chat to the start of the separate menu history. */
  tabs_history_visit: {
    input: tabCandidateSchema,
    output: z.object({ history: tabHistoryStateSchema }).strict(),
  },
  /** Explicitly pins the current chat, even if it has no active work. */
  tabs_open: {
    input: tabCandidateSchema.extend(workspaceInput),
    output: tabsResultSchema,
  },
  tabs_restore: {
    input: z
      .object({
        ...workspaceInput,
        entry: tabEntrySchema,
        index: z.number().int().min(0).max(99),
      })
      .strict(),
    output: tabsResultSchema.extend({ status: z.enum(["restored", "open", "unavailable"]) }),
  },
  tabs_set_pinned: {
    input: z
      .object({
        ...workspaceInput,
        threadId: z.string().trim().min(1).max(200),
        pinned: z.boolean(),
      })
      .strict(),
    output: tabsResultSchema,
  },
  tabs_set_favorite: {
    input: z
      .object({
        ...workspaceInput,
        threadId: z.string().trim().min(1).max(200),
        favorite: z.boolean(),
        candidate: tabCandidateSchema.optional(),
      })
      .strict()
      .refine(
        (input) => input.candidate === undefined || input.candidate.threadId === input.threadId,
        "Candidate must match threadId",
      ),
    output: tabsResultSchema,
  },
  tabs_close: {
    input: z.object({ ...workspaceInput, threadId: z.string().trim().min(1).max(200) }).strict(),
    output: tabsResultSchema.extend({ removed: z.boolean() }),
  },
  /** Moves two pinned tabs in their shared horizontal strip. */
  tabs_move: {
    input: tabMoveSchema.extend(workspaceInput),
    output: tabsResultSchema,
  },
});

/**
 * Persists workspace sets in plugin-owned SQLite and shared history in KV. Every change flows through one
 * queue so two windows cannot lose each other's tabs between `get` and `set`.
 */
export default async function plugin(bb: BbPluginApi) {
  const settingsHandle = bb.settings.define({
    ...SETTINGS,
    language: { ...SETTINGS.language, options: [...SETTINGS.language.options] },
    tabListButtonPosition: {
      ...SETTINGS.tabListButtonPosition,
      options: [...SETTINGS.tabListButtonPosition.options],
    },
  });

  type TabsSnapshot = {
    collection: WorkspaceCollection;
    history: TabHistoryState;
  };

  let mutationTail: Promise<void> = Promise.resolve();
  let workflowRpcRetryAt = 0;
  const tabsListInFlight = new Map<
    string,
    Promise<{
      state: TabsState;
      stateRevision: number;
      workspaceId: string;
      workspaces: ReturnType<typeof workspaceInfos>;
      activeWorkflowThreadIds: string[];
      sidechatActivity: SidechatActivity;
      history: TabHistoryState;
    }>
  >();
  const activitySyncInFlight = new Map<
    string,
    Promise<{ state: TabsState; stateRevision: number }>
  >();
  const historyVisitInFlight = new Map<string, Promise<{ history: TabHistoryState }>>();
  const workflowStatusInFlight = new Map<string, Promise<boolean>>();
  // An ID is reconciled once per plugin generation; lifecycle events deliver
  // subsequent changes. This adds no polling to tabs_list.
  const threadAvailabilityById = new Map<string, TabHistoryAvailability>();
  const threadParentIdsById = new Map<string, string | null>();
  const threadAvailabilityInFlight = new Map<string, Promise<TabHistoryAvailability | undefined>>();
  const threadAvailabilityRetryAt = new Map<string, number>();

  // Persist the producer generation so a server/plugin reload cannot make
  // lower activity revisions look stale in an already mounted app.
  const sidechatGenerationKey = "tabs.sidechatGeneration.v1";
  const sidechatGeneration =
    z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1)
      .parse((await bb.storage.kv.get(sidechatGenerationKey)) ?? 0) + 1;
  await bb.storage.kv.set(sidechatGenerationKey, sidechatGeneration);
  const activeSidechats = new Map<string, string>();
  let sidechatEventsSeen: Set<string> | null = new Set();
  let sidechatRevision = 0;
  let sidechatSeed: Promise<void> | null = null;
  const sidechatActivity = (): SidechatActivity => ({
    generation: sidechatGeneration,
    revision: sidechatRevision,
    sourceThreadIds: [...new Set(activeSidechats.values())],
  });
  type SidebarMetadataThread = Pick<
    Awaited<ReturnType<typeof bb.sdk.threads.list>>[number],
    "id" | "originPluginId" | "sourceThreadId" | "archivedAt" | "deletedAt" | "status"
  >;
  function updateSidechat(thread: SidebarMetadataThread, seed = false) {
    if (thread.originPluginId !== "side-chat") return;
    if (seed && sidechatEventsSeen?.has(thread.id)) return;
    if (!seed) sidechatEventsSeen?.add(thread.id);
    const previous = activeSidechats.get(thread.id);
    const source = thread.sourceThreadId;
    if (
      source &&
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      (thread.status === "active" || thread.status === "starting" || thread.status === "stopping")
    )
      activeSidechats.set(thread.id, source);
    else activeSidechats.delete(thread.id);
    if (previous === activeSidechats.get(thread.id)) return;
    sidechatRevision++;
    if (!seed) bb.realtime.publish(SIDECHAT_ACTIVITY_CHANGED_CHANNEL, sidechatActivity());
  }
  async function readSidechatActivity(): Promise<SidechatActivity> {
    if (sidechatSeed === null) {
      sidechatSeed = (async () => {
        for (let offset = 0; ; offset += 200) {
          const page = await bb.sdk.threads.list({
            originPluginId: "side-chat",
            includeHidden: true,
            archived: false,
            limit: 200,
            offset,
          });
          for (const thread of page) updateSidechat(thread, true);
          if (page.length < 200) break;
        }
      })();
    }
    try {
      await sidechatSeed;
      sidechatEventsSeen = null;
    } catch (cause) {
      sidechatSeed = null;
      bb.log.warn(`Could not read sidechat activity: ${errorMessage(cause)}`);
    }
    return sidechatActivity();
  }
  for (const event of [
    "thread.created",
    "thread.active",
    "thread.idle",
    "thread.failed",
    "experimental_thread.events",
  ] as const)
    bb.events.on(event, ({ thread }) => updateSidechat(thread));

  const db = bb.storage.database();
  bb.storage.migrate(db, [
    "CREATE TABLE IF NOT EXISTS tabs_workspace_state (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)",
  ]);
  const readCollection = db.prepare("SELECT value FROM tabs_workspace_state WHERE id = 1");
  const writeCollection = db.prepare(
    "INSERT INTO tabs_workspace_state (id, value) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value",
  );
  let migrationInFlight: Promise<WorkspaceCollection> | null = null;

  function savedCollection(): WorkspaceCollection | null {
    const row: unknown = readCollection.get();
    if (row === undefined) return null;
    try {
      const { value } = z.object({ value: z.string() }).parse(row);
      return workspaceCollectionSchema.parse(JSON.parse(value));
    } catch {
      throw new Error("Workspace storage is damaged. Restore a backup before continuing.");
    }
  }

  async function readWorkspaces(): Promise<WorkspaceCollection> {
    const saved = savedCollection();
    if (saved !== null) return saved;
    if (migrationInFlight !== null) return migrationInFlight;
    const operation = (async () => {
      const [state, closed] = await Promise.all([
        bb.storage.kv.get<unknown>(STATE_KEY),
        bb.storage.kv.get<unknown>(CLOSED_THREADS_KEY),
      ]);
      const collection = createInitialWorkspaces(state, closed);
      // One statement: a failed write leaves no partially created modes. Legacy KV is untouched.
      writeCollection.run(JSON.stringify(workspaceCollectionSchema.parse(collection)));
      return collection;
    })();
    migrationInFlight = operation;
    try {
      return await operation;
    } finally {
      if (migrationInFlight === operation) migrationInFlight = null;
    }
  }

  function saveWorkspaces(
    previous: WorkspaceCollection,
    changed: WorkspaceCollection,
  ): WorkspaceCollection {
    if (JSON.stringify(previous) === JSON.stringify(changed)) return previous;
    const next = { ...changed, revision: previous.revision + 1 };
    writeCollection.run(JSON.stringify(workspaceCollectionSchema.parse(next)));
    bb.realtime.publish(WORKSPACE_MEMBERSHIPS_CHANGED_CHANNEL, next.revision);
    for (const workspace of next.workspaces) {
      const old = previous.workspaces.find((item) => item.id === workspace.id);
      if (old !== undefined && tabsStatesEqual(old.state, workspace.state)) continue;
      bb.realtime.publish(workspaceStateChannel(workspace.id), {
        workspaceId: workspace.id,
        stateRevision: next.revision,
        state: workspace.state,
      });
      if (workspace.id === DEFAULT_WORKSPACE_ID)
        bb.realtime.publish(TABS_CHANGED_CHANNEL, workspace.state);
    }
    if (
      !next.workspaces.some((item) => item.id === DEFAULT_WORKSPACE_ID) &&
      previous.workspaces.some((item) => item.id === DEFAULT_WORKSPACE_ID)
    ) {
      bb.realtime.publish(TABS_CHANGED_CHANNEL, createEmptyTabsState());
    }
    const infos = workspaceInfos(next);
    if (JSON.stringify(workspaceInfos(previous)) !== JSON.stringify(infos))
      bb.realtime.publish(WORKSPACES_CHANGED_CHANNEL, {
        stateRevision: next.revision,
        workspaces: infos,
      });
    return next;
  }

  function serialize<T>(apply: () => Promise<T>): Promise<T> {
    const operation = mutationTail.then(apply);
    mutationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  function mutateWorkspaces(
    apply: (current: WorkspaceCollection) => WorkspaceCollection,
  ): Promise<WorkspaceCollection> {
    return serialize(async () => {
      const current = await readWorkspaces();
      return saveWorkspaces(current, apply(current));
    });
  }

  async function readHistory(): Promise<TabHistoryState> {
    const stored = await bb.storage.kv.get<unknown>(HISTORY_KEY);
    return stored === undefined ? createEmptyTabHistory() : normalizeTabHistory(stored);
  }

  async function readSnapshotAfterPendingMutations(): Promise<TabsSnapshot> {
    await mutationTail;
    const [collection, history] = await Promise.all([readWorkspaces(), readHistory()]);
    return { collection, history };
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
      return result.runs.some((run) => run.status === "queued" || run.status === "running");
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
      ...new Set([...entries.map((entry) => entry.threadId), ...additionalThreadIds]),
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
      Array.from({ length: Math.min(MAX_WORKFLOW_RPC_CONCURRENCY, threadIds.length) }, () =>
        worker(),
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
  function mutateSnapshots(apply: (current: TabsSnapshot) => TabsSnapshot): Promise<TabsSnapshot> {
    return serialize(async () => {
      const [collection, history] = await Promise.all([readWorkspaces(), readHistory()]);
      const changed = apply({ collection, history });
      const next = {
        collection: saveWorkspaces(collection, changed.collection),
        history: normalizeTabHistory(changed.history),
      };
      if (!tabHistoriesEqual(history, next.history)) {
        await bb.storage.kv.set(HISTORY_KEY, next.history);
        bb.realtime.publish(TABS_HISTORY_CHANGED_CHANNEL, next.history);
      }
      return next;
    });
  }

  function mutateHistory(
    apply: (current: TabHistoryState) => TabHistoryState,
  ): Promise<TabHistoryState> {
    return serialize(async () => {
      const current = await readHistory();
      const next = normalizeTabHistory(apply(current));
      if (!tabHistoriesEqual(current, next)) {
        await bb.storage.kv.set(HISTORY_KEY, next);
        bb.realtime.publish(TABS_HISTORY_CHANGED_CHANNEL, next);
      }
      return next;
    });
  }

  function mutate(
    workspaceId: string | undefined,
    apply: (current: TabsState, closedIds: readonly string[]) => TabsState,
    updateClosedIds?: (
      current: TabsState,
      next: TabsState,
      closedIds: readonly string[],
    ) => string[],
  ): Promise<{ state: TabsState; stateRevision: number }> {
    return serialize(async () => {
      const collection = await readWorkspaces();
      const workspace = getWorkspace(collection, workspaceId);
      const next = normalizeTabsState(apply(workspace.state, workspace.closedThreadIds));
      const closedThreadIds =
        updateClosedIds?.(workspace.state, next, workspace.closedThreadIds) ??
        workspace.closedThreadIds;
      const saved = saveWorkspaces(collection, {
        ...collection,
        workspaces: collection.workspaces.map((item) =>
          item.id === workspace.id ? { ...workspace, state: next, closedThreadIds } : item,
        ),
      });
      return { state: next, stateRevision: saved.revision };
    });
  }

  function isThreadNotFoundError(cause: unknown): boolean {
    if (typeof cause !== "object" || cause === null) return false;
    const error = cause as {
      code?: unknown;
      status?: unknown;
      statusCode?: unknown;
    };
    return error.code === "not_found" || error.status === 404 || error.statusCode === 404;
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
        // A lifecycle event received during the lookup is newer than its snapshot.
        if (threadAvailabilityById.has(threadId)) return threadAvailabilityById.get(threadId);
        threadParentIdsById.set(threadId, thread.parentThreadId);
        const availability: TabHistoryAvailability =
          thread.deletedAt !== null ? "deleted" : thread.archivedAt !== null ? "archived" : null;
        threadAvailabilityById.set(threadId, availability);
        threadAvailabilityRetryAt.delete(threadId);
        return availability;
      } catch (cause) {
        if (threadAvailabilityById.has(threadId)) return threadAvailabilityById.get(threadId);
        if (isThreadNotFoundError(cause)) {
          threadAvailabilityById.set(threadId, "deleted");
          threadAvailabilityRetryAt.delete(threadId);
          return "deleted";
        }
        // Do not hide a chat after a transient or permission failure. Retry is
        // bounded so tabs_list does not become a frequent source of log errors.
        threadAvailabilityRetryAt.set(threadId, Date.now() + THREAD_AVAILABILITY_RETRY_MS);
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

  async function resolveTrackedThreadAvailability(threadIds: Iterable<string>): Promise<void> {
    const ids = [...new Set(threadIds)];
    let nextIndex = 0;

    const worker = async () => {
      while (true) {
        const threadId = ids[nextIndex];
        nextIndex += 1;
        if (threadId === undefined) return;
        await resolveThreadAvailability(threadId);
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
  }

  /**
   * Reconcile the unique IDs from all workspaces and shared history (at most
   * 4100 IDs), with bounded concurrency and generation/lifecycle caching.
   */
  async function reconcileTrackedThreadAvailability(snapshot: TabsSnapshot): Promise<TabsSnapshot> {
    const threadIds = new Set([
      ...snapshot.collection.workspaces.flatMap(({ state }) =>
        [...state.entries, ...(state.favorites ?? [])].map((entry) => entry.threadId),
      ),
      ...snapshot.history.entries.map((entry) => entry.threadId),
    ]);
    await resolveTrackedThreadAvailability(threadIds);
    const withKnownParent = <T extends TabCandidate>(entry: T): T => {
      const parentThreadId = threadParentIdsById.get(entry.threadId);
      return parentThreadId ? { ...entry, parentThreadId } : entry;
    };
    return mutateSnapshots(({ collection, history }) => {
      // Other IDs or queued writes may have waited while lifecycle advanced the cache.
      const availability = new Map<string, TabHistoryAvailability>();
      for (const id of threadIds) {
        const status = threadAvailabilityById.get(id);
        if (status !== undefined) availability.set(id, status);
      }
      const unavailableThreadIds = [...availability]
        .filter(([, status]) => status !== null)
        .map(([threadId]) => threadId);
      return {
        collection: {
          ...collection,
          workspaces: collection.workspaces.map((workspace) =>
            closeWorkspaceThreads(
              {
                ...workspace,
                state: {
                  ...workspace.state,
                  entries: workspace.state.entries.map(withKnownParent),
                  ...(workspace.state.favorites
                    ? { favorites: workspace.state.favorites.map(withKnownParent) }
                    : {}),
                },
              },
              unavailableThreadIds,
            ),
          ),
        },
        history: setTabHistoryAvailability(
          { ...history, entries: history.entries.map(withKnownParent) },
          availability,
        ),
      };
    });
  }

  async function applyThreadAvailability(
    threadId: string,
    availability: TabHistoryAvailability,
  ): Promise<void> {
    threadAvailabilityById.set(threadId, availability);
    threadAvailabilityRetryAt.delete(threadId);
    const updates = new Map<string, TabHistoryAvailability>([[threadId, availability]]);
    await mutateSnapshots(({ collection, history }) => ({
      // Unarchive restores history, never memberships in any workspace.
      collection:
        availability === null
          ? collection
          : {
              ...collection,
              workspaces: collection.workspaces.map((workspace) =>
                closeWorkspaceThreads(workspace, [threadId]),
              ),
            },
      history: setTabHistoryAvailability(history, updates),
    }));
  }

  // Events can also arrive for cascade-archived child chats. `closeTabs` is
  // idempotent, so it safely handles both roots and children.
  bb.events.on("thread.archived", async ({ thread }) => {
    updateSidechat(thread);
    await applyThreadAvailability(thread.id, "archived");
  });
  bb.events.on("thread.deleted", async ({ thread }) => {
    updateSidechat(thread);
    await applyThreadAvailability(thread.id, "deleted");
  });
  bb.events.on("thread.unarchived", async ({ thread }) => {
    updateSidechat(thread);
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
          const page = await bb.sdk.threads.list({
            archived,
            includeHidden: false,
            limit: pageSize,
            offset,
          });
          for (const thread of page) {
            if (
              (!includeArchived && thread.archivedAt !== null) ||
              thread.deletedAt !== null ||
              thread.visibility === "hidden" ||
              seen.has(thread.id)
            )
              continue;
            seen.add(thread.id);
            candidates.push({
              threadId: thread.id,
              projectId: thread.projectId,
              title: thread.title?.trim() || thread.titleFallback?.trim() || "Untitled",
              ...(thread.parentThreadId ? { parentThreadId: thread.parentThreadId } : {}),
              ...(projectNames.has(thread.projectId)
                ? { projectName: projectNames.get(thread.projectId) }
                : {}),
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
    try {
      return await operation;
    } finally {
      searchInFlight.delete(includeArchived);
    }
  };

  const catalogResult = (collection: WorkspaceCollection) => ({
    workspaces: workspaceInfos(collection),
    stateRevision: collection.revision,
  });

  bb.rpc.register(rpcContract, {
    tabs_workspaces_list: async () => {
      await mutationTail;
      return catalogResult(await readWorkspaces());
    },
    tabs_pinned_list: async () => {
      const { collection } = await reconcileTrackedThreadAvailability(
        await readSnapshotAfterPendingMutations(),
      );
      const entries = new Map<string, TabEntry>();
      for (const workspace of collection.workspaces) {
        for (const entry of workspace.state.entries) {
          if (entry.pinned && !entries.has(entry.threadId)) entries.set(entry.threadId, entry);
        }
      }
      return { entries: [...entries.values()], stateRevision: collection.revision };
    },
    tabs_workspace_memberships: async ({ threadId }) => {
      await mutationTail;
      const collection = await readWorkspaces();
      return {
        stateRevision: collection.revision,
        workspaces: workspaceInfos(collection).map((info, index) => ({
          ...info,
          included: collection.workspaces[index]!.state.entries.some(
            (entry) => entry.threadId === threadId,
          ),
        })),
      };
    },
    tabs_workspace_create: async ({ name }) => {
      const workspaceId = randomUUID();
      const collection = await mutateWorkspaces((current) =>
        addWorkspace(current, workspaceId, name),
      );
      return { ...catalogResult(collection), workspaceId };
    },
    tabs_workspace_rename: async ({ workspaceId, name }) =>
      catalogResult(
        await mutateWorkspaces((current) => renameWorkspace(current, workspaceId, name)),
      ),
    tabs_workspace_delete: async ({ workspaceId }) =>
      catalogResult(await mutateWorkspaces((current) => deleteWorkspace(current, workspaceId))),
    tabs_settings_update: (values) =>
      serialize(async () => ({
        values: await settingsHandle.experimental_set(values),
      })),
    tabs_appearance_update: (patch) =>
      serialize(async () => {
        const values = await settingsHandle.get();
        const appearance = readTabAppearance(values.tabAppearance);
        if (appearance === null) throw new Error("Invalid tab appearance settings.");
        const next = updateTabAppearance(appearance, patch);
        if (JSON.stringify(appearance) === JSON.stringify(next)) return { values };
        return {
          values: await settingsHandle.experimental_set({ tabAppearance: JSON.stringify(next) }),
        };
      }),
    tabs_search: async ({ query, includeArchived }) => ({
      candidates: fuzzyChatSearch(await searchCandidates(includeArchived === true), query),
    }),
    tabs_list: async (input) => {
      // Multiple renderer surfaces or Strict Mode can request the same snapshot
      // together. Avoid duplicating KV reads and up to 100 nested workflow RPCs;
      // mutations and realtime still invalidate clients.
      const requestedId =
        input?.workspaceId === null ? null : (input?.workspaceId ?? DEFAULT_WORKSPACE_ID);
      const requestKey = JSON.stringify([
        requestedId,
        [...new Set(input?.workflowThreadIds ?? [])].sort(),
      ]);
      const existing = tabsListInFlight.get(requestKey);
      if (existing !== undefined) return existing;

      const operation = (async () => {
        // In a fresh server generation, one bounded lookup for each retained ID
        // lifts old archive/delete state into the event model. Afterwards cache
        // and lifecycle events add no network activity to polling.
        const snapshot = await reconcileTrackedThreadAvailability(
          await readSnapshotAfterPendingMutations(),
        );
        const workspace = getWorkspace(
          snapshot.collection,
          requestedId ?? snapshot.collection.workspaces[0]!.id,
        );
        const [activeWorkflowIds] = await Promise.all([
          activeWorkflowThreadIds(
            [...workspace.state.entries, ...(workspace.state.favorites ?? [])],
            input?.workflowThreadIds,
          ),
          readSidechatActivity(),
        ]);
        return {
          state: workspace.state,
          stateRevision: snapshot.collection.revision,
          workspaceId: workspace.id,
          workspaces: workspaceInfos(snapshot.collection),
          activeWorkflowThreadIds: activeWorkflowIds,
          sidechatActivity: sidechatActivity(),
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
        candidate:
          thread.archivedAt !== null || thread.deletedAt !== null
            ? null
            : {
                threadId: thread.id,
                projectId: thread.projectId,
                title: thread.title?.trim() || thread.titleFallback?.trim() || "Untitled",
                ...(thread.parentThreadId ? { parentThreadId: thread.parentThreadId } : {}),
              },
      };
    },
    tabs_sync_activity: async ({ threads, reopen, workspaceId }) => {
      // Two windows can observe the same sidebar snapshot at once. Coalesce
      // exact input before the mutation queue while preserving candidate order
      // and therefore the “latest becomes preview” semantics.
      const requestKey = JSON.stringify({
        workspaceId: workspaceId ?? DEFAULT_WORKSPACE_ID,
        threads,
        reopen: reopen === true,
      });
      const existing = activitySyncInFlight.get(requestKey);
      if (existing !== undefined) return existing;

      const operation = mutate(
        workspaceId,
        (current, closedIds) => {
          const candidate = threads.at(-1);
          if (candidate !== undefined && reopen !== true && closedIds.includes(candidate.threadId))
            return current;
          return addTabCandidates(current, threads as TabCandidate[], Date.now());
        },
        (_current, _next, closedIds) =>
          reopen === true
            ? closedIds.filter((id) => id !== threads.at(-1)?.threadId)
            : [...closedIds],
      );
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
    tabs_open: async (thread) =>
      mutate(
        thread.workspaceId,
        (current) => openTabCandidate(current, thread as TabCandidate, Date.now()),
        (_current, _next, closedIds) => closedIds.filter((id) => id !== thread.threadId),
      ),
    tabs_restore: async ({ entry, index, workspaceId }) => {
      let thread: Awaited<ReturnType<typeof bb.sdk.threads.get>> | undefined;
      try {
        thread = await bb.sdk.threads.get({ threadId: entry.threadId });
      } catch (cause) {
        if (!isThreadNotFoundError(cause)) throw cause;
      }
      let status: "restored" | "open" | "unavailable" = "unavailable";
      const result = await mutate(
        workspaceId,
        (current) => {
          const availability = threadAvailabilityById.get(entry.threadId);
          if (
            thread === undefined ||
            thread.archivedAt !== null ||
            thread.deletedAt !== null ||
            availability === "archived" ||
            availability === "deleted"
          )
            return current;
          if (current.entries.some((item) => item.threadId === entry.threadId)) {
            status = "open";
            return current;
          }
          const next = restoreClosedTab(
            current,
            {
              threadId: entry.threadId,
              pinned: entry.pinned,
              openedAt: entry.openedAt,
              projectId: thread.projectId,
              title: thread.title?.trim() || thread.titleFallback?.trim() || entry.title,
              ...(thread.parentThreadId ? { parentThreadId: thread.parentThreadId } : {}),
            },
            index,
          );
          status = "restored";
          return next;
        },
        (_current, _next, closedIds) =>
          status === "restored" ? closedIds.filter((id) => id !== entry.threadId) : [...closedIds],
      );
      return { ...result, status };
    },
    tabs_set_pinned: async ({ threadId, pinned, workspaceId }) =>
      mutate(workspaceId, (current) => setTabPinned(current, threadId, pinned)),
    tabs_set_favorite: async ({ threadId, favorite, candidate, workspaceId }) =>
      mutate(workspaceId, (current) => setTabFavorite(current, threadId, favorite, candidate)),
    tabs_close: async ({ threadId, workspaceId }) => {
      let removed = false;
      const result = await mutate(
        workspaceId,
        (current) => {
          const next = closeTab(current, threadId);
          removed = next.entries.length !== current.entries.length;
          return next;
        },
        (_current, _next, closedIds) =>
          removed
            ? [...closedIds.filter((id) => id !== threadId), threadId].slice(
                -MAX_WORKSPACE_CLOSED_IDS,
              )
            : [...closedIds],
      );
      return { ...result, removed };
    },
    tabs_move: async ({ sourceThreadId, targetThreadId, position, workspaceId }) =>
      mutate(workspaceId, (current) =>
        movePinnedTab(current, sourceThreadId, targetThreadId, position),
      ),
  });

  bb.log.info("Chat tabs loaded");
}
