import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

const ACTIVE_INDICATORS = new Set([
  "workflow",
  "background-agent",
  "background-command",
  "plan-mode",
  "goal",
  "runtime",
]);

export interface ThreadWorkIndex {
  /** Chats for which BB directly reports work activity. */
  directlyWorkingThreadIds: ReadonlySet<string>;
  /** Ancestors of working chats; their tabs should show activity too. */
  nestedWorkingAncestorIds: ReadonlySet<string>;
  directlyWaitingThreadIds: ReadonlySet<string>;
  nestedWaitingAncestorIds: ReadonlySet<string>;
  threadsById: ReadonlyMap<string, PluginSidebarThread>;
}

export function isDirectlyWorkingThread(thread: PluginSidebarThread): boolean {
  const { activity } = thread;
  return (
    activity.workflows > 0 ||
    activity.backgroundAgents > 0 ||
    activity.backgroundCommands > 0 ||
    activity.planMode > 0 ||
    activity.goals > 0 ||
    ACTIVE_INDICATORS.has(thread.indicator)
  );
}

/**
 * Folds a child's active state into every available ancestor. The `seen` guard
 * prevents a corrupted cyclic parent relation from looping the renderer.
 */
export function buildThreadWorkIndex(
  threads: readonly PluginSidebarThread[],
  /** Durable runs from the built-in workflows plugin can precede the sidebar. */
  workflowActiveThreadIds: ReadonlySet<string> = new Set<string>(),
): ThreadWorkIndex {
  const threadsById = new Map(threads.map((thread) => [thread.id, thread]));
  const directlyWorkingThreadIds = new Set<string>();
  const nestedWorkingAncestorIds = new Set<string>();
  const directlyWaitingThreadIds = new Set<string>();
  const nestedWaitingAncestorIds = new Set<string>();

  const markAncestors = (thread: PluginSidebarThread, ancestors: Set<string>) => {
    const seen = new Set([thread.id]);
    let parentThreadId = thread.parentThreadId;
    while (parentThreadId !== null && !seen.has(parentThreadId)) {
      seen.add(parentThreadId);
      const parent = threadsById.get(parentThreadId);
      if (parent === undefined) break;
      ancestors.add(parent.id);
      parentThreadId = parent.parentThreadId;
    }
  };

  for (const thread of threads) {
    if (thread.hasPendingInteraction || thread.indicator === "waiting-for-input") {
      directlyWaitingThreadIds.add(thread.id);
      markAncestors(thread, nestedWaitingAncestorIds);
    }
    if (isDirectlyWorkingThread(thread) || workflowActiveThreadIds.has(thread.id)) {
      directlyWorkingThreadIds.add(thread.id);
      markAncestors(thread, nestedWorkingAncestorIds);
    }
  }

  return {
    directlyWorkingThreadIds,
    nestedWorkingAncestorIds,
    directlyWaitingThreadIds,
    nestedWaitingAncestorIds,
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

export function hasThreadTreePendingInteraction(threadId: string, index: ThreadWorkIndex): boolean {
  return index.directlyWaitingThreadIds.has(threadId) || index.nestedWaitingAncestorIds.has(threadId);
}

export function hasNestedThreadPendingInteraction(threadId: string, index: ThreadWorkIndex): boolean {
  return index.nestedWaitingAncestorIds.has(threadId);
}

export function hasNestedThreadWork(
  threadId: string,
  index: ThreadWorkIndex,
): boolean {
  return index.nestedWorkingAncestorIds.has(threadId);
}

/**
 * Returns the highest available chat in a parent chain. If an ancestor has not
 * reached the sidebar snapshot yet, or the relation is corrupt, it safely
 * returns the closest known chat.
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
