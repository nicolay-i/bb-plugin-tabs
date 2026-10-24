interface MenuTab {
  entry: { threadId: string; parentThreadId?: string };
}

export interface ChatMenuNode<T> {
  tab: T;
  children: ChatMenuNode<T>[];
}

/** Keep menu order, include known ancestors, and never lose orphaned/cyclic chats. */
export function chatMenuTree<T extends MenuTab>(
  tabs: readonly T[],
  knownTabs: readonly T[],
): ChatMenuNode<T>[] {
  const known = new Map(knownTabs.map((tab) => [tab.entry.threadId, tab]));
  for (const tab of tabs) known.set(tab.entry.threadId, tab);
  const nodes = new Map<string, ChatMenuNode<T>>();
  for (const tab of tabs) {
    let current: T | undefined = tab;
    while (current && !nodes.has(current.entry.threadId)) {
      const id = current.entry.threadId;
      nodes.set(id, { tab: current, children: [] });
      current = current.entry.parentThreadId ? known.get(current.entry.parentThreadId) : undefined;
    }
  }
  const parents = new Map<string, string>();
  for (const [id, { tab }] of nodes) {
    if (tab.entry.parentThreadId && nodes.has(tab.entry.parentThreadId))
      parents.set(id, tab.entry.parentThreadId);
  }
  const visited = new Set<string>();
  for (const id of nodes.keys()) {
    const path = new Set<string>();
    let current: string | undefined = id;
    while (current !== undefined && !visited.has(current)) {
      visited.add(current);
      path.add(current);
      const parent = parents.get(current);
      if (parent && path.has(parent)) {
        parents.delete(current);
        break;
      }
      current = parent;
    }
  }
  const roots: ChatMenuNode<T>[] = [];
  for (const [id, node] of nodes) {
    const parentId = parents.get(id);
    if (parentId) nodes.get(parentId)!.children.push(node);
    else roots.push(node);
  }
  return roots;
}
