import type { PluginSidebarProject, PluginSidebarThread } from "@get-bb/plugin-sdk/app";

export function latestProjectActivity(
  threads: readonly PluginSidebarThread[],
): Map<string, number> {
  const latestByProject = new Map<string, number>();
  for (const thread of threads) {
    if (thread.isArchived) continue;
    latestByProject.set(
      thread.projectId,
      Math.max(latestByProject.get(thread.projectId) ?? -Infinity, thread.updatedAt),
    );
  }
  return latestByProject;
}

/** Projects with the newest non-archived chat activity, newest first. */
export function recentProjects(
  projects: readonly PluginSidebarProject[],
  threads: readonly PluginSidebarThread[],
  limit = projects.length,
  preferredProjectIds: ReadonlySet<string> = new Set(),
): PluginSidebarProject[] {
  const latestByProject = latestProjectActivity(threads);
  return projects
    .filter(
      (project) =>
        !project.isPersonal &&
        (latestByProject.has(project.id) || preferredProjectIds.has(project.id)),
    )
    .sort(
      (a, b) =>
        Number(preferredProjectIds.has(b.id)) - Number(preferredProjectIds.has(a.id)) ||
        (latestByProject.get(b.id) ?? 0) - (latestByProject.get(a.id) ?? 0) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, limit);
}
