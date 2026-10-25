import { describe, expect, it } from "vitest";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { childThreadTree, indexThreadChildren } from "./thread-children";
import { buildThreadWorkIndex } from "./thread-work";

function thread(
  id: string,
  parentThreadId: string | null,
  overrides: Partial<PluginSidebarThread> = {},
): PluginSidebarThread {
  return {
    id,
    parentThreadId,
    projectId: "proj_api",
    title: id,
    titleFallback: null,
    sectionId: null,
    originKind: parentThreadId ? "fork" : null,
    originPluginId: null,
    providerId: "pi",
    hasPendingInteraction: false,
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    createdAt: 1,
    updatedAt: 1,
    lastReadAt: null,
    latestAttentionAt: 0,
    ...overrides,
  };
}
const tree = (threads: PluginSidebarThread[], active: ReadonlySet<string> = new Set()) =>
  childThreadTree("root", indexThreadChildren(threads), buildThreadWorkIndex(threads, active));

describe("Child thread tree", () => {
  it("counts working descendants once, excluding waiting and unread signals", () => {
    const result = tree([
      thread("root", null, { isUnread: true }),
      thread("middle", "root"),
      thread("busy", "middle", { indicator: "runtime", isUnread: true }),
      thread("waiting", "root", { hasPendingInteraction: true }),
      thread("unread", "root", { isUnread: true }),
      thread("calm", "root"),
    ]);
    expect(result.workingCount).toBe(1);
    expect(result.hasUnread).toBe(true);
    expect(result.children).toHaveLength(4);
    expect(result.children[0]?.workingCount).toBe(1);
    expect(result.children[0]?.isWorking).toBe(false);
    expect(result.children[0]?.children[0]?.threadId).toBe("busy");
  });

  it("keeps calm children available at zero and includes durable workflow activity", () => {
    const threads = [thread("root", null), thread("child", "root")];
    expect(tree(threads).children).toHaveLength(1);
    expect(tree(threads).workingCount).toBe(0);
    expect(tree(threads, new Set(["child"])).workingCount).toBe(1);
  });

  it("does not include archived subtrees, unrelated threads, duplicates or the root itself", () => {
    const child = thread("child", "root", { isUnread: true });
    const result = tree([
      thread("root", null),
      child,
      child,
      thread("archived", "root", { isArchived: true, isUnread: true }),
      thread("hidden_under_archive", "archived", { isUnread: true }),
      thread("other", "unrelated", { isUnread: true }),
    ]);
    expect(result.children.map((item) => item.threadId)).toEqual(["child"]);
    expect(result.workingCount).toBe(0);
    expect(result.hasUnread).toBe(true);
  });

  it("keeps 50 idle descendants with two unread separate from working counts", () => {
    const threads = [
      thread("root", null),
      ...Array.from({ length: 50 }, (_, i) =>
        thread(`child-${i}`, i < 10 ? "root" : `child-${i % 10}`, {
          isUnread: i === 0 || i === 10,
        }),
      ),
    ];
    const result = tree(threads);
    expect(result.workingCount).toBe(0);
    expect(result.hasUnread).toBe(true);
    const nodes = [...result.children, ...result.children.flatMap((node) => node.children)];
    expect(nodes).toHaveLength(50);
    expect(nodes.every((node) => !node.isWorking && node.workingCount === 0)).toBe(true);
    expect(nodes.filter((node) => node.isUnread)).toHaveLength(2);
    expect(result.children[0]?.hasUnread).toBe(true);
  });

  it("guards cyclic parent relations and normalizes unnamed titles", () => {
    const result = tree([
      thread("root", "child"),
      thread("child", "root", { title: null, titleFallback: "  Fallback  " }),
      thread("unnamed", "child", { title: " ", titleFallback: null }),
    ]);
    expect(result.children[0]?.title).toBe("Fallback");
    expect(result.children[0]?.children.map((item) => item.threadId)).toEqual(["unnamed"]);
    expect(result.children[0]?.children[0]?.title).toBeNull();
  });
});
