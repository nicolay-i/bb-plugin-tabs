import { describe, expect, it } from "vitest";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { recentProjects } from "./recent-projects";

describe("recent projects", () => {
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
    expect(recentProjects(projects, threads, 10).map((project) => project.id)).toEqual(
      ["p1", "p11", "p10", "p9", "p8", "p7", "p6", "p5", "p4", "p3"],
    );
    expect(recentProjects(projects, threads)).toHaveLength(12);
  });
});
