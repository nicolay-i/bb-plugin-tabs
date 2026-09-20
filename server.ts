import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
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
  // Optional сохраняет совместимость с history V1 до tombstone-маркеров.
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
 * `workflows` публикует этот RPC через обычный публичный plugin API. Нам
 * достаточно статуса: полная форма workflow view намеренно не дублируется
 * здесь, чтобы tabs не зависел от деталей его UI.
 */
const workflowActiveRunsResponseSchema = z
  .object({
    runs: z.array(z.object({ status: z.string() }).passthrough()),
  })
  .passthrough();

export const rpcContract = defineRpcContract({
  tabs_list: {
    // Frontend передаёт также потомков открытых вкладок, чтобы durable workflow
    // из вложенного чата мог быть свёрнут к родителю.
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
        // Optional сохраняет обратную совместимость для уже загруженных app
        // bundles во время plugin reload.
        activeWorkflowThreadIds: z
          .array(z.string().trim().min(1).max(200))
          .max(100)
          .optional(),
        // Optional сохраняет совместимость с app bundle, загруженным до
        // появления plugin-owned истории вкладок.
        history: tabHistoryStateSchema.optional(),
      })
      .strict(),
  },
  /** Обновляет единственную preview-вкладку последним активным кандидатом. */
  tabs_sync_activity: {
    input: z
      .object({ threads: z.array(tabCandidateSchema).max(100) })
      .strict(),
    output: z.object({ state: tabsStateSchema }).strict(),
  },
  /** Переносит посещённый разговор в начало отдельной истории меню. */
  tabs_history_visit: {
    input: tabCandidateSchema,
    output: z.object({ history: tabHistoryStateSchema }).strict(),
  },
  /** Явно закрепляет текущий чат, даже если в нём нет активной работы. */
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
  /** Переставляет две закреплённые вкладки в общей горизонтальной полосе. */
  tabs_move: {
    input: tabMoveSchema,
    output: z.object({ state: tabsStateSchema }).strict(),
  },
});

/**
 * Сохраняет список верхних вкладок в plugin-owned KV. Все изменения проходят
 * через одну очередь, поэтому два окна не могут потерять вкладки друг друга
 * между `get` и `set`.
 */
export default async function plugin(bb: BbPluginApi) {
  bb.settings.define({
    showPinnedTabsList: {
      type: "boolean",
      label: "Показывать закреплённые чаты на экране «Новый чат»",
      description:
        "Добавляет быстрый список под полем ввода; строки показывают текущий статус и открывают чат по нажатию.",
      default: true,
    },
    showTabsOnDesktop: {
      type: "boolean",
      label: "Показывать верхние вкладки на desktop",
      description:
        "Скрывает только верхнюю полосу вкладок в desktop-компоновке; закрепления и история сохраняются.",
      default: true,
    },
    showTabsOnMobile: {
      type: "boolean",
      label: "Показывать верхние вкладки на телефоне",
      description:
        "Скрывает только верхнюю полосу вкладок в compact/mobile-компоновке; закрепления и история сохраняются.",
      default: true,
    },
    showTabListButton: {
      type: "boolean",
      label: "Показывать кнопку списка вкладок",
      description:
        "Показывает кнопку с закреплёнными чатами и историей рядом с верхней полосой.",
      default: true,
    },
    showTabListPinned: {
      type: "boolean",
      label: "Показывать закреплённые чаты в списке вкладок",
      description:
        "Управляет только разделом «Закреплённые» в выпадающем списке.",
      default: true,
    },
    showTabListHistory: {
      type: "boolean",
      label: "Показывать историю в списке вкладок",
      description:
        "Управляет только разделом «История» в выпадающем списке; история продолжает сохраняться.",
      default: true,
    },
    tabListButtonPosition: {
      type: "select",
      label: "Расположение кнопки списка вкладок",
      description: "Выберите сторону верхней полосы, на которой будет кнопка списка.",
      options: ["Слева", "Справа"],
      default: "Слева",
    },
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
  // Сверка бывает один раз на ID в поколении плагина; после этого изменения
  // приходят lifecycle-событиями. Это не добавляет polling к tabs_list.
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

  async function readHistory(): Promise<TabHistoryState> {
    const stored = await bb.storage.kv.get<unknown>(HISTORY_KEY);
    return stored === undefined ? createEmptyTabHistory() : normalizeTabHistory(stored);
  }

  async function readSnapshotAfterPendingMutations(): Promise<TabsSnapshot> {
    await mutationTail;
    const [state, history] = await Promise.all([readState(), readHistory()]);
    return { state, history };
  }

  /** Один concurrent `workflowActiveRuns` на thread между всеми tabs_list. */
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
   * Workflow может выполняться у origin-чата, пока sidebar ещё показывает
   * `activity: 0`. Запрашиваем официальный RPC встроенного плагина, а при
   * недоступности/несовместимости тихо деградируем к sidebar activity.
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
      // Не превращаем отключённый workflows в ошибку самих вкладок и не
      // повторяем сотню неуспешных запросов на каждом poll.
      workflowRpcRetryAt = Date.now() + 30_000;
      bb.log.warn(
        `Не удалось прочитать активные workflows; используется sidebar activity: ${errorMessage(failure)}`,
      );
    }

    // Сохраняем порядок вкладок/потомков независимо от порядка ответов RPC.
    return threadIds.filter((threadId) => activeThreadIds.has(threadId));
  }

  /**
   * State и history изменяются одной serial queue. Это важно для lifecycle:
   * archive → unarchive не должен оставить старый tombstone из-за двух
   * независимо планируемых KV-mutation.
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

  // Частые activity/pin/history операции сохраняют прежний минимальный I/O:
  // atomic пара state+history нужна только lifecycle reconciliation выше.
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
    apply: (current: TabsState) => TabsState,
  ): Promise<TabsState> {
    const operation = mutationTail.then(async () => {
      const current = await readState();
      const next = normalizeTabsState(apply(current));
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
   * Возвращает `undefined`, если статус нельзя проверить без риска неверно
   * назвать чат удалённым (например, временная ошибка или недостаток прав).
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
        // Не скрываем чат при transient/permission failure. Retry ограничен,
        // чтобы tabs_list не превратился в частый источник ошибок в логах.
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
   * При холодном старте сверяем не более 200 plugin-owned ID (100 tabs + 100
   * history). В дальнейшем результат кэшируется до lifecycle-события.
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
      // Unarchive делает history-запись снова кликабельной, но намеренно не
      // возвращает старый pin/preview: архивирование уже закрыло tab-state.
      state: availability === null ? state : closeTabs(state, [threadId]),
      history: setTabHistoryAvailability(history, updates),
    }));
  }

  // События приходят и для cascade-archive дочерних чатов. `closeTabs` —
  // idempotent, поэтому безопасно реагирует как на root, так и на child.
  bb.events.on("thread.archived", async ({ thread }) => {
    await applyThreadAvailability(thread.id, "archived");
  });
  bb.events.on("thread.deleted", async ({ thread }) => {
    await applyThreadAvailability(thread.id, "deleted");
  });
  bb.events.on("thread.unarchived", async ({ thread }) => {
    await applyThreadAvailability(thread.id, null);
  });

  bb.rpc.register(rpcContract, {
    tabs_list: async (input) => {
      // Несколько renderer surfaces или Strict Mode могут попросить один и тот
      // же snapshot одновременно. Не дублируем ни KV-read, ни до 100 nested
      // workflow RPC; mutation/realtime всё равно инвалидируют клиентов.
      const requestKey = [...new Set(input?.workflowThreadIds ?? [])]
        .sort()
        .join("\u0000");
      const existing = tabsListInFlight.get(requestKey);
      if (existing !== undefined) return existing;

      const operation = (async () => {
        // В новой server-generation один bounded lookup на сохранённый ID
        // поднимает старые archive/delete до событийной модели. После этого
        // cache + lifecycle events не добавляют сетевой работы к polling.
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
    tabs_sync_activity: async ({ threads }) => {
      // Два окна могут увидеть один и тот же sidebar snapshot одновременно.
      // Объединяем exact input до входа в mutation queue, сохраняя порядок
      // candidates и therefore семантику «последний становится preview».
      const requestKey = JSON.stringify(threads);
      const existing = activitySyncInFlight.get(requestKey);
      if (existing !== undefined) return existing;

      const operation = (async () => ({
        state: await mutate((current) =>
          addTabCandidates(current, threads as TabCandidate[], Date.now()),
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
      state: await mutate((current) =>
        openTabCandidate(current, thread as TabCandidate, Date.now()),
      ),
    }),
    tabs_set_pinned: async ({ threadId, pinned }) => ({
      state: await mutate((current) => setTabPinned(current, threadId, pinned)),
    }),
    tabs_close: async ({ threadId }) => {
      let removed = false;
      const state = await mutate((current) => {
        const next = closeTab(current, threadId);
        removed = next.entries.length !== current.entries.length;
        return next;
      });
      return { state, removed };
    },
    tabs_move: async ({ sourceThreadId, targetThreadId, position }) => ({
      state: await mutate((current) =>
        movePinnedTab(current, sourceThreadId, targetThreadId, position),
      ),
    }),
  });

  bb.log.info("вкладки чатов загружены");
}
