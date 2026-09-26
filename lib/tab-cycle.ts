export type TabCycleDirection = "next" | "previous";

interface CycleTab {
  threadId: string;
}

/**
 * Returns the adjacent tab in the already presented horizontal order. A single
 * tab or a chat outside the plugin strip does not take over the native shortcut.
 */
export function cycleTab<T extends CycleTab>(
  tabs: readonly T[],
  currentThreadId: string | null,
  direction: TabCycleDirection,
): T | null {
  if (currentThreadId === null || tabs.length < 2) return null;
  const currentIndex = tabs.findIndex(
    (tab) => tab.threadId === currentThreadId,
  );
  if (currentIndex === -1) return null;

  const offset = direction === "next" ? 1 : -1;
  const nextIndex = (currentIndex + offset + tabs.length) % tabs.length;
  return tabs[nextIndex] ?? null;
}
