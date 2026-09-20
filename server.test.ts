import { afterEach, describe, expect, it } from "vitest";
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

describe("RPC верхних вкладок", () => {
  it("объявляет настройку видимости закреплённых чатов на экране «Новый чат»", async () => {
    const host = await loadPlugin();

    await expect(
      host.harness.behavior.setSettings({ showPinnedTabsList: false }),
    ).resolves.toBeUndefined();
    await expect(
      host.harness.behavior.setSettings({ showPinnedTabsList: "false" }),
    ).rejects.toThrow('expects a boolean');
  });

  it("объявляет настройки видимости верхней панели и состава списка", async () => {
    const host = await loadPlugin();

    await expect(
      host.harness.behavior.setSettings({
        showTabsOnDesktop: false,
        showTabsOnMobile: false,
        showTabListButton: false,
        showTabListPinned: false,
        showTabListHistory: false,
        tabListButtonPosition: "Справа",
      }),
    ).resolves.toBeUndefined();
    await expect(
      host.harness.behavior.setSettings({
        tabListButtonPosition: "Сверху",
      }),
    ).rejects.toThrow();
  });

  it("автосинхронизация обновляет одну preview, а pin сохраняет её", async () => {
    const host = await loadPlugin();

    const first = await host.harness.behavior.callRpc("tabs_sync_activity", {
      threads: [
        { threadId: "thr_build", projectId: "proj_api", title: "Сборка" },
        { threadId: "thr_review", projectId: "proj_api", title: "Ревью" },
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
          title: "Сборка релиза",
        },
      ],
    });

    expect(refreshed.state.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          threadId: "thr_review",
          title: "Ревью",
          pinned: true,
        }),
        expect.objectContaining({
          threadId: "thr_build",
          title: "Сборка релиза",
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

  it("ведёт отдельную историю посещений и возвращает её с tabs_list", async () => {
    const host = await loadPlugin();

    await host.harness.behavior.callRpc("tabs_history_visit", {
      threadId: "thr_first",
      projectId: "proj_api",
      title: "Первый",
    });
    await host.harness.behavior.callRpc("tabs_history_visit", {
      threadId: "thr_second",
      projectId: "proj_web",
      title: "Второй",
    });
    await host.harness.behavior.callRpc("tabs_history_visit", {
      threadId: "thr_first",
      projectId: "proj_api",
      title: "Первый (обновлён)",
    });

    const list = await host.harness.behavior.callRpc("tabs_list", null);
    expect(list.history?.entries).toEqual([
      expect.objectContaining({
        threadId: "thr_first",
        projectId: "proj_api",
        title: "Первый (обновлён)",
      }),
      expect.objectContaining({
        threadId: "thr_second",
        projectId: "proj_web",
        title: "Второй",
      }),
    ]);
    expect(
      host.harness.inspection.realtimeSignals.filter(
        (signal) => signal.channel === "tabs-history-changed",
      ),
    ).toHaveLength(3);
  });

  it("убирает архивные и удалённые чаты из tabs/pin, сохраняя history tombstone", async () => {
    const host = await loadPlugin();

    await host.harness.behavior.callRpc("tabs_open", {
      threadId: "thr_archived",
      projectId: "proj_api",
      title: "Архивируемый",
    });
    await host.harness.behavior.callRpc("tabs_history_visit", {
      threadId: "thr_archived",
      projectId: "proj_api",
      title: "Архивируемый",
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
      title: "Удаляемый",
    });
    await host.harness.behavior.callRpc("tabs_history_visit", {
      threadId: "thr_deleted",
      projectId: "proj_api",
      title: "Удаляемый",
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

  it("сверяет архивы и удаления, случившиеся до загрузки плагина", async () => {
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
      ["thr_legacy_archived", "Старый архив"],
      ["thr_legacy_deleted", "Старое удаление"],
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

  it("не называет чат удалённым при transient ошибке сверки", async () => {
    const host = createFakePluginHost({
      pluginId: "tabs",
      sdk: {
        threads: {
          get: async () => {
            throw new Error("временная ошибка сети");
          },
        },
      },
    });
    loadedHosts.push(host);
    await plugin(host.bb);

    await host.harness.behavior.callRpc("tabs_open", {
      threadId: "thr_unknown",
      projectId: "proj_api",
      title: "Пока недоступный для сверки",
    });
    await host.harness.behavior.callRpc("tabs_history_visit", {
      threadId: "thr_unknown",
      projectId: "proj_api",
      title: "Пока недоступный для сверки",
    });

    const result = await host.harness.behavior.callRpc("tabs_list", null);
    expect(result.state.entries).toEqual([
      expect.objectContaining({ threadId: "thr_unknown", pinned: true }),
    ]);
    expect(result.history?.entries[0]).toEqual(
      expect.not.objectContaining({ unavailableReason: expect.anything() }),
    );
  });

  it("сохраняет общий ручной порядок закреплённых вкладок через проекты", async () => {
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
    // Три открытия и одно реальное перемещение: no-op не шумит realtime.
    expect(
      host.harness.inspection.realtimeSignals.filter(
        (signal) => signal.channel === "tabs-changed",
      ),
    ).toHaveLength(4);
  });

  it("читает durable workflow activity встроенного workflows по origin-чату", async () => {
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
          title: "Завершённый workflow",
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

  it("объединяет параллельные tabs_list с одинаковым workflow input", async () => {
    let workflowCalls = 0;
    const host = createFakePluginHost({
      pluginId: "tabs",
      sdk: {
        plugins: {
          callRpc: async () => {
            workflowCalls += 1;
            // Сохраняем request in-flight на microtask, чтобы второй renderer
            // встретил уже зарегистрированный server-side promise.
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
      title: "Общий workflow",
    });

    const [first, second] = await Promise.all([
      host.harness.behavior.callRpc("tabs_list", null),
      host.harness.behavior.callRpc("tabs_list", null),
    ]);

    expect(first).toEqual(second);
    expect(first.activeWorkflowThreadIds).toEqual(["thr_shared"]);
    expect(workflowCalls).toBe(1);
  });

  it("сериализует одновременные обновления из двух окон и оставляет последний preview", async () => {
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

  it("явное добавление закрепляет чат и закрытие не архивирует его", async () => {
    const host = await loadPlugin();
    const opened = await host.harness.behavior.callRpc("tabs_open", {
      threadId: "thr_keep",
      projectId: "proj_a",
      title: "Не архивировать",
    });
    expect(opened.state.entries).toEqual([
      expect.objectContaining({ threadId: "thr_keep", pinned: true }),
    ]);

    const closed = await host.harness.behavior.callRpc("tabs_close", {
      threadId: "thr_keep",
    });

    expect(closed).toEqual({ state: { version: 1, entries: [] }, removed: true });
    // Закрытие plugin tab не обращается к thread SDK: runtime продолжает идти.
    expect(host.harness.inspection.sdk.calls).toEqual([]);
  });
});
