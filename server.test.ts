import { afterEach, describe, expect, it, vi } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { defaultTabAppearance, readTabAppearance } from "./lib/tab-appearance";
import { createTabsTestHost as createFakePluginHost, withTabsRpcTypes } from "./test-utils";

const loadedHosts: Array<ReturnType<typeof createFakePluginHost>> = [];

afterEach(async () => {
  await Promise.all(loadedHosts.splice(0).map((host) => host.harness.lifecycle.dispose()));
});

async function loadPlugin() {
  const host = createFakePluginHost({ pluginId: "tabs" });
  loadedHosts.push(host);
  await plugin(host.bb);
  return host;
}

describe("Chat Tabs", () => {
  it("tracks hidden sidechat forks by source, keeps parallel work, and clears terminal activity", async () => {
    const first = makeThreadResponse({
      id: "side_a",
      sourceThreadId: "parent",
      parentThreadId: null,
      originPluginId: "side-chat",
      originKind: "fork",
      visibility: "hidden",
      status: "active",
    });
    const second = makeThreadResponse({ ...first, id: "side_b" });
    const list = vi.fn(async () => [
      first,
      second,
      makeThreadResponse({
        ...first,
        id: "ordinary_fork",
        originPluginId: "another-plugin",
        sourceThreadId: "unrelated",
      }),
      makeThreadResponse({
        ...first,
        id: "archived",
        sourceThreadId: "archived_source",
        archivedAt: 1,
      }),
      makeThreadResponse({
        ...first,
        id: "deleted",
        sourceThreadId: "deleted_source",
        deletedAt: 1,
      }),
      makeThreadResponse({ ...first, id: "idle", sourceThreadId: "idle_source", status: "idle" }),
    ]);
    const host = createFakePluginHost({ pluginId: "tabs", sdk: { threads: { list } } });
    loadedHosts.push(host);
    await plugin(host.bb);
    expect((await host.harness.behavior.callRpc("tabs_list", null)).sidechatActivity).toEqual({
      generation: 1,
      revision: 2,
      sourceThreadIds: ["parent"],
    });
    expect(list).toHaveBeenCalledWith({
      originPluginId: "side-chat",
      includeHidden: true,
      archived: false,
      limit: 200,
      offset: 0,
    });
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ ...first, status: "idle" }),
      lastAssistantText: null,
    });
    expect(
      (await host.harness.behavior.callRpc("tabs_list", null)).sidechatActivity?.sourceThreadIds,
    ).toEqual(["parent"]);
    await host.harness.behavior.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ ...second, status: "error" }),
      error: "failed",
    });
    expect(
      (await host.harness.behavior.callRpc("tabs_list", null)).sidechatActivity?.sourceThreadIds,
    ).toEqual([]);
    const signals = host.harness.inspection.realtimeSignals.filter(
      (signal) => signal.channel === "tabs-sidechat-activity-changed",
    );
    expect(signals.map((signal) => signal.payload)).toEqual([
      { generation: 1, revision: 3, sourceThreadIds: ["parent"] },
      { generation: 1, revision: 4, sourceThreadIds: [] },
    ]);
    expect(list).toHaveBeenCalledTimes(1);
    await host.harness.behavior.emitThreadEvent("thread.active", { thread: first });
    expect(
      (await host.harness.behavior.callRpc("tabs_list", null)).sidechatActivity?.sourceThreadIds,
    ).toEqual(["parent"]);
    await host.harness.behavior.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({ ...first, deletedAt: 1 }),
    });
    expect(
      (await host.harness.behavior.callRpc("tabs_list", null)).sidechatActivity?.sourceThreadIds,
    ).toEqual([]);
  });

  it("does not revive stopped sidechat activity from a delayed startup metadata page", async () => {
    const child = makeThreadResponse({
      id: "side",
      originPluginId: "side-chat",
      sourceThreadId: "parent",
      visibility: "hidden",
      status: "active",
    });
    let resolvePage: ((threads: ReturnType<typeof makeThreadResponse>[]) => void) | undefined;
    const page = new Promise<ReturnType<typeof makeThreadResponse>[]>((resolve) => {
      resolvePage = resolve;
    });
    const list = vi.fn(() => page);
    const host = createFakePluginHost({ pluginId: "tabs", sdk: { threads: { list } } });
    loadedHosts.push(host);
    await plugin(host.bb);
    const request = host.harness.behavior.callRpc("tabs_list", null);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await host.harness.behavior.emitThreadEvent("thread.active", { thread: child });
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ ...child, status: "idle" }),
      lastAssistantText: null,
    });
    resolvePage?.([child]);
    expect((await request).sidechatActivity).toEqual({
      generation: 1,
      revision: 2,
      sourceThreadIds: [],
    });
  });

  it("advances the activity producer generation across reload and reports cleared work even with a lower revision", async () => {
    const child = makeThreadResponse({
      id: "side",
      originPluginId: "side-chat",
      sourceThreadId: "parent",
      status: "active",
    });
    const list = vi.fn(async () => [child]);
    let host = createFakePluginHost({ pluginId: "tabs", sdk: { threads: { list } } });
    loadedHosts.push(host);
    await plugin(host.bb);
    const initial = (await host.harness.behavior.callRpc("tabs_list", null)).sidechatActivity;
    expect(initial).toEqual({ generation: 1, revision: 1, sourceThreadIds: ["parent"] });
    list.mockResolvedValue([]);
    host = withTabsRpcTypes(await host.harness.lifecycle.reload(plugin));
    loadedHosts[loadedHosts.length - 1] = host;
    expect((await host.harness.behavior.callRpc("tabs_list", null)).sidechatActivity).toEqual({
      generation: 2,
      revision: 0,
      sourceThreadIds: [],
    });
    const emitted = await host.harness.behavior.emitThreadEvent("experimental_thread.events", {
      thread: makeThreadResponse({ ...child, status: "starting" }),
      sequence: 1,
    });
    expect(emitted.errors).toEqual([]);
    expect(
      (await host.harness.behavior.callRpc("tabs_list", null)).sidechatActivity?.sourceThreadIds,
    ).toEqual(["parent"]);
  });

  it("reads later sidechat metadata pages once and retries a failed initial read", async () => {
    const idle = Array.from({ length: 200 }, (_, i) =>
      makeThreadResponse({
        id: `idle_${i}`,
        originPluginId: "side-chat",
        sourceThreadId: "parent",
        status: "idle",
      }),
    );
    const active = makeThreadResponse({
      id: "active",
      originPluginId: "side-chat",
      sourceThreadId: "parent",
      status: "active",
    });
    const list = vi.fn(async () => [active]);
    list.mockRejectedValueOnce(new Error("metadata temporarily unavailable"));
    list.mockResolvedValueOnce(idle);
    const host = createFakePluginHost({ pluginId: "tabs", sdk: { threads: { list } } });
    loadedHosts.push(host);
    await plugin(host.bb);
    expect(
      (await host.harness.behavior.callRpc("tabs_list", null)).sidechatActivity?.sourceThreadIds,
    ).toEqual([]);
    expect(
      (await host.harness.behavior.callRpc("tabs_list", null)).sidechatActivity?.sourceThreadIds,
    ).toEqual(["parent"]);
    expect(list).toHaveBeenNthCalledWith(3, {
      originPluginId: "side-chat",
      includeHidden: true,
      archived: false,
      limit: 200,
      offset: 200,
    });
    await host.harness.behavior.callRpc("tabs_list", null);
    expect(list).toHaveBeenCalledTimes(3);
  });
  it("hydrates parent metadata in legacy history and favorites and returns it in search/current resolution", async () => {
    const child = makeThreadResponse({
      id: "thr_child",
      projectId: "proj_api",
      title: "Child",
      parentThreadId: "thr_root",
    });
    const host = createFakePluginHost({
      pluginId: "tabs",
      sdk: {
        threads: { get: async () => child, list: async () => [child] },
        projects: { list: async () => [] },
      },
    });
    loadedHosts.push(host);
    await plugin(host.bb);
    const candidate = { threadId: child.id, projectId: child.projectId, title: child.title! };
    await host.harness.behavior.callRpc("tabs_open", candidate);
    await host.harness.behavior.callRpc("tabs_history_visit", candidate);
    await host.harness.behavior.callRpc("tabs_set_favorite", {
      threadId: child.id,
      favorite: true,
    });
    await host.harness.behavior.callRpc("tabs_close", { threadId: child.id });
    const snapshot = await host.harness.behavior.callRpc("tabs_list", null);
    expect(snapshot.state.favorites?.[0]?.parentThreadId).toBe("thr_root");
    expect(snapshot.history?.entries[0]?.parentThreadId).toBe("thr_root");
    expect(host.harness.inspection.sdk.callsTo("threads.get")).toHaveLength(1);
    expect(
      (await host.harness.behavior.callRpc("tabs_search", { query: "Child" })).candidates[0]
        ?.parentThreadId,
    ).toBe("thr_root");
    expect(
      (await host.harness.behavior.callRpc("tabs_resolve_current", { threadId: child.id }))
        .candidate?.parentThreadId,
    ).toBe("thr_root");
    await host.harness.behavior.callRpc("tabs_history_visit", {
      ...candidate,
      parentThreadId: "thr_root",
    });
    expect(
      (await host.harness.behavior.callRpc("tabs_list", null)).history?.entries[0]?.parentThreadId,
    ).toBe("thr_root");
  });

  it("restores a removed favorite from a retained card without opening a preview", async () => {
    const host = await loadPlugin();
    const candidate = { threadId: "thr_restore", projectId: "proj_api", title: "Restore" };
    await host.harness.behavior.callRpc("tabs_sync_activity", { threads: [candidate] });
    await host.harness.behavior.callRpc("tabs_set_favorite", {
      threadId: candidate.threadId,
      favorite: true,
    });
    await host.harness.behavior.callRpc("tabs_close", { threadId: candidate.threadId });
    await host.harness.behavior.callRpc("tabs_set_favorite", {
      threadId: candidate.threadId,
      favorite: false,
    });
    const restored = await host.harness.behavior.callRpc("tabs_set_favorite", {
      threadId: candidate.threadId,
      favorite: true,
      candidate,
    });
    expect(restored.state.entries).toEqual([]);
    expect(restored.state.favorites).toEqual([expect.objectContaining(candidate)]);
    await expect(
      host.harness.behavior.callRpc("tabs_set_favorite", {
        threadId: "thr_other",
        favorite: true,
        candidate,
      }),
    ).rejects.toThrow("rpc input validation failed");
    await expect(
      host.harness.behavior.callRpc("tabs_set_favorite", {
        threadId: candidate.threadId,
        favorite: true,
        candidate: { ...candidate, title: "" },
      }),
    ).rejects.toThrow();
  });

  it("persists favorites independently of pins, previews, and close across reload", async () => {
    let host = await loadPlugin();
    const candidate = { threadId: "thr_favorite", projectId: "proj_api", title: "Favorite" };
    await host.harness.behavior.callRpc("tabs_sync_activity", { threads: [candidate] });
    const saved = await host.harness.behavior.callRpc("tabs_set_favorite", {
      threadId: candidate.threadId,
      favorite: true,
    });
    expect(saved.state.entries[0]?.pinned).toBe(false);
    await host.harness.behavior.callRpc("tabs_set_favorite", {
      threadId: candidate.threadId,
      favorite: true,
    });
    await host.harness.behavior.callRpc("tabs_set_pinned", {
      threadId: candidate.threadId,
      pinned: true,
    });
    await host.harness.behavior.callRpc("tabs_set_pinned", {
      threadId: candidate.threadId,
      pinned: false,
    });
    await host.harness.behavior.callRpc("tabs_sync_activity", {
      threads: [{ ...candidate, threadId: "thr_other" }],
    });
    await host.harness.behavior.callRpc("tabs_sync_activity", {
      threads: [{ ...candidate, title: "Renamed" }],
      reopen: true,
    });
    const closed = await host.harness.behavior.callRpc("tabs_close", {
      threadId: candidate.threadId,
    });
    expect(closed.state.entries).toEqual([]);
    expect(closed.state.favorites).toEqual([
      expect.objectContaining({ threadId: candidate.threadId, title: "Renamed" }),
    ]);
    expect(
      host.harness.inspection.realtimeSignals.filter((signal) => signal.channel === "tabs-changed"),
    ).toHaveLength(7);
    host = withTabsRpcTypes(await host.harness.lifecycle.reload(plugin));
    loadedHosts[loadedHosts.length - 1] = host;
    expect((await host.harness.behavior.callRpc("tabs_list", null)).state.favorites).toEqual(
      closed.state.favorites,
    );
    const removed = await host.harness.behavior.callRpc("tabs_set_favorite", {
      threadId: candidate.threadId,
      favorite: false,
    });
    expect(removed.state.favorites ?? []).toEqual([]);
    expect(
      host.harness.inspection.realtimeSignals.filter((signal) => signal.channel === "tabs-changed"),
    ).toHaveLength(1);
    await expect(
      host.harness.behavior.callRpc("tabs_set_favorite", {
        threadId: candidate.threadId,
        favorite: "true",
      }),
    ).rejects.toThrow();
  });

  it("reconciles unavailable favorites on startup even after their tabs were closed", async () => {
    const host = createFakePluginHost({
      pluginId: "tabs",
      sdk: {
        threads: {
          get: async ({ threadId }) => makeThreadResponse({ id: threadId, archivedAt: 1 }),
        },
      },
    });
    loadedHosts.push(host);
    await plugin(host.bb);
    const candidate = { threadId: "thr_favorite", projectId: "proj_api", title: "Favorite" };
    await host.harness.behavior.callRpc("tabs_sync_activity", { threads: [candidate] });
    await host.harness.behavior.callRpc("tabs_set_favorite", {
      threadId: candidate.threadId,
      favorite: true,
    });
    await host.harness.behavior.callRpc("tabs_close", { threadId: candidate.threadId });
    expect((await host.harness.behavior.callRpc("tabs_list", null)).state.favorites ?? []).toEqual(
      [],
    );
    expect(host.harness.inspection.sdk.callsTo("threads.get")).toHaveLength(1);
  });

  it.each(["thread.archived", "thread.deleted"] as const)(
    "removes closed favorites on %s",
    async (event) => {
      const host = await loadPlugin();
      const candidate = { threadId: "thr_favorite", projectId: "proj_api", title: "Favorite" };
      await host.harness.behavior.callRpc("tabs_sync_activity", { threads: [candidate] });
      await host.harness.behavior.callRpc("tabs_set_favorite", {
        threadId: candidate.threadId,
        favorite: true,
      });
      await host.harness.behavior.callRpc("tabs_close", { threadId: candidate.threadId });
      const emitted = await host.harness.behavior.emitThreadEvent(event, {
        thread: makeThreadResponse({
          id: candidate.threadId,
          archivedAt: event === "thread.archived" ? 1 : null,
          deletedAt: event === "thread.deleted" ? 1 : null,
        }),
      });
      expect(emitted.errors).toEqual([]);
      expect(
        (await host.harness.behavior.callRpc("tabs_list", null)).state.favorites ?? [],
      ).toEqual([]);
    },
  );

  it("serializes appearance patches across windows, keeps other settings, and survives reload", async () => {
    let host = await loadPlugin();
    await host.harness.behavior.setSettings({ showTabsOnDesktop: false });
    await Promise.all([
      host.harness.behavior.callRpc("tabs_appearance_update", {
        kind: "project",
        projectId: "p",
        alias: "API",
      }),
      host.harness.behavior.callRpc("tabs_appearance_update", {
        kind: "project",
        projectId: "p",
        color: 2,
      }),
      host.harness.behavior.callRpc("tabs_appearance_update", {
        kind: "tab",
        threadId: "t",
        color: 1,
      }),
      host.harness.behavior.callRpc("tabs_appearance_update", {
        kind: "palette",
        colors: [{ index: 1, color: "#123456" }],
      }),
      host.harness.behavior.callRpc("tabs_settings_update", { language: "Русский" }),
    ]);
    await host.harness.behavior.callRpc("tabs_appearance_update", {
      kind: "project-add",
      projectId: "empty",
    });
    await host.harness.behavior.callRpc("tabs_appearance_update", {
      kind: "project-add",
      projectId: "p",
    });
    host = withTabsRpcTypes(await host.harness.lifecycle.reload(plugin));
    loadedHosts[loadedHosts.length - 1] = host;
    const { values } = await host.harness.behavior.callRpc("tabs_appearance_update", {
      kind: "project",
      projectId: "p",
      alias: "API",
    });
    expect(values.showTabsOnDesktop).toBe(false);
    expect(values.language).toBe("Русский");
    const appearance = readTabAppearance(values.tabAppearance);
    expect(appearance?.projects.p).toEqual({ alias: "API", color: 2 });
    expect(appearance?.projects.empty).toEqual({ alias: "", color: null });
    const removed = await host.harness.behavior.callRpc("tabs_appearance_update", {
      kind: "project-remove",
      projectId: "p",
    });
    const afterRemoval = readTabAppearance(removed.values.tabAppearance);
    expect(afterRemoval?.projects).toEqual({ empty: { alias: "", color: null } });
    expect(afterRemoval?.tabs.t).toBe(1);
    expect(afterRemoval?.palette[1]).toBe("#123456");
    expect(appearance?.tabs.t).toBe(1);
    expect(appearance?.palette[1]).toBe("#123456");
    await expect(host.harness.behavior.setSettings({ tabAppearance: "broken" })).rejects.toThrow();
    for (const invalid of [
      { kind: "tab", threadId: "t", color: 6 },
      { kind: "project", projectId: "p", alias: "x".repeat(33) },
      { kind: "project", projectId: "p", title: "Do not rename" },
      { kind: "palette", colors: [{ index: 0, color: "red" }] },
    ])
      await expect(
        host.harness.behavior.callRpc("tabs_appearance_update", invalid),
      ).rejects.toThrow();
    const cleared = await host.harness.behavior.callRpc("tabs_appearance_update", {
      kind: "tab",
      threadId: "t",
      color: null,
    });
    expect(readTabAppearance(cleared.values.tabAppearance)?.tabs).toEqual({});
    expect(defaultTabAppearance().palette[1]).not.toBe("#123456");
  });

  it("saves localized settings through validated patches without resetting unrelated fields", async () => {
    const host = await loadPlugin();
    await host.harness.behavior.setSettings({ showTabsOnDesktop: false });
    const updated = await host.harness.behavior.callRpc("tabs_settings_update", {
      language: "Русский",
      searchArchivedChats: true,
      enableWorkspaces: false,
    });
    expect(updated.values.enableWorkspaces).toBe(false);
    expect(updated.values.language).toBe("Русский");
    expect(updated.values.searchArchivedChats).toBe(true);
    expect(updated.values.showTabsOnDesktop).toBe(false);
    for (const invalid of [
      { language: "Unknown" },
      { searchArchivedChats: "true" },
      { enableWorkspaces: "false" },
      { unexpected: true },
      {},
    ]) {
      await expect(
        host.harness.behavior.callRpc("tabs_settings_update", invalid),
      ).rejects.toThrow();
    }
    expect(
      (
        await host.harness.behavior.callRpc("tabs_settings_update", {
          tabListButtonPosition: "Right",
          enableWorkspaces: true,
        })
      ).values.language,
    ).toBe("Русский");
  });

  it("searches project names, combines project/title tokens, and returns project metadata for old chats", async () => {
    const projects = vi.fn().mockResolvedValue([
      { id: "proj_office", name: "Офис CRM" },
      { id: "proj_tools", name: "Tools" },
    ]);
    const list = vi.fn(async (args?: { archived?: boolean }) =>
      args?.archived
        ? [
            makeThreadResponse({
              id: "thr_archived_project",
              projectId: "proj_office",
              title: "Old migration",
              archivedAt: 1,
            }),
          ]
        : [
            makeThreadResponse({ id: "thr_project", projectId: "proj_office", title: "Fix login" }),
            makeThreadResponse({
              id: "thr_other_project",
              projectId: "proj_tools",
              title: "Fix login",
            }),
          ],
    );
    const host = createFakePluginHost({
      pluginId: "tabs",
      sdk: { projects: { list: projects }, threads: { list } },
    });
    loadedHosts.push(host);
    await plugin(host.bb);
    const result = await host.harness.behavior.callRpc("tabs_search", { query: "офис" });
    expect(result.candidates.map((item) => item.threadId)).toEqual(["thr_project"]);
    expect(result.candidates[0]?.projectName).toBe("Офис CRM");
    expect(
      (await host.harness.behavior.callRpc("tabs_search", { query: "офис login" })).candidates,
    ).toEqual(result.candidates);
    expect(
      (await host.harness.behavior.callRpc("tabs_search", { query: "login" })).candidates,
    ).toHaveLength(2);
    expect(projects).toHaveBeenCalledTimes(1);
    expect(projects).toHaveBeenCalledWith({ includePersonal: true });
    const archived = await host.harness.behavior.callRpc("tabs_search", {
      query: "офис",
      includeArchived: true,
    });
    expect(archived.candidates.map((item) => item.threadId)).toEqual([
      "thr_project",
      "thr_archived_project",
    ]);
    expect(archived.candidates[1]?.archived).toBe(true);
  });

  it("keeps title search working if project metadata cannot be fetched", async () => {
    const host = createFakePluginHost({
      pluginId: "tabs",
      sdk: {
        projects: {
          list: vi.fn().mockRejectedValue(new Error("Project metadata temporarily unavailable")),
        },
        threads: {
          list: async () => [makeThreadResponse({ id: "thr_title_fallback", title: "Login fix" })],
        },
      },
    });
    loadedHosts.push(host);
    await plugin(host.bb);
    expect(
      (await host.harness.behavior.callRpc("tabs_search", { query: "login" })).candidates.map(
        (item) => item.threadId,
      ),
    ).toEqual(["thr_title_fallback"]);
  });

  it("optionally searches archived chats with separate caches and never includes deleted or hidden chats", async () => {
    const list = vi.fn(async (args?: { archived?: boolean }) =>
      args?.archived
        ? [
            makeThreadResponse({ id: "thr_archived_search", title: "Old task", archivedAt: 1 }),
            makeThreadResponse({
              id: "thr_deleted_search",
              title: "Old task",
              deletedAt: 1,
              archivedAt: 1,
            }),
            makeThreadResponse({
              id: "thr_hidden_search",
              title: "Old task",
              visibility: "hidden",
              archivedAt: 1,
            }),
          ]
        : [makeThreadResponse({ id: "thr_active_search", title: "Old task" })],
    );
    const host = createFakePluginHost({
      pluginId: "tabs",
      sdk: { threads: { list }, projects: { list: async () => [] } },
    });
    loadedHosts.push(host);
    await plugin(host.bb);
    await expect(
      host.harness.behavior.setSettings({ searchArchivedChats: true }),
    ).resolves.toBeUndefined();
    await expect(
      host.harness.behavior.setSettings({ searchArchivedChats: "true" }),
    ).rejects.toThrow();
    const active = await host.harness.behavior.callRpc("tabs_search", { query: "Old task" });
    expect(active.candidates.map((item) => item.threadId)).toEqual(["thr_active_search"]);
    const all = await host.harness.behavior.callRpc("tabs_search", {
      query: "Old task",
      includeArchived: true,
    });
    expect(all.candidates.map((item) => item.threadId)).toEqual([
      "thr_active_search",
      "thr_archived_search",
    ]);
    expect(all.candidates[1]?.archived).toBe(true);
    expect(
      (
        await host.harness.behavior.callRpc("tabs_search", {
          query: "Old task",
          includeArchived: false,
        })
      ).candidates,
    ).toEqual(active.candidates);
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("searches titles beyond plugin history and the first BB page, caches only metadata, and excludes unavailable chats", async () => {
    const title = "Обновить систему до версии 0.43.3 — office";
    const page = Array.from({ length: 200 }, (_, i) =>
      makeThreadResponse({ id: `thr_page_${i}`, title: "Unrelated chat" }),
    );
    const list = vi.fn(async (args?: { offset?: number }) =>
      args?.offset === 0
        ? page
        : [
            makeThreadResponse({ id: "thr_office", projectId: "proj_office", title }),
            makeThreadResponse({ id: "thr_archived", title, archivedAt: 1 }),
            makeThreadResponse({ id: "thr_deleted", title, deletedAt: 1 }),
            makeThreadResponse({ id: "thr_hidden", title, visibility: "hidden" }),
          ],
    );
    const host = createFakePluginHost({
      pluginId: "tabs",
      sdk: { threads: { list }, projects: { list: async () => [] } },
    });
    loadedHosts.push(host);
    await plugin(host.bb);
    const result = await host.harness.behavior.callRpc("tabs_search", { query: "43" });
    expect(result.candidates).toEqual([
      { threadId: "thr_office", projectId: "proj_office", title },
    ]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenNthCalledWith(2, {
      archived: false,
      includeHidden: false,
      limit: 200,
      offset: 200,
    });
    expect(
      (await host.harness.behavior.callRpc("tabs_search", { query: title })).candidates,
    ).toEqual(result.candidates);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("keeps static setting labels and descriptions in English without Russian duplicates", async () => {
    const host = createFakePluginHost({ pluginId: "tabs" });
    loadedHosts.push(host);
    const define = vi.spyOn(host.bb.settings, "define");
    await plugin(host.bb);
    const schema = define.mock.calls[0]?.[0];
    expect(schema).toBeDefined();
    for (const setting of Object.values(schema!)) {
      expect(setting.label).not.toMatch(/[А-Яа-яЁё]/u);
      expect(setting.description ?? "").not.toMatch(/[А-Яа-яЁё]/u);
    }
  });

  it("handles behavior 1", async () => {
    const host = await loadPlugin();

    await expect(
      host.harness.behavior.setSettings({ showPinnedTabsList: false }),
    ).resolves.toBeUndefined();
    await expect(
      host.harness.behavior.setSettings({ showPinnedTabsList: "false" }),
    ).rejects.toThrow("expects a boolean");
  });

  it("handles behavior 2", async () => {
    const host = await loadPlugin();

    await expect(
      host.harness.behavior.setSettings({ language: "Русский" }),
    ).resolves.toBeUndefined();
    await expect(
      host.harness.behavior.setSettings({ language: "Italiano" }),
    ).resolves.toBeUndefined();
    await expect(host.harness.behavior.setSettings({ language: "Unsupported" })).rejects.toThrow();
    await expect(
      host.harness.behavior.setSettings({
        showTabsOnDesktop: false,
        showTabsOnMobile: false,
        showTabListButton: false,
        showTabListPinned: false,
        showTabListHistory: false,
        tabListButtonPosition: "Right",
      }),
    ).resolves.toBeUndefined();
    await expect(
      host.harness.behavior.setSettings({
        tabListButtonPosition: "Top",
      }),
    ).rejects.toThrow();
  });

  it("handles behavior 3", async () => {
    const host = await loadPlugin();

    const first = await host.harness.behavior.callRpc("tabs_sync_activity", {
      threads: [
        { threadId: "thr_build", projectId: "proj_api", title: "Build" },
        { threadId: "thr_review", projectId: "proj_api", title: "Review" },
      ],
    });
    expect(first.state.entries).toEqual([
      expect.objectContaining({ threadId: "thr_review", pinned: false }),
    ]);

    await host.harness.behavior.callRpc("tabs_set_pinned", {
      threadId: "thr_review",
      pinned: true,
    });
    const refreshed = await host.harness.behavior.callRpc("tabs_sync_activity", {
      threads: [
        {
          threadId: "thr_build",
          projectId: "proj_api",
          title: "Release build",
        },
      ],
    });

    expect(refreshed.state.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          threadId: "thr_review",
          title: "Review",
          pinned: true,
        }),
        expect.objectContaining({
          threadId: "thr_build",
          title: "Release build",
          pinned: false,
        }),
      ]),
    );
    expect(
      host.harness.inspection.realtimeSignals.filter((signal) => signal.channel === "tabs-changed"),
    ).toHaveLength(3);
  });

  it("does not let a stale renderer recreate a closed preview", async () => {
    const host = await loadPlugin();
    const candidate = { threadId: "thr_closed", projectId: "proj_api", title: "Closed chat" };

    await host.harness.behavior.callRpc("tabs_sync_activity", { threads: [candidate] });
    const closed = await host.harness.behavior.callRpc("tabs_close", {
      threadId: candidate.threadId,
    });
    expect(closed.removed).toBe(true);
    expect(closed.state.entries).toEqual([]);

    const stale = await host.harness.behavior.callRpc("tabs_sync_activity", {
      threads: [candidate],
    });
    expect(stale.state.entries).toEqual([]);
    expect((await host.harness.behavior.callRpc("tabs_list", null)).state.entries).toEqual([]);

    const reopened = await host.harness.behavior.callRpc("tabs_sync_activity", {
      threads: [candidate],
      reopen: true,
    });
    expect(reopened.state.entries).toEqual([
      expect.objectContaining({ threadId: candidate.threadId, pinned: false }),
    ]);
  });

  it("handles behavior 4", async () => {
    const host = await loadPlugin();

    await host.harness.behavior.callRpc("tabs_history_visit", {
      threadId: "thr_first",
      projectId: "proj_api",
      title: "First",
    });
    await host.harness.behavior.callRpc("tabs_history_visit", {
      threadId: "thr_second",
      projectId: "proj_web",
      title: "Second",
    });
    await host.harness.behavior.callRpc("tabs_history_visit", {
      threadId: "thr_first",
      projectId: "proj_api",
      title: "First (updated)",
    });

    const list = await host.harness.behavior.callRpc("tabs_list", null);
    expect(list.history?.entries).toEqual([
      expect.objectContaining({
        threadId: "thr_first",
        projectId: "proj_api",
        title: "First (updated)",
      }),
      expect.objectContaining({
        threadId: "thr_second",
        projectId: "proj_web",
        title: "Second",
      }),
    ]);
    expect(
      host.harness.inspection.realtimeSignals.filter(
        (signal) => signal.channel === "tabs-history-changed",
      ),
    ).toHaveLength(3);
  });

  it("handles behavior 5", async () => {
    const host = await loadPlugin();

    await host.harness.behavior.callRpc("tabs_open", {
      threadId: "thr_archived",
      projectId: "proj_api",
      title: "Archivable",
    });
    await host.harness.behavior.callRpc("tabs_history_visit", {
      threadId: "thr_archived",
      projectId: "proj_api",
      title: "Archivable",
    });
    const archivedEvent = await host.harness.behavior.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({
        id: "thr_archived",
        archivedAt: 10,
      }),
    });
    expect(archivedEvent.errors).toEqual([]);

    const archived = await host.harness.behavior.callRpc("tabs_list", null);
    expect(archived.state.entries).toEqual([]);
    expect(archived.history?.entries).toEqual([
      expect.objectContaining({
        threadId: "thr_archived",
        unavailableReason: "archived",
      }),
    ]);

    await host.harness.behavior.emitThreadEvent("thread.unarchived", {
      thread: makeThreadResponse({ id: "thr_archived", archivedAt: null }),
    });
    const restored = await host.harness.behavior.callRpc("tabs_list", null);
    expect(restored.state.entries).toEqual([]);
    expect(restored.history?.entries[0]).toEqual(
      expect.not.objectContaining({ unavailableReason: expect.anything() }),
    );

    await host.harness.behavior.callRpc("tabs_open", {
      threadId: "thr_deleted",
      projectId: "proj_api",
      title: "Deletable",
    });
    await host.harness.behavior.callRpc("tabs_history_visit", {
      threadId: "thr_deleted",
      projectId: "proj_api",
      title: "Deletable",
    });
    const deletedEvent = await host.harness.behavior.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({
        id: "thr_deleted",
        deletedAt: 20,
      }),
    });
    expect(deletedEvent.errors).toEqual([]);

    const deleted = await host.harness.behavior.callRpc("tabs_list", null);
    expect(deleted.state.entries).toEqual([]);
    expect(deleted.history?.entries.find((entry) => entry.threadId === "thr_deleted")).toEqual(
      expect.objectContaining({ unavailableReason: "deleted" }),
    );
  });

  it("resolves an open chat that is absent from the sidebar snapshot", async () => {
    const host = createFakePluginHost({
      pluginId: "tabs",
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) =>
            makeThreadResponse({
              id: threadId,
              projectId: "proj_api",
              title: "Missing from sidebar",
              archivedAt: threadId === "thr_archived" ? 1 : null,
            }),
        },
      },
    });
    loadedHosts.push(host);
    await plugin(host.bb);
    await expect(
      host.harness.behavior.callRpc("tabs_resolve_current", {
        threadId: "thr_open",
      }),
    ).resolves.toEqual({
      createdAt: expect.any(Number),
      candidate: {
        threadId: "thr_open",
        projectId: "proj_api",
        title: "Missing from sidebar",
      },
    });
    await expect(
      host.harness.behavior.callRpc("tabs_resolve_current", {
        threadId: "thr_archived",
      }),
    ).resolves.toEqual({ candidate: null, createdAt: expect.any(Number) });
  });

  it("handles behavior 6", async () => {
    const host = createFakePluginHost({
      pluginId: "tabs",
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) =>
            makeThreadResponse({
              id: threadId,
              archivedAt: threadId === "thr_legacy_archived" ? 10 : null,
              deletedAt: threadId === "thr_legacy_deleted" ? 20 : null,
            }),
        },
      },
    });
    loadedHosts.push(host);
    await plugin(host.bb);

    for (const [threadId, title] of [
      ["thr_legacy_archived", "Old archive"],
      ["thr_legacy_deleted", "Old deletion"],
    ]) {
      await host.harness.behavior.callRpc("tabs_open", {
        threadId,
        projectId: "proj_api",
        title,
      });
      await host.harness.behavior.callRpc("tabs_history_visit", {
        threadId,
        projectId: "proj_api",
        title,
      });
    }

    const reconciled = await host.harness.behavior.callRpc("tabs_list", null);
    expect(reconciled.state.entries).toEqual([]);
    expect(
      reconciled.history?.entries.map((entry) => [entry.threadId, entry.unavailableReason]),
    ).toEqual([
      ["thr_legacy_deleted", "deleted"],
      ["thr_legacy_archived", "archived"],
    ]);
    expect(host.harness.inspection.sdk.callsTo("threads.get")).toHaveLength(2);
  });

  it("handles behavior 7", async () => {
    const host = createFakePluginHost({
      pluginId: "tabs",
      sdk: {
        threads: {
          get: async () => {
            throw new Error("transient network error");
          },
        },
      },
    });
    loadedHosts.push(host);
    await plugin(host.bb);

    await host.harness.behavior.callRpc("tabs_open", {
      threadId: "thr_unknown",
      projectId: "proj_api",
      title: "Unavailable for reconciliation",
    });
    await host.harness.behavior.callRpc("tabs_history_visit", {
      threadId: "thr_unknown",
      projectId: "proj_api",
      title: "Unavailable for reconciliation",
    });

    const result = await host.harness.behavior.callRpc("tabs_list", null);
    expect(result.state.entries).toEqual([
      expect.objectContaining({ threadId: "thr_unknown", pinned: true }),
    ]);
    expect(result.history?.entries[0]).toEqual(
      expect.not.objectContaining({ unavailableReason: expect.anything() }),
    );
  });

  it("handles behavior 8", async () => {
    const host = await loadPlugin();
    for (const [threadId, title, projectId] of [
      ["thr_a", "A", "proj_a"],
      ["thr_b", "B", "proj_a"],
      ["thr_c", "C", "proj_b"],
    ]) {
      await host.harness.behavior.callRpc("tabs_open", {
        threadId,
        projectId,
        title,
      });
    }

    const result = await host.harness.behavior.callRpc("tabs_move", {
      sourceThreadId: "thr_c",
      targetThreadId: "thr_a",
      position: "before",
    });
    expect(result.state.entries.map((entry) => entry.threadId)).toEqual([
      "thr_c",
      "thr_a",
      "thr_b",
    ]);

    const unchanged = await host.harness.behavior.callRpc("tabs_move", {
      sourceThreadId: "thr_a",
      targetThreadId: "thr_missing",
      position: "after",
    });
    expect(unchanged.state).toEqual(result.state);
    expect(
      host.harness.inspection.realtimeSignals.filter((signal) => signal.channel === "tabs-changed"),
    ).toHaveLength(4);
  });

  it("handles behavior 9", async () => {
    const host = createFakePluginHost({
      pluginId: "tabs",
      sdk: {
        plugins: {
          callRpc: (args) => {
            const input = args.input as { threadId: string };
            return {
              runs:
                input.threadId === "thr_system_all" || input.threadId === "thr_child"
                  ? [{ status: "running" }]
                  : [{ status: "succeeded" }],
            };
          },
        },
      },
    });
    loadedHosts.push(host);
    await plugin(host.bb);

    await host.harness.behavior.callRpc("tabs_open", {
      threadId: "thr_system_all",
      projectId: "proj_system",
      title: "SystemAll 1",
    });
    await host.harness.behavior.callRpc("tabs_sync_activity", {
      threads: [
        {
          threadId: "thr_finished",
          projectId: "proj_system",
          title: "Finished workflow",
        },
      ],
    });

    const result = await host.harness.behavior.callRpc("tabs_list", {
      workflowThreadIds: ["thr_child"],
    });
    expect(result).toEqual(
      expect.objectContaining({
        activeWorkflowThreadIds: ["thr_system_all", "thr_child"],
      }),
    );
    expect(host.harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([
      [
        expect.objectContaining({
          pluginId: "workflows",
          method: "workflowActiveRuns",
          input: { threadId: "thr_system_all" },
        }),
      ],
      [
        expect.objectContaining({
          pluginId: "workflows",
          method: "workflowActiveRuns",
          input: { threadId: "thr_finished" },
        }),
      ],
      [
        expect.objectContaining({
          pluginId: "workflows",
          method: "workflowActiveRuns",
          input: { threadId: "thr_child" },
        }),
      ],
    ]);
  });

  it("handles behavior 10", async () => {
    let workflowCalls = 0;
    const host = createFakePluginHost({
      pluginId: "tabs",
      sdk: {
        plugins: {
          callRpc: async () => {
            workflowCalls += 1;
            await Promise.resolve();
            return { runs: [{ status: "running" }] };
          },
        },
      },
    });
    loadedHosts.push(host);
    await plugin(host.bb);
    await host.harness.behavior.callRpc("tabs_open", {
      threadId: "thr_shared",
      projectId: "proj_api",
      title: "Shared workflow",
    });

    const [first, second] = await Promise.all([
      host.harness.behavior.callRpc("tabs_list", null),
      host.harness.behavior.callRpc("tabs_list", null),
    ]);

    expect(first).toEqual(second);
    expect(first.activeWorkflowThreadIds).toEqual(["thr_shared"]);
    expect(workflowCalls).toBe(1);
  });

  it("handles behavior 11", async () => {
    const host = await loadPlugin();

    await Promise.all([
      host.harness.behavior.callRpc("tabs_sync_activity", {
        threads: [{ threadId: "thr_a", projectId: "proj_a", title: "A" }],
      }),
      host.harness.behavior.callRpc("tabs_sync_activity", {
        threads: [{ threadId: "thr_b", projectId: "proj_b", title: "B" }],
      }),
    ]);

    const result = await host.harness.behavior.callRpc("tabs_list", null);
    expect(result.state.entries).toEqual([
      expect.objectContaining({ threadId: "thr_b", pinned: false }),
    ]);
  });

  it("handles behavior 12", async () => {
    const host = await loadPlugin();
    const opened = await host.harness.behavior.callRpc("tabs_open", {
      threadId: "thr_keep",
      projectId: "proj_a",
      title: "Do not archive",
    });
    expect(opened.state.entries).toEqual([
      expect.objectContaining({ threadId: "thr_keep", pinned: true }),
    ]);

    const closed = await host.harness.behavior.callRpc("tabs_close", {
      threadId: "thr_keep",
    });

    expect(closed).toEqual({ state: { version: 1, entries: [] }, removed: true, stateRevision: 2 });
    expect(host.harness.inspection.sdk.calls).toEqual([]);
  });
});
