import { afterEach, describe, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { createTabsTestHost, withTabsRpcTypes } from "./test-utils";
import { createInitialWorkspaces, getWorkspace, workspaceCollectionSchema } from "./lib/workspaces";
import {
  createEmptyTabsState,
  openTabCandidate,
  setTabFavorite,
  setTabPinned,
  type TabEntry,
} from "./lib/tabs-model";

const hosts: ReturnType<typeof createTabsTestHost>[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose()));
});
const candidate = { threadId: "thread", projectId: "project", title: "Chat" };

function makeHost() {
  const host = createTabsTestHost({
    pluginId: "tabs",
    sdk: {
      threads: {
        get: async ({ threadId }) =>
          makeThreadResponse({ id: threadId, projectId: "project", title: "Chat" }),
      },
    },
  });
  hosts.push(host);
  return host;
}

function readSaved(host: ReturnType<typeof makeHost>) {
  const row: unknown = host.bb.storage
    .database()
    .prepare("SELECT value FROM tabs_workspace_state WHERE id = 1")
    .get();
  if (typeof row !== "object" || row === null || !("value" in row) || typeof row.value !== "string")
    throw new Error("Missing workspace row");
  return workspaceCollectionSchema.parse(JSON.parse(row.value));
}

async function list(host: ReturnType<typeof makeHost>, workspaceId: string | null) {
  return host.harness.behavior.callRpc("tabs_list", { workspaceId, workflowThreadIds: [] });
}

describe("workspace server and real SQLite", () => {
  it("lists unique pins across workspaces without changing memberships or visit history", async () => {
    const host = makeHost();
    await plugin(host.bb);
    await host.harness.behavior.callRpc("tabs_open", candidate);
    await host.harness.behavior.callRpc("tabs_open", { ...candidate, workspaceId: "home" });
    const foreign = {
      ...candidate,
      threadId: "foreign",
      title: "Foreign pin",
      workspaceId: "home",
    };
    await host.harness.behavior.callRpc("tabs_open", foreign);
    await host.harness.behavior.callRpc("tabs_open", { ...foreign, threadId: "preview" });
    await host.harness.behavior.callRpc("tabs_set_pinned", {
      workspaceId: "home",
      threadId: "preview",
      pinned: false,
    });
    await host.harness.behavior.callRpc("tabs_set_favorite", {
      workspaceId: "home",
      threadId: "favorite",
      favorite: true,
      candidate: { ...candidate, threadId: "favorite" },
    });
    const before = readSaved(host);
    const result = await host.harness.behavior.callRpc("tabs_pinned_list", null);
    expect(result.entries.map((entry) => entry.threadId)).toEqual([candidate.threadId, "foreign"]);
    expect(result.stateRevision).toBe(before.revision);
    expect(readSaved(host)).toEqual(before);
    expect((await list(host, "work")).history?.entries).toEqual([]);
    await expect(host.harness.behavior.callRpc("tabs_pinned_list", {})).rejects.toThrow();

    await host.harness.behavior.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({ id: "foreign", archivedAt: 200 }),
    });
    expect(
      (await host.harness.behavior.callRpc("tabs_pinned_list", null)).entries.map(
        (entry) => entry.threadId,
      ),
    ).toEqual([candidate.threadId]);
    const pending = host.harness.behavior.callRpc("tabs_open", { ...foreign, threadId: "queued" });
    const afterPending = host.harness.behavior.callRpc("tabs_pinned_list", null);
    await pending;
    expect((await afterPending).entries.map((entry) => entry.threadId)).toEqual([
      candidate.threadId,
      "queued",
    ]);
  });
  it.each(["active", "archived", "not found", "transient error"] as const)(
    "prefers a lifecycle event to a delayed %s availability result",
    async (outcome) => {
      const host = makeHost();
      await plugin(host.bb);
      await host.harness.behavior.callRpc("tabs_open", candidate);
      await host.harness.behavior.callRpc("tabs_history_visit", candidate);
      let finish!: (thread: ReturnType<typeof makeThreadResponse>) => void;
      let fail!: (cause: Error) => void;
      let started!: () => void;
      const entered = new Promise<void>((done) => {
        started = done;
      });
      const gate = new Promise<ReturnType<typeof makeThreadResponse>>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
      host.harness.sdk.stub("threads.get", () => {
        started();
        return gate;
      });
      const pending = list(host, "work");
      await entered;
      if (outcome === "active") {
        await host.harness.behavior.emitThreadEvent("thread.archived", {
          thread: makeThreadResponse({ id: candidate.threadId, archivedAt: 200 }),
        });
        finish(makeThreadResponse({ id: candidate.threadId }));
      } else {
        await host.harness.behavior.emitThreadEvent("thread.unarchived", {
          thread: makeThreadResponse({ id: candidate.threadId, archivedAt: null }),
        });
        if (outcome === "archived")
          finish(makeThreadResponse({ id: candidate.threadId, archivedAt: 100 }));
        else
          fail(Object.assign(new Error(outcome), outcome === "not found" ? { status: 404 } : {}));
      }
      const result = await pending;
      expect(result.state.entries).toHaveLength(outcome === "active" ? 0 : 1);
      expect(result.history?.entries[0]?.unavailableReason).toBe(
        outcome === "active" ? "archived" : undefined,
      );
      await list(host, "work");
      expect(host.harness.inspection.sdk.callsTo("threads.get")).toHaveLength(1);
    },
  );

  it("rechecks lifecycle availability inside the write queue after waiting for another thread", async () => {
    const host = makeHost();
    await plugin(host.bb);
    await host.harness.behavior.callRpc("tabs_open", candidate);
    await host.harness.behavior.callRpc("tabs_history_visit", candidate);
    await host.harness.behavior.callRpc("tabs_open", { ...candidate, threadId: "slow" });
    let finish!: (thread: ReturnType<typeof makeThreadResponse>) => void;
    let started!: () => void;
    const entered = new Promise<void>((done) => {
      started = done;
    });
    const gate = new Promise<ReturnType<typeof makeThreadResponse>>((done) => {
      finish = done;
    });
    host.harness.sdk.stub("threads.get", ({ threadId }) => {
      if (threadId === "slow") {
        started();
        return gate;
      }
      return makeThreadResponse({ id: threadId });
    });
    const pending = list(host, "work");
    await entered;
    await Promise.resolve();
    await host.harness.behavior.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({ id: candidate.threadId, archivedAt: 200 }),
    });
    finish(makeThreadResponse({ id: "slow" }));
    const result = await pending;
    expect(result.history?.entries[0]?.unavailableReason).toBe("archived");
    expect(result.state.entries.map((entry) => entry.threadId)).toEqual(["slow"]);
  });
  it("keeps archive events authoritative across simultaneous delayed reconciliation and restore", async () => {
    let finishCold!: (value: ReturnType<typeof makeThreadResponse>) => void;
    let finishUndo!: (value: ReturnType<typeof makeThreadResponse>) => void;
    const cold = new Promise<ReturnType<typeof makeThreadResponse>>((resolve) => {
      finishCold = resolve;
    });
    const undoRead = new Promise<ReturnType<typeof makeThreadResponse>>((resolve) => {
      finishUndo = resolve;
    });
    let coldStarted!: () => void;
    let undoStarted!: () => void;
    const seenCold = new Promise<void>((resolve) => {
      coldStarted = resolve;
    });
    const seenUndo = new Promise<void>((resolve) => {
      undoStarted = resolve;
    });
    let reads = 0;
    const host = createTabsTestHost({
      pluginId: "tabs",
      sdk: {
        threads: {
          get: () => {
            if (++reads === 1) {
              coldStarted();
              return cold;
            }
            undoStarted();
            return undoRead;
          },
        },
      },
    });
    hosts.push(host);
    await plugin(host.bb);
    const candidate = { threadId: "race", projectId: "project", title: "Race" };
    const entry = (await host.harness.behavior.callRpc("tabs_open", candidate)).state.entries[0]!;
    await host.harness.behavior.callRpc("tabs_history_visit", candidate);
    const firstList = host.harness.behavior.callRpc("tabs_list", null);
    await seenCold;
    await host.harness.behavior.callRpc("tabs_close", { threadId: entry.threadId });
    const undo = host.harness.behavior.callRpc("tabs_restore", { entry, index: 0 });
    await seenUndo;
    const archived = await host.harness.behavior.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({ id: entry.threadId, archivedAt: 200, updatedAt: 200 }),
    });
    expect(archived.errors).toEqual([]);
    finishCold(
      makeThreadResponse({ id: entry.threadId, projectId: candidate.projectId, updatedAt: 100 }),
    );
    const staleList = await firstList;
    expect(staleList.history?.entries[0]?.unavailableReason).toBe("archived");
    finishUndo(
      makeThreadResponse({ id: entry.threadId, projectId: candidate.projectId, updatedAt: 100 }),
    );
    const restored = await undo;
    expect(restored.status).toBe("unavailable");
    expect(restored.state.entries).toEqual([]);
  });

  it("does not restore an archived chat after a delayed stale availability lookup", async () => {
    const host = makeHost();
    await plugin(host.bb);
    const entry = (await host.harness.behavior.callRpc("tabs_open", candidate)).state.entries[0]!;
    await host.harness.behavior.callRpc("tabs_close", { threadId: entry.threadId });
    let resolve!: (thread: ReturnType<typeof makeThreadResponse>) => void;
    const gate = new Promise<ReturnType<typeof makeThreadResponse>>((done) => {
      resolve = done;
    });
    host.harness.sdk.stub("threads.get", () => gate);
    const undo = host.harness.behavior.callRpc("tabs_restore", { entry, index: 0 });
    await Promise.resolve();
    await host.harness.behavior.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({ id: entry.threadId, archivedAt: 123 }),
    });
    resolve(makeThreadResponse({ id: entry.threadId, projectId: candidate.projectId }));
    expect((await undo).status).toBe("unavailable");
    expect(getWorkspace(readSaved(host), "work").state.entries).toEqual([]);
  });

  it("restores only the addressed workspace, keeps favorites/order, validates availability and survives write failure", async () => {
    const host = makeHost();
    await plugin(host.bb);
    const original = (await host.harness.behavior.callRpc("tabs_open", candidate)).state
      .entries[0]!;
    await host.harness.behavior.callRpc("tabs_set_favorite", {
      threadId: candidate.threadId,
      favorite: true,
    });
    await host.harness.behavior.callRpc("tabs_open", { ...candidate, threadId: "next" });
    await host.harness.behavior.callRpc("tabs_open", { ...candidate, workspaceId: "home" });
    const home = (await list(host, "home")).state;
    await host.harness.behavior.callRpc("tabs_close", { threadId: candidate.threadId });
    const saved = readSaved(host);
    host.bb.storage
      .database()
      .exec(
        "CREATE TRIGGER undo_failure BEFORE UPDATE ON tabs_workspace_state BEGIN SELECT RAISE(ABORT, 'undo write failure'); END",
      );
    const undo = () =>
      host.harness.behavior.callRpc("tabs_restore", {
        workspaceId: "work",
        entry: original,
        index: 0,
      });
    await expect(undo()).rejects.toThrow("undo write failure");
    expect(readSaved(host)).toEqual(saved);
    host.bb.storage.database().exec("DROP TRIGGER undo_failure");
    const result = await undo();
    expect(result.status).toBe("restored");
    expect(result.state.entries[0]).toEqual(original);
    expect(result.state.entries[1]?.threadId).toBe("next");
    expect(result.state.favorites?.[0]?.threadId).toBe(candidate.threadId);
    expect(getWorkspace(readSaved(host), "work").closedThreadIds).not.toContain(candidate.threadId);
    expect((await list(host, "home")).state).toEqual(home);
    expect((await undo()).status).toBe("open");
    await host.harness.behavior.callRpc("tabs_close", { threadId: candidate.threadId });
    host.harness.sdk.stub("threads.get", ({ threadId }) =>
      makeThreadResponse({ id: threadId, archivedAt: 123 }),
    );
    expect((await undo()).status).toBe("unavailable");
    expect(
      getWorkspace(readSaved(host), "work").state.entries.map((entry) => entry.threadId),
    ).toEqual(["next"]);
    host.harness.sdk.stub("threads.get", () => {
      throw Object.assign(new Error("not found"), { status: 404 });
    });
    expect((await undo()).status).toBe("unavailable");
  });

  it("reports tab memberships (not favorites), reflects queued changes, and preserves unrelated sets on removal", async () => {
    const host = makeHost();
    await plugin(host.bb);
    await host.harness.behavior.callRpc("tabs_open", candidate);
    const workBefore = (await list(host, "work")).state;
    await host.harness.behavior.callRpc("tabs_set_favorite", {
      workspaceId: "other",
      threadId: candidate.threadId,
      favorite: true,
      candidate,
    });
    await host.harness.behavior.callRpc("tabs_sync_activity", {
      workspaceId: "home",
      threads: [candidate],
    });
    const memberships = () =>
      host.harness.behavior.callRpc("tabs_workspace_memberships", { threadId: candidate.threadId });
    expect((await memberships()).workspaces.map(({ id, included }) => [id, included])).toEqual([
      ["work", true],
      ["home", true],
      ["other", false],
    ]);
    const opening = host.harness.behavior.callRpc("tabs_open", {
      ...candidate,
      workspaceId: "other",
    });
    const updated = await memberships();
    await opening;
    expect(updated.workspaces.every((workspace) => workspace.included)).toBe(true);
    await host.harness.behavior.callRpc("tabs_close", {
      workspaceId: "other",
      threadId: candidate.threadId,
    });
    await host.harness.behavior.callRpc("tabs_sync_activity", {
      workspaceId: "other",
      threads: [candidate],
    });
    expect(
      (await memberships()).workspaces.find((workspace) => workspace.id === "other")?.included,
    ).toBe(false);
    expect((await list(host, "other")).state.favorites?.[0]?.threadId).toBe(candidate.threadId);
    expect((await list(host, "work")).state).toEqual(workBefore);
    expect((await list(host, "home")).state.entries[0]?.pinned).toBe(false);
    await host.harness.behavior.callRpc("tabs_workspace_rename", {
      workspaceId: "home",
      name: "Office",
    });
    expect(
      (await memberships()).workspaces.find((workspace) => workspace.id === "home")?.name,
    ).toBe("Office");
    await host.harness.behavior.callRpc("tabs_workspace_delete", { workspaceId: "home" });
    expect((await memberships()).workspaces.map((workspace) => workspace.id)).toEqual([
      "work",
      "other",
    ]);
    expect(
      host.harness.inspection.realtimeSignals.some(
        (signal) => signal.channel === "tabs-workspace-memberships-changed",
      ),
    ).toBe(true);
  });
  it("migrates once, preserves legacy keys and shared history, and does not re-import after reload", async () => {
    let host = makeHost();
    const pinned = setTabPinned(
      openTabCandidate(createEmptyTabsState(), candidate, 10),
      candidate.threadId,
      true,
    );
    const legacy = setTabPinned(
      openTabCandidate(
        setTabFavorite(pinned, candidate.threadId, true),
        { ...candidate, threadId: "preview" },
        20,
      ),
      "preview",
      false,
    );
    expect(legacy.entries.map((entry) => entry.pinned)).toEqual([true, false]);
    await host.bb.storage.kv.set("tabs.state.v1", legacy);
    await host.bb.storage.kv.set("tabs.closedThreads.v1", ["closed"]);
    await plugin(host.bb);
    const work = await list(host, "work");
    expect(work.state).toEqual(legacy);
    expect(work.workspaces?.map((item) => item.id)).toEqual(["work", "home", "other"]);
    expect((await list(host, "home")).state).toEqual(createEmptyTabsState());
    expect(getWorkspace(readSaved(host)).closedThreadIds).toEqual(["closed"]);
    await host.harness.behavior.callRpc("tabs_history_visit", candidate);
    await host.harness.behavior.callRpc("tabs_close", { workspaceId: "work", threadId: "preview" });
    host = withTabsRpcTypes(await host.harness.lifecycle.reload(plugin));
    hosts[hosts.length - 1] = host;
    const restored = await list(host, "work");
    expect(restored.state.entries.map((entry) => entry.threadId)).toEqual([candidate.threadId]);
    expect((await list(host, "home")).history).toEqual(restored.history);
    expect(restored.history?.entries[0]?.threadId).toBe(candidate.threadId);
    expect(await host.bb.storage.kv.get("tabs.state.v1")).toEqual(legacy);
    expect(await host.bb.storage.kv.get("tabs.closedThreads.v1")).toEqual(["closed"]);
  });

  it("isolates memberships, order, previews, favorites, closed guards and realtime channels", async () => {
    const host = makeHost();
    await plugin(host.bb);
    await host.harness.behavior.callRpc("tabs_open", candidate);
    const workBefore = (await list(host, "work")).state;
    const legacySignals = host.harness.inspection.realtimeSignals.filter(
      (signal) => signal.channel === "tabs-changed",
    ).length;
    for (const item of [candidate, { ...candidate, threadId: "second" }]) {
      await host.harness.behavior.callRpc("tabs_open", { ...item, workspaceId: "home" });
      await host.harness.behavior.callRpc("tabs_set_pinned", {
        workspaceId: "home",
        threadId: item.threadId,
        pinned: true,
      });
    }
    await host.harness.behavior.callRpc("tabs_set_favorite", {
      workspaceId: "home",
      threadId: candidate.threadId,
      favorite: true,
    });
    await host.harness.behavior.callRpc("tabs_move", {
      workspaceId: "home",
      sourceThreadId: "second",
      targetThreadId: candidate.threadId,
      position: "before",
    });
    expect((await list(host, "home")).state.entries.map((entry) => entry.threadId)).toEqual([
      "second",
      candidate.threadId,
    ]);
    await host.harness.behavior.callRpc("tabs_close", {
      workspaceId: "home",
      threadId: candidate.threadId,
    });
    await host.harness.behavior.callRpc("tabs_sync_activity", {
      workspaceId: "home",
      threads: [candidate],
    });
    const home = (await list(host, "home")).state;
    expect(home.entries.map((entry) => entry.threadId)).toEqual(["second"]);
    expect(home.favorites?.[0]?.threadId).toBe(candidate.threadId);
    expect((await list(host, "work")).state).toEqual(workBefore);
    expect((await list(host, "other")).state.entries).toEqual([]);
    expect(
      host.harness.inspection.realtimeSignals.filter((signal) => signal.channel === "tabs-changed"),
    ).toHaveLength(legacySignals);
    expect(
      host.harness.inspection.realtimeSignals.some(
        (signal) => signal.channel === "tabs-changed:home",
      ),
    ).toBe(true);
    await host.harness.behavior.callRpc("tabs_sync_activity", {
      workspaceId: "other",
      threads: [candidate],
    });
    expect((await list(host, "other")).state.entries[0]?.threadId).toBe(candidate.threadId);
  });

  it("uses stable IDs, validates metadata and rejects queued actions to a deleted mode without legacy fallback", async () => {
    const host = makeHost();
    await plugin(host.bb);
    const created = await host.harness.behavior.callRpc("tabs_workspace_create", {
      name: "  QA  ",
    });
    const renamed = await host.harness.behavior.callRpc("tabs_workspace_rename", {
      workspaceId: created.workspaceId,
      name: "Custom",
    });
    expect(renamed.workspaces.find((item) => item.id === created.workspaceId)?.name).toBe("Custom");
    await expect(
      host.harness.behavior.callRpc("tabs_workspace_create", { name: "CUSTOM" }),
    ).rejects.toThrow("already exists");
    const dropped = host.harness.behavior.callRpc("tabs_workspace_delete", {
      workspaceId: created.workspaceId,
    });
    const stale = host.harness.behavior.callRpc("tabs_open", {
      ...candidate,
      workspaceId: created.workspaceId,
    });
    expect((await Promise.allSettled([dropped, stale])).map((result) => result.status)).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect((await list(host, "work")).state.entries).toEqual([]);
    await host.harness.behavior.callRpc("tabs_workspace_delete", { workspaceId: "work" });
    expect((await list(host, null)).workspaceId).toBe("home");
    await expect(host.harness.behavior.callRpc("tabs_list", null)).rejects.toThrow(
      "no longer exists",
    );
    await expect(host.harness.behavior.callRpc("tabs_open", candidate)).rejects.toThrow(
      "no longer exists",
    );
    await expect(list(host, "work")).rejects.toThrow("no longer exists");
    await host.harness.behavior.callRpc("tabs_workspace_delete", { workspaceId: "home" });
    await expect(
      host.harness.behavior.callRpc("tabs_workspace_delete", { workspaceId: "other" }),
    ).rejects.toThrow("at least one");
    expect(
      host.harness.inspection.realtimeSignals.some(
        (signal) => signal.channel === "tabs-workspaces-changed",
      ),
    ).toBe(true);
  });

  it.each(["thread.archived", "thread.deleted"] as const)(
    "removes unavailable memberships from every mode on %s and never restores them on unarchive",
    async (event) => {
      const host = makeHost();
      await plugin(host.bb);
      for (const workspaceId of ["work", "home", "other"]) {
        await host.harness.behavior.callRpc("tabs_open", { ...candidate, workspaceId });
        await host.harness.behavior.callRpc("tabs_set_pinned", {
          workspaceId,
          threadId: candidate.threadId,
          pinned: true,
        });
        await host.harness.behavior.callRpc("tabs_set_favorite", {
          workspaceId,
          threadId: candidate.threadId,
          favorite: true,
        });
      }
      await host.harness.behavior.callRpc("tabs_history_visit", candidate);
      expect(
        (
          await host.harness.behavior.emitThreadEvent(event, {
            thread: makeThreadResponse({
              id: candidate.threadId,
              ...(event === "thread.archived" ? { archivedAt: 1 } : { deletedAt: 1 }),
            }),
          })
        ).errors,
      ).toEqual([]);
      expect(
        readSaved(host).workspaces.every(
          ({ state }) => state.entries.length === 0 && (state.favorites?.length ?? 0) === 0,
        ),
      ).toBe(true);
      expect(
        (
          await host.harness.behavior.emitThreadEvent("thread.unarchived", {
            thread: makeThreadResponse({ id: candidate.threadId, archivedAt: null }),
          })
        ).errors,
      ).toEqual([]);
      expect((await list(host, "home")).history?.entries[0]?.unavailableReason).toBeUndefined();
      expect(
        readSaved(host).workspaces.every(
          ({ state }) => state.entries.length === 0 && (state.favorites?.length ?? 0) === 0,
        ),
      ).toBe(true);
      expect(
        readSaved(host).workspaces.every((workspace) =>
          workspace.closedThreadIds.includes(candidate.threadId),
        ),
      ).toBe(true);
      expect(
        (
          await host.harness.behavior.callRpc("tabs_sync_activity", {
            workspaceId: "home",
            threads: [candidate],
          })
        ).state.entries,
      ).toEqual([]);
      const explicit = await host.harness.behavior.callRpc("tabs_sync_activity", {
        workspaceId: "home",
        threads: [candidate],
        reopen: true,
      });
      expect(explicit.state.entries[0]?.pinned).toBe(false);
      expect(explicit.state.favorites ?? []).toEqual([]);
    },
  );

  it("retries failed migration without touching the source, and a failed mutation publishes nothing", async () => {
    const host = makeHost();
    const legacy = setTabPinned(
      openTabCandidate(createEmptyTabsState(), candidate, 10),
      candidate.threadId,
      false,
    );
    await host.bb.storage.kv.set("tabs.state.v1", legacy);
    await plugin(host.bb);
    const db = host.bb.storage.database();
    db.exec(
      "CREATE TRIGGER qa_failure BEFORE INSERT ON tabs_workspace_state BEGIN SELECT RAISE(ABORT, 'qa write failure'); END",
    );
    await expect(list(host, "work")).rejects.toThrow("qa write failure");
    expect(db.prepare("SELECT value FROM tabs_workspace_state").all()).toEqual([]);
    expect(await host.bb.storage.kv.get("tabs.state.v1")).toEqual(legacy);
    db.exec("DROP TRIGGER qa_failure");
    expect((await list(host, "work")).state).toEqual(legacy);
    db.exec(
      "CREATE TRIGGER qa_failure BEFORE UPDATE ON tabs_workspace_state BEGIN SELECT RAISE(ABORT, 'qa write failure'); END",
    );
    const signals = host.harness.inspection.realtimeSignals.length;
    await expect(
      host.harness.behavior.callRpc("tabs_set_pinned", {
        workspaceId: "work",
        threadId: candidate.threadId,
        pinned: true,
      }),
    ).rejects.toThrow("qa write failure");
    expect(host.harness.inspection.realtimeSignals).toHaveLength(signals);
    expect(getWorkspace(readSaved(host)).state).toEqual(legacy);
    db.exec("DROP TRIGGER qa_failure");
    expect(
      (
        await host.harness.behavior.callRpc("tabs_set_pinned", {
          workspaceId: "work",
          threadId: candidate.threadId,
          pinned: true,
        })
      ).state.entries[0]?.pinned,
    ).toBe(true);
  });

  it.each(["{", '{"version":2,"workspaces":[]}'])(
    "does not overwrite damaged new storage with old KV: %s",
    async (corrupt) => {
      const host = makeHost();
      await host.bb.storage.kv.set(
        "tabs.state.v1",
        openTabCandidate(createEmptyTabsState(), candidate, 10),
      );
      await plugin(host.bb);
      const db = host.bb.storage.database();
      db.prepare("INSERT INTO tabs_workspace_state (id, value) VALUES (1, ?)").run(corrupt);
      await expect(list(host, null)).rejects.toThrow("storage is damaged");
      await expect(
        host.harness.behavior.callRpc("tabs_open", { ...candidate, workspaceId: "work" }),
      ).rejects.toThrow("storage is damaged");
      expect(db.prepare("SELECT value FROM tabs_workspace_state WHERE id = 1").get()).toEqual({
        value: corrupt,
      });
    },
  );

  it("does not deduplicate identical activity/list requests across workspace IDs", async () => {
    const host = makeHost();
    await plugin(host.bb);
    await Promise.all(
      ["work", "home"].map((workspaceId) =>
        host.harness.behavior.callRpc("tabs_sync_activity", { workspaceId, threads: [candidate] }),
      ),
    );
    const results = await Promise.all([list(host, "work"), list(host, "home")]);
    expect(results.map((result) => result.workspaceId)).toEqual(["work", "home"]);
    expect(
      results.every((result) => result.state.entries[0]?.threadId === candidate.threadId),
    ).toBe(true);
    expect(
      readSaved(host)
        .workspaces.slice(0, 2)
        .every((workspace) => workspace.state.entries.length === 1),
    ).toBe(true);
  });

  it("reconciles inactive sets at startup, deduplicates history/favorite lookups and preserves transient failures", async () => {
    const host = createTabsTestHost({
      pluginId: "tabs",
      sdk: {
        threads: {
          get: async ({ threadId }) => {
            if (threadId === "transient") throw new Error("temporarily unavailable");
            return makeThreadResponse({
              id: threadId,
              archivedAt: threadId === "archived" ? 1 : null,
              deletedAt: threadId === "deleted" ? 1 : null,
            });
          },
        },
      },
    });
    hosts.push(host);
    await plugin(host.bb);
    const initial = createInitialWorkspaces(undefined, undefined);
    const entry = { ...candidate, openedAt: 1, pinned: true };
    const collection = {
      ...initial,
      workspaces: initial.workspaces.map((workspace) => ({
        ...workspace,
        state:
          workspace.id === "home"
            ? { version: 1 as const, entries: [], favorites: [{ ...entry, threadId: "archived" }] }
            : workspace.id === "other"
              ? {
                  version: 1 as const,
                  entries: [
                    { ...entry, threadId: "deleted" },
                    { ...entry, threadId: "transient" },
                  ],
                }
              : workspace.state,
      })),
    };
    host.bb.storage
      .database()
      .prepare("INSERT INTO tabs_workspace_state (id, value) VALUES (1, ?)")
      .run(JSON.stringify(workspaceCollectionSchema.parse(collection)));
    await host.harness.behavior.callRpc("tabs_history_visit", {
      ...candidate,
      threadId: "archived",
    });
    const work = await list(host, "work");
    expect(work.state.entries).toEqual([]);
    expect(work.history?.entries[0]?.unavailableReason).toBe("archived");
    const saved = readSaved(host);
    expect(getWorkspace(saved, "home").state.favorites ?? []).toEqual([]);
    expect(getWorkspace(saved, "other").state.entries.map((entry) => entry.threadId)).toEqual([
      "transient",
    ]);
    expect(host.harness.inspection.sdk.callsTo("threads.get")).toHaveLength(3);
    await list(host, "home");
    expect(host.harness.inspection.sdk.callsTo("threads.get")).toHaveLength(3);
  });

  it("stores the full 20 × (100 tabs + 100 favorites) collection beyond the KV limit and deduplicates lookups across modes", async () => {
    const host = makeHost();
    await plugin(host.bb);
    const initial = createInitialWorkspaces(undefined, undefined);
    const entries: TabEntry[] = Array.from({ length: 100 }, (_, index) => ({
      ...candidate,
      threadId: `thread-${index}`,
      title: "x".repeat(300),
      pinned: true,
      openedAt: index,
    }));
    const collection = workspaceCollectionSchema.parse({
      version: 1,
      revision: 0,
      workspaces: Array.from({ length: 20 }, (_, index) => ({
        ...(initial.workspaces[index] ?? { id: `qa-${index}`, name: `Mode ${index}` }),
        state: { version: 1, entries, favorites: entries },
        closedThreadIds: [],
      })),
    });
    const json = JSON.stringify(collection);
    expect(Buffer.byteLength(json)).toBeGreaterThan(256 * 1024);
    host.bb.storage
      .database()
      .prepare("INSERT INTO tabs_workspace_state (id, value) VALUES (1, ?)")
      .run(json);
    expect((await list(host, "home")).state.favorites).toHaveLength(100);
    expect(host.harness.inspection.sdk.callsTo("threads.get")).toHaveLength(100);
    await host.harness.behavior.callRpc("tabs_set_favorite", {
      workspaceId: "home",
      threadId: "thread-0",
      favorite: false,
    });
    expect(getWorkspace(readSaved(host), "home").state.favorites).toHaveLength(99);
    expect(getWorkspace(readSaved(host), "work").state.favorites).toHaveLength(100);
    expect(readSaved(host).workspaces).toHaveLength(20);
  });
});
