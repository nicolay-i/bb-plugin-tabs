import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

const ACTIVE_INDICATORS = new Set([
  "waiting-for-input",
  "workflow",
  "background-agent",
  "background-command",
  "plan-mode",
  "goal",
  "runtime",
]);

export interface ThreadWorkIndex {
  /** Чаты, на которых BB непосредственно сообщает активность. */
  directlyWorkingThreadIds: ReadonlySet<string>;
  /** Предки работающих чатов; их вкладки должны показывать activity. */
  nestedWorkingAncestorIds: ReadonlySet<string>;
  threadsById: ReadonlyMap<string, PluginSidebarThread>;
}

export function isDirectlyWorkingThread(thread: PluginSidebarThread): boolean {
  const { activity } = thread;
  return (
    thread.hasPendingInteraction ||
    activity.workflows > 0 ||
    activity.backgroundAgents > 0 ||
    activity.backgroundCommands > 0 ||
    activity.planMode > 0 ||
    activity.goals > 0 ||
    ACTIVE_INDICATORS.has(thread.indicator)
  );
}

/**
 * Сворачивает active state ребёнка в каждого доступного предка. Защита `seen`
 * не даёт испорченной циклической parent-связи зациклить renderer.
 */
export function buildThreadWorkIndex(
  threads: readonly PluginSidebarThread[],
  /** Durable runs встроенного workflows, которые могут опережать sidebar. */
  workflowActiveThreadIds: ReadonlySet<string> = new Set<string>(),
): ThreadWorkIndex {
  const threadsById = new Map(threads.map((thread) => [thread.id, thread]));
  const directlyWorkingThreadIds = new Set<string>();
  const nestedWorkingAncestorIds = new Set<string>();

  for (const thread of threads) {
    if (
      !isDirectlyWorkingThread(thread) &&
      !workflowActiveThreadIds.has(thread.id)
    ) {
      continue;
    }
    directlyWorkingThreadIds.add(thread.id);

    const seen = new Set([thread.id]);
    let parentThreadId = thread.parentThreadId;
    while (parentThreadId !== null && !seen.has(parentThreadId)) {
      seen.add(parentThreadId);
      const parent = threadsById.get(parentThreadId);
      if (parent === undefined) break;
      nestedWorkingAncestorIds.add(parent.id);
      parentThreadId = parent.parentThreadId;
    }
  }

  return {
    directlyWorkingThreadIds,
    nestedWorkingAncestorIds,
    threadsById,
  };
}

export function hasThreadTreeWork(
  threadId: string,
  index: ThreadWorkIndex,
): boolean {
  return (
    index.directlyWorkingThreadIds.has(threadId) ||
    index.nestedWorkingAncestorIds.has(threadId)
  );
}

export function hasNestedThreadWork(
  threadId: string,
  index: ThreadWorkIndex,
): boolean {
  return index.nestedWorkingAncestorIds.has(threadId);
}

/**
 * Возвращает самый верхний доступный чат в цепочке. Если предок ещё не попал в
 * sidebar snapshot или связь повреждена, безопасно возвращается ближайший чат.
 */
export function rootThreadFor(
  thread: PluginSidebarThread,
  index: ThreadWorkIndex,
): PluginSidebarThread {
  let root = thread;
  const seen = new Set([thread.id]);
  let parentThreadId = thread.parentThreadId;

  while (parentThreadId !== null && !seen.has(parentThreadId)) {
    seen.add(parentThreadId);
    const parent = index.threadsById.get(parentThreadId);
    if (parent === undefined) break;
    root = parent;
    parentThreadId = parent.parentThreadId;
  }

  return root;
}
