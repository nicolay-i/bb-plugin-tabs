import type { PluginSidebarProject, PluginSidebarThread } from "@get-bb/plugin-sdk/app";

/** Projects with the newest non-archived chat activity, newest first. */
export function recentProjects(
  projects: readonly PluginSidebarProject[],
  threads: readonly PluginSidebarThread[],
  limit = projects.length,
): PluginSidebarProject[] {
  const latestByProject = new Map<string, number>();
  for (const thread of threads) {
    if (thread.isArchived) continue;
    latestByProject.set(
      thread.projectId,
      Math.max(latestByProject.get(thread.projectId) ?? -Infinity, thread.updatedAt),
    );
  }
  return projects
    .filter((project) => !project.isPersonal && latestByProject.has(project.id))
    .sort((a, b) =>
      (latestByProject.get(b.id) ?? 0) - (latestByProject.get(a.id) ?? 0) ||
      a.name.localeCompare(b.name),
    )
    .slice(0, limit);
}
