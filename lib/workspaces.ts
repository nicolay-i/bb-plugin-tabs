import { z } from "zod";
import {
  MAX_TAB_ENTRIES,
  closeTabs,
  createEmptyTabsState,
  normalizeTabsState,
  tabsStateSchema,
} from "./tabs-model";
import translations from "./plugin-translations.json";

export const MAX_WORKSPACES = 20;
// ponytail: retain one full tabs+favorites removal; durable tombstones if unlimited reopen history is needed.
export const MAX_WORKSPACE_CLOSED_IDS = MAX_TAB_ENTRIES * 2;
export const DEFAULT_WORKSPACE_ID = "work";
export const WORKSPACES_CHANGED_CHANNEL = "tabs-workspaces-changed";
export const WORKSPACE_MEMBERSHIPS_CHANGED_CHANNEL = "tabs-workspace-memberships-changed";
export const defaultWorkspaceNames = ["Work", "Home", "Other"] as const;

export const workspaceInfoSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    name: z
      .string()
      .trim()
      .min(1)
      .refine((value) => [...value].length <= 80, "Use a workspace name of 1–80 characters."),
    defaultName: z.enum(defaultWorkspaceNames).optional(),
  })
  .strict();
export type WorkspaceInfo = z.infer<typeof workspaceInfoSchema>;
export const stateRevisionSchema = z.number().int().nonnegative();
export const workspaceCatalogEventSchema = z
  .object({
    stateRevision: stateRevisionSchema,
    workspaces: workspaceInfoSchema.array().min(1).max(MAX_WORKSPACES),
  })
  .strict();
export const workspaceStateEventSchema = z
  .object({
    workspaceId: workspaceInfoSchema.shape.id,
    stateRevision: stateRevisionSchema,
    state: tabsStateSchema,
  })
  .strict();
const workspaceSchema = workspaceInfoSchema.extend({
  state: tabsStateSchema,
  closedThreadIds: z.array(z.string().min(1).max(200)).max(MAX_WORKSPACE_CLOSED_IDS),
});
export const workspaceCollectionSchema = z
  .object({
    version: z.literal(1),
    revision: stateRevisionSchema,
    workspaces: z.array(workspaceSchema).min(1).max(MAX_WORKSPACES),
  })
  .strict()
  .superRefine((collection, context) => {
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const workspace of collection.workspaces) {
      if (ids.has(workspace.id) || names.has(workspace.name.toLowerCase())) {
        context.addIssue({ code: "custom", message: "Duplicate workspace." });
      }
      ids.add(workspace.id);
      names.add(workspace.name.toLowerCase());
    }
  });
export type WorkspaceCollection = z.infer<typeof workspaceCollectionSchema>;
export type Workspace = WorkspaceCollection["workspaces"][number];

export function createInitialWorkspaces(state: unknown, closedIds: unknown): WorkspaceCollection {
  return {
    version: 1,
    revision: 0,
    workspaces: defaultWorkspaceNames.map((name, index) => ({
      id: name.toLowerCase(),
      name,
      defaultName: name,
      state: index === 0 ? normalizeTabsState(state) : createEmptyTabsState(),
      closedThreadIds:
        index === 0 && Array.isArray(closedIds)
          ? [
              ...new Set(
                closedIds.filter(
                  (id): id is string => typeof id === "string" && id.length > 0 && id.length <= 200,
                ),
              ),
            ].slice(-MAX_WORKSPACE_CLOSED_IDS)
          : [],
    })),
  };
}

export function workspaceInfos(collection: WorkspaceCollection): WorkspaceInfo[] {
  return collection.workspaces.map(({ id, name, defaultName }) => ({
    id,
    name,
    ...(defaultName ? { defaultName } : {}),
  }));
}

export function getWorkspace(
  collection: WorkspaceCollection,
  id = DEFAULT_WORKSPACE_ID,
): Workspace {
  const workspace = collection.workspaces.find((item) => item.id === id);
  if (!workspace) throw new Error("Workspace no longer exists.");
  return workspace;
}

export function closeWorkspaceThreads(
  workspace: Workspace,
  threadIds: Iterable<string>,
): Workspace {
  const ids = new Set(threadIds);
  const removedIds = [...workspace.state.entries, ...(workspace.state.favorites ?? [])]
    .filter((entry) => ids.has(entry.threadId))
    .map((entry) => entry.threadId);
  return {
    ...workspace,
    state: closeTabs(workspace.state, ids, true),
    closedThreadIds: [...new Set([...workspace.closedThreadIds, ...removedIds])].slice(
      -MAX_WORKSPACE_CLOSED_IDS,
    ),
  };
}

export function workspaceStateChannel(id: string): string {
  return `tabs-changed:${id}`;
}

/** Reserve translated default labels too, so changing UI language never creates duplicate names. */
export function validateWorkspaceName(
  collection: { workspaces: readonly WorkspaceInfo[] },
  value: string,
  exceptId?: string,
): string {
  const name = value.trim();
  if (!name || [...name].length > 80) throw new Error("Use a workspace name of 1–80 characters.");
  const normalized = name.toLowerCase();
  for (const workspace of collection.workspaces) {
    if (workspace.id === exceptId) continue;
    const aliases: string[] = [workspace.name];
    if (workspace.defaultName) {
      for (const dictionary of Object.values(translations)) {
        aliases.push(dictionary[workspace.defaultName]);
      }
    }
    if (aliases.some((alias) => alias.toLowerCase() === normalized)) {
      throw new Error("A workspace with this name already exists.");
    }
  }
  return name;
}

export function addWorkspace(
  collection: WorkspaceCollection,
  id: string,
  value: string,
): WorkspaceCollection {
  if (collection.workspaces.length >= MAX_WORKSPACES)
    throw new Error("Workspace limit reached (20).");
  const name = validateWorkspaceName(collection, value);
  if (collection.workspaces.some((item) => item.id === id)) throw new Error("Duplicate workspace.");
  return {
    ...collection,
    workspaces: [
      ...collection.workspaces,
      { id, name, state: createEmptyTabsState(), closedThreadIds: [] },
    ],
  };
}

export function renameWorkspace(
  collection: WorkspaceCollection,
  id: string,
  value: string,
): WorkspaceCollection {
  getWorkspace(collection, id);
  const name = validateWorkspaceName(collection, value, id);
  return {
    ...collection,
    workspaces: collection.workspaces.map((workspace) => {
      if (workspace.id !== id) return workspace;
      const renamed = { ...workspace, name };
      delete renamed.defaultName;
      return renamed;
    }),
  };
}

export function deleteWorkspace(collection: WorkspaceCollection, id: string): WorkspaceCollection {
  getWorkspace(collection, id);
  if (collection.workspaces.length === 1) throw new Error("Keep at least one workspace.");
  return { ...collection, workspaces: collection.workspaces.filter((item) => item.id !== id) };
}
