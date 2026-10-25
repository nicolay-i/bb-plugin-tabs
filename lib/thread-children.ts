import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { ThreadWorkIndex } from "./thread-work";

export interface ChildThreadNode {
  threadId: string;
  projectId: string;
  title: string | null;
  isWorking: boolean;
  isWaiting: boolean;
  isUnread: boolean;
  /** Distinct working descendants, excluding this node itself. */
  workingCount: number;
  hasUnread: boolean;
  children: ChildThreadNode[];
}

export function indexThreadChildren(
  threads: readonly PluginSidebarThread[],
): ReadonlyMap<string, readonly PluginSidebarThread[]> {
  const children = new Map<string, PluginSidebarThread[]>();
  const seen = new Set<string>();
  for (const thread of threads) {
    if (thread.isArchived || thread.parentThreadId === null || seen.has(thread.id)) continue;
    seen.add(thread.id);
    const siblings = children.get(thread.parentThreadId) ?? [];
    siblings.push(thread);
    children.set(thread.parentThreadId, siblings);
  }
  return children;
}

/** Count direct signals, not rolled-up parent signals: one busy grandchild counts once. */
export function childThreadTree(
  rootId: string,
  childrenByParent: ReadonlyMap<string, readonly PluginSidebarThread[]>,
  work: ThreadWorkIndex,
): { children: ChildThreadNode[]; workingCount: number; hasUnread: boolean } {
  const seen = new Set([rootId]);
  const visit = (parentId: string): ChildThreadNode[] => {
    const result: ChildThreadNode[] = [];
    for (const thread of childrenByParent.get(parentId) ?? []) {
      if (seen.has(thread.id)) continue;
      seen.add(thread.id);
      const children = visit(thread.id);
      result.push({
        threadId: thread.id,
        projectId: thread.projectId,
        title: thread.title?.trim() || thread.titleFallback?.trim() || null,
        isWorking: work.directlyWorkingThreadIds.has(thread.id),
        isWaiting: work.directlyWaitingThreadIds.has(thread.id),
        isUnread: thread.isUnread,
        workingCount: countWorking(children),
        hasUnread: children.some((child) => child.isUnread || child.hasUnread),
        children,
      });
    }
    return result;
  };
  const children = visit(rootId);
  return {
    children,
    workingCount: countWorking(children),
    hasUnread: children.some((child) => child.isUnread || child.hasUnread),
  };
}

function countWorking(children: readonly ChildThreadNode[]): number {
  return children.reduce((count, node) => count + Number(node.isWorking) + node.workingCount, 0);
}
