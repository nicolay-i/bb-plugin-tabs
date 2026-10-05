import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

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
  it("saves localized settings through validated patches without resetting unrelated fields", async () => {
    const host = await loadPlugin();
    await host.harness.behavior.setSettings({ showTabsOnDesktop: false });
    const updated = await host.harness.behavior.callRpc("tabs_settings_update", { language: "Русский", searchArchivedChats: true });
    expect(updated.values.language).toBe("Русский");
    expect(updated.values.searchArchivedChats).toBe(true);
    expect(updated.values.showTabsOnDesktop).toBe(false);
    for (const invalid of [{ language: "Unknown" }, { searchArchivedChats: "true" }, { unexpected: true }, {}]) {
      await expect(host.harness.behavior.callRpc("tabs_settings_update", invalid)).rejects.toThrow();
    }
    expect((await host.harness.behavior.callRpc("tabs_settings_update", { tabListButtonPosition: "Right" })).values.language).toBe("Русский");
  });

  it("searches project names, combines project/title tokens, and returns project metadata for old chats", async () => {
    const projects = vi.fn().mockResolvedValue([
      { id: "proj_office", name: "Офис CRM" }, { id: "proj_tools", name: "Tools" },
    ]);
    const list = vi.fn(async (args?: { archived?: boolean }) => args?.archived
      ? [makeThreadResponse({ id: "thr_archived_project", projectId: "proj_office", title: "Old migration", archivedAt: 1 })]
      : [makeThreadResponse({ id: "thr_project", projectId: "proj_office", title: "Fix login" }),
        makeThreadResponse({ id: "thr_other_project", projectId: "proj_tools", title: "Fix login" })]);
    const host = createFakePluginHost({ pluginId: "tabs", sdk: { projects: { list: projects }, threads: { list } } });
    loadedHosts.push(host);
    await plugin(host.bb);
    const result = await host.harness.behavior.callRpc("tabs_search", { query: "офис" });
    expect(result.candidates.map((item) => item.threadId)).toEqual(["thr_project"]);
    expect(result.candidates[0]?.projectName).toBe("Офис CRM");
    expect((await host.harness.behavior.callRpc("tabs_search", { query: "офис login" })).candidates).toEqual(result.candidates);
    expect((await host.harness.behavior.callRpc("tabs_search", { query: "login" })).candidates).toHaveLength(2);
    expect(projects).toHaveBeenCalledTimes(1);
    expect(projects).toHaveBeenCalledWith({ includePersonal: true });
    const archived = await host.harness.behavior.callRpc("tabs_search", { query: "офис", includeArchived: true });
    expect(archived.candidates.map((item) => item.threadId)).toEqual(["thr_project", "thr_archived_project"]);
    expect(archived.candidates[1]?.archived).toBe(true);
  });

  it("keeps title search working if project metadata cannot be fetched", async () => {
    const host = createFakePluginHost({ pluginId: "tabs", sdk: {
      projects: { list: vi.fn().mockRejectedValue(new Error("Project metadata temporarily unavailable")) },
      threads: { list: async () => [makeThreadResponse({ id: "thr_title_fallback", title: "Login fix" })] },
    } });
    loadedHosts.push(host);
    await plugin(host.bb);
    expect((await host.harness.behavior.callRpc("tabs_search", { query: "login" })).candidates.map((item) => item.threadId)).toEqual(["thr_title_fallback"]);
  });

  it("optionally searches archived chats with separate caches and never includes deleted or hidden chats", async () => {
    const list = vi.fn(async (args?: { archived?: boolean }) => args?.archived ? [
      makeThreadResponse({ id: "thr_archived_search", title: "Old task", archivedAt: 1 }),
      makeThreadResponse({ id: "thr_deleted_search", title: "Old task", deletedAt: 1, archivedAt: 1 }),
      makeThreadResponse({ id: "thr_hidden_search", title: "Old task", visibility: "hidden", archivedAt: 1 }),
    ] : [makeThreadResponse({ id: "thr_active_search", title: "Old task" })]);
    const host = createFakePluginHost({ pluginId: "tabs", sdk: { threads: { list }, projects: { list: async () => [] } } });
    loadedHosts.push(host);
    await plugin(host.bb);
    await expect(host.harness.behavior.setSettings({ searchArchivedChats: true })).resolves.toBeUndefined();
    await expect(host.harness.behavior.setSettings({ searchArchivedChats: "true" })).rejects.toThrow();
    const active = await host.harness.behavior.callRpc("tabs_search", { query: "Old task" });
    expect(active.candidates.map((item) => item.threadId)).toEqual(["thr_active_search"]);
    const all = await host.harness.behavior.callRpc("tabs_search", { query: "Old task", includeArchived: true });
    expect(all.candidates.map((item) => item.threadId)).toEqual(["thr_active_search", "thr_archived_search"]);
    expect(all.candidates[1]?.archived).toBe(true);
    expect((await host.harness.behavior.callRpc("tabs_search", { query: "Old task", includeArchived: false })).candidates).toEqual(active.candidates);
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("searches titles beyond plugin history and the first BB page, caches only metadata, and excludes unavailable chats", async () => {
    const title = "Обновить систему до версии 0.43.3 — office";
    const page = Array.from({ length: 200 }, (_, i) => makeThreadResponse({ id: `thr_page_${i}`, title: "Unrelated chat" }));
    const list = vi.fn(async (args?: { offset?: number }) => args?.offset === 0 ? page : [
      makeThreadResponse({ id: "thr_office", projectId: "proj_office", title }),
      makeThreadResponse({ id: "thr_archived", title, archivedAt: 1 }),
      makeThreadResponse({ id: "thr_deleted", title, deletedAt: 1 }),
      makeThreadResponse({ id: "thr_hidden", title, visibility: "hidden" }),
    ]);
    const host = createFakePluginHost({ pluginId: "tabs", sdk: { threads: { list }, projects: { list: async () => [] } } });
    loadedHosts.push(host);
    await plugin(host.bb);
    const result = await host.harness.behavior.callRpc("tabs_search", { query: "43" });
    expect(result.candidates).toEqual([{ threadId: "thr_office", projectId: "proj_office", title }]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenNthCalledWith(2, { archived: false, includeHidden: false, limit: 200, offset: 200 });
    expect((await host.harness.behavior.callRpc("tabs_search", { query: title })).candidates).toEqual(result.candidates);
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
    ).rejects.toThrow('expects a boolean');
  });

  it("handles behavior 2", async () => {
    const host = await loadPlugin();

    await expect(host.harness.behavior.setSettings({ language: "Русский" })).resolves.toBeUndefined();
    await expect(host.harness.behavior.setSettings({ language: "Italiano" })).resolves.toBeUndefined();
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
      host.harness.inspection.realtimeSignals.filter(
        (signal) => signal.channel === "tabs-changed",
      ),
    ).toHaveLength(3);
  });

  it("does not let a stale renderer recreate a closed preview", async () => {
    const host = await loadPlugin();
    const candidate = { threadId: "thr_closed", projectId: "proj_api", title: "Closed chat" };

    await host.harness.behavior.callRpc("tabs_sync_activity", { threads: [candidate] });
    const closed = await host.harness.behavior.callRpc("tabs_close", { threadId: candidate.threadId });
    expect(closed.removed).toBe(true);
    expect(closed.state.entries).toEqual([]);

    const stale = await host.harness.behavior.callRpc("tabs_sync_activity", { threads: [candidate] });
    expect(stale.state.entries).toEqual([]);
    expect((await host.harness.behavior.callRpc("tabs_list", null)).state.entries).toEqual([]);

    const reopened = await host.harness.behavior.callRpc("tabs_sync_activity", {
      threads: [candidate], reopen: true,
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
    const archivedEvent = await host.harness.behavior.emitThreadEvent(
      "thread.archived",
      {
        thread: makeThreadResponse({
          id: "thr_archived",
          archivedAt: 10,
        }),
      },
    );
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
    const deletedEvent = await host.harness.behavior.emitThreadEvent(
      "thread.deleted",
      {
        thread: makeThreadResponse({
          id: "thr_deleted",
          deletedAt: 20,
        }),
      },
    );
    expect(deletedEvent.errors).toEqual([]);

    const deleted = await host.harness.behavior.callRpc("tabs_list", null);
    expect(deleted.state.entries).toEqual([]);
    expect(
      deleted.history?.entries.find((entry) => entry.threadId === "thr_deleted"),
    ).toEqual(expect.objectContaining({ unavailableReason: "deleted" }));
  });

  it("resolves an open chat that is absent from the sidebar snapshot", async () => {
    const host = createFakePluginHost({
      pluginId: "tabs",
      sdk: { threads: { get: async ({ threadId }: { threadId: string }) =>
        makeThreadResponse({
          id: threadId,
          projectId: "proj_api",
          title: "Missing from sidebar",
          archivedAt: threadId === "thr_archived" ? 1 : null,
        }),
      } },
    });
    loadedHosts.push(host);
    await plugin(host.bb);
    await expect(host.harness.behavior.callRpc("tabs_resolve_current", {
      threadId: "thr_open",
    })).resolves.toEqual({ createdAt: expect.any(Number), candidate: {
      threadId: "thr_open", projectId: "proj_api", title: "Missing from sidebar",
    } });
    await expect(host.harness.behavior.callRpc("tabs_resolve_current", {
      threadId: "thr_archived",
    })).resolves.toEqual({ candidate: null, createdAt: expect.any(Number) });
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
      reconciled.history?.entries.map((entry) => [
        entry.threadId,
        entry.unavailableReason,
      ]),
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
      host.harness.inspection.realtimeSignals.filter(
        (signal) => signal.channel === "tabs-changed",
      ),
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
                input.threadId === "thr_system_all" ||
                input.threadId === "thr_child"
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

    expect(closed).toEqual({ state: { version: 1, entries: [] }, removed: true });
    expect(host.harness.inspection.sdk.calls).toEqual([]);
  });
});
