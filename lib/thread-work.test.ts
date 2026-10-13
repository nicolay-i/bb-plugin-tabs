import { describe, expect, it } from "vitest";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import {
  buildThreadWorkIndex,
  hasNestedThreadWork,
  hasNestedThreadPendingInteraction,
  hasThreadTreePendingInteraction,
  hasThreadTreeWork,
  rootThreadFor,
} from "./thread-work";

function thread(
  id: string,
  parentThreadId: string | null = null,
  overrides: Partial<PluginSidebarThread> = {},
): PluginSidebarThread {
  return {
    id,
    projectId: "proj_api",
    title: id,
    titleFallback: null,
    parentThreadId,
    sectionId: null,
    originKind: parentThreadId === null ? null : "fork",
    originPluginId: null,
    providerId: "codex",
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
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

describe("Chat Tabs", () => {
  it("separates a pending question or approval from active work and propagates it to parents", () => {
    const root = thread("thr_root");
    const child = thread("thr_child", root.id, {
      hasPendingInteraction: true,
      indicator: "waiting-for-input",
    });
    const index = buildThreadWorkIndex([root, child]);
    expect(hasThreadTreePendingInteraction(child.id, index)).toBe(true);
    expect(hasThreadTreePendingInteraction(root.id, index)).toBe(true);
    expect(hasNestedThreadPendingInteraction(root.id, index)).toBe(true);
    expect(hasThreadTreeWork(child.id, index)).toBe(false);
    expect(hasThreadTreeWork(root.id, index)).toBe(false);
    const resolved = buildThreadWorkIndex([root, thread("thr_child", root.id)]);
    expect(hasThreadTreePendingInteraction(root.id, resolved)).toBe(false);
  });

  it("recognizes a working sidechat draft without activity counters and propagates it to an idle parent", () => {
    const root = thread("parent");
    const child = thread("sidechat", root.id, {
      originPluginId: "side-chat",
      indicator: "working-draft",
    });
    const index = buildThreadWorkIndex([root, child]);
    expect(index.directlyWorkingThreadIds.has(root.id)).toBe(false);
    expect(index.directlyWorkingThreadIds.has(child.id)).toBe(true);
    expect(hasNestedThreadWork(root.id, index)).toBe(true);
    const idle = buildThreadWorkIndex([
      root,
      thread(child.id, root.id, { originPluginId: "side-chat", indicator: "draft" }),
    ]);
    expect(hasThreadTreeWork(root.id, idle)).toBe(false);
  });

  it("folds hidden sidechat sources into ancestors without marking the main chat as directly working", () => {
    const root = thread("root");
    const child = thread("source", root.id);
    const index = buildThreadWorkIndex(
      [root, child],
      new Set(),
      new Set([child.id, "not-in-sidebar"]),
    );
    expect(index.directlyWorkingThreadIds.size).toBe(0);
    expect(hasNestedThreadWork(root.id, index)).toBe(true);
    expect(hasThreadTreeWork("not-in-sidebar", index)).toBe(true);
    expect(hasThreadTreeWork(root.id, buildThreadWorkIndex([root, child]))).toBe(false);
  });

  it("handles behavior 1", () => {
    const root = thread("thr_root");
    const middle = thread("thr_middle", root.id);
    const workflow = thread("thr_workflow", middle.id, {
      activity: {
        workflows: 1,
        backgroundAgents: 0,
        backgroundCommands: 0,
        planMode: 0,
        goals: 0,
      },
      indicator: "workflow",
      updatedAt: 9,
    });
    const index = buildThreadWorkIndex([root, middle, workflow]);

    expect(hasThreadTreeWork(workflow.id, index)).toBe(true);
    expect(hasThreadTreeWork(middle.id, index)).toBe(true);
    expect(hasThreadTreeWork(root.id, index)).toBe(true);
    expect(hasNestedThreadWork(workflow.id, index)).toBe(false);
    expect(hasNestedThreadWork(middle.id, index)).toBe(true);
    expect(hasNestedThreadWork(root.id, index)).toBe(true);
    expect(rootThreadFor(workflow, index).id).toBe(root.id);
  });

  it("handles behavior 2", () => {
    const first = thread("thr_first", "thr_second", {
      activity: {
        workflows: 1,
        backgroundAgents: 0,
        backgroundCommands: 0,
        planMode: 0,
        goals: 0,
      },
    });
    const second = thread("thr_second", first.id);
    const index = buildThreadWorkIndex([first, second]);

    expect(hasThreadTreeWork(second.id, index)).toBe(true);
    expect(rootThreadFor(first, index).id).toBe(second.id);
  });
});
