// @vitest-environment jsdom
import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { rpcContract } from "../server";

const app = await loadPluginApp(() => import("../app"));
const homepage = app.homepageSections.find((slot) => slot.id === "pinned-tabs");
if (!homepage) throw new Error("Homepage tabs not registered");
const originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");
const state = { version: 1 as const, entries: [{ threadId: "thr_startup", projectId: "proj_home", title: "Saved tab", pinned: true, openedAt: 1 }] };
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  if (originalHidden) Object.defineProperty(document, "hidden", originalHidden);
  else Reflect.deleteProperty(document, "hidden");
});

const mount = (list: () => Promise<{ state: typeof state }> | { state: typeof state }, connection: "connected" | "connecting" = "connected") => renderSlot<{ projectId: string | null }, Pick<typeof rpcContract, "tabs_list">>(homepage!, { projectId: null }, {
  context: { threadId: null, projectId: null },
  settings: { showPinnedTabsList: true },
  realtimeConnectionState: connection,
  rpc: { tabs_list: list },
});

describe("Homepage tabs cold start", () => {
  it("recovers from an initial RPC failure without opening a chat", async () => {
    const list = vi.fn().mockRejectedValueOnce(new Error("Plugin starting")).mockResolvedValue({ state });
    const slot = mount(list);
    expect(slot.getByRole("status").textContent).toBe("Loading tabs…");
    expect(slot.queryByText('No tabs yet. Open a chat and choose “Pin”.')).toBeNull();
    expect(await slot.findByRole("button", { name: /Saved tab/ }, { timeout: 4000 })).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(2);
    expect(slot.getByRole("heading", { name: "Tabs" })).toBeTruthy();
  });

  it("loads on the homepage when an initially hidden document becomes visible", async () => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    const list = vi.fn(() => ({ state }));
    const slot = mount(list);
    expect(list).not.toHaveBeenCalled();
    await act(async () => {
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(await slot.findByRole("button", { name: /Saved tab/ })).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("loads when the connection becomes ready and refreshes after reconnecting", async () => {
    const list = vi.fn(() => ({ state }));
    const slot = mount(list, "connecting");
    expect(list).not.toHaveBeenCalled();
    await slot.behavior.setRealtimeConnectionState("connected");
    expect(await slot.findByRole("button", { name: /Saved tab/ })).toBeTruthy();
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    await slot.behavior.setRealtimeConnectionState("connected");
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it("cleans up failed-load retry timers when the homepage unmounts", async () => {
    vi.useFakeTimers();
    const list = vi.fn().mockRejectedValue(new Error("Plugin starting"));
    const slot = mount(list);
    await act(async () => { await Promise.resolve(); });
    expect(list).toHaveBeenCalledTimes(1);
    slot.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(list).toHaveBeenCalledTimes(1);
  });
});
