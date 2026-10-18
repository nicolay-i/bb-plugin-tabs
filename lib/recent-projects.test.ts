import { describe, expect, it } from "vitest";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { recentProjects } from "./recent-projects";

describe("recent projects", () => {
  it("prioritizes current workspace projects before limiting and includes pins outside the loaded sidebar", () => {
    const projects = [
      { id: "old", name: "Older", isPersonal: false },
      { id: "recent", name: "Recent", isPersonal: false },
      { id: "missing", name: "Missing sidebar chat", isPersonal: false },
      { id: "personal", name: "Personal", isPersonal: true },
    ];
    const threads = [
      { projectId: "old", updatedAt: 1, isArchived: false },
      { projectId: "recent", updatedAt: 100, isArchived: false },
    ] as PluginSidebarThread[];
    expect(
      recentProjects(projects, threads, 2, new Set(["old", "missing", "personal"])).map(
        (p) => p.id,
      ),
    ).toEqual(["old", "missing"]);
    expect(recentProjects(projects, threads, 2, new Set(["recent"])).map((p) => p.id)).toEqual([
      "recent",
      "old",
    ]);
    expect(projects[0]?.id).toBe("old");
  });
  it("ranks at most ten projects by latest chat activity, including child chats", () => {
    const projects = Array.from({ length: 12 }, (_, index) => ({
      id: `p${index}`,
      name: `Project ${index}`,
      isPersonal: false,
    }));
    projects.push({ id: "personal", name: "Personal", isPersonal: true });
    const threads = projects.map((project, index) => ({
      projectId: project.id,
      id: `t${index}`,
      parentThreadId: null,
      isArchived: false,
      updatedAt: index,
    })) as PluginSidebarThread[];
    threads.push({ ...threads[0]!, id: "archived", isArchived: true, updatedAt: 1000 });
    threads.push({ ...threads[1]!, id: "child", parentThreadId: "t1", updatedAt: 1001 });
    expect(recentProjects(projects, threads, 10).map((project) => project.id)).toEqual([
      "p1",
      "p11",
      "p10",
      "p9",
      "p8",
      "p7",
      "p6",
      "p5",
      "p4",
      "p3",
    ]);
    expect(recentProjects(projects, threads)).toHaveLength(12);
  });
});
