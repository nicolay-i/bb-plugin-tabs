// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { rpcContract } from "../server";
import {
  addTabCandidates,
  openTabCandidate,
  setTabFavorite,
  setTabPinned,
  type TabsState,
} from "../lib/tabs-model";

const app = await loadPluginApp(() => import("../app"));
const homepage = app.homepageSections.find((slot) => slot.id === "favorite-tabs");
if (!homepage) throw new Error("Favorite homepage section not registered");
afterEach(cleanup);

describe("Favorite chats homepage", () => {
  it.each([false, true])(
    "keeps removed cards in place until reopening the homepage (favorites: %s)",
    async (favorites) => {
      const entries = ["A", "B", "C"].map((title) => ({
        threadId: `thr_${title}`,
        projectId: "proj_api",
        title,
        pinned: true,
        openedAt: 1,
      }));
      let state: TabsState = { version: 1, entries, ...(favorites ? { favorites: entries } : {}) };
      const section = app.homepageSections.find(
        (slot) => slot.id === (favorites ? "favorite-tabs" : "pinned-tabs"),
      )!;
      const mount = () =>
        renderSlot<
          { projectId: string | null },
          Pick<
            typeof rpcContract,
            | "tabs_list"
            | "tabs_set_pinned"
            | "tabs_set_favorite"
            | "tabs_sync_activity"
            | "tabs_open"
          >
        >(
          section,
          { projectId: null },
          {
            context: { projectId: null, threadId: null },
            rpc: {
              tabs_list: () => ({ state }),
              tabs_set_pinned: ({ threadId, pinned }) => ({
                state: (state = setTabPinned(state, threadId, pinned)),
              }),
              tabs_set_favorite: ({ threadId, favorite, candidate }) => ({
                state: (state = setTabFavorite(state, threadId, favorite, candidate)),
              }),
              tabs_open: (candidate) => ({
                state: (state = openTabCandidate(state, candidate, 2)),
              }),
              tabs_sync_activity: ({ threads }) => ({
                state: (state = addTabCandidates(state, threads, 2)),
              }),
            },
          },
        );
      const slot = mount();
      const action = favorites ? "Remove from favorites" : "Unpin";
      for (const title of ["C", "A"]) {
        fireEvent.click(await slot.findByRole("button", { name: `${action}: ${title}` }));
        await waitFor(() =>
          expect(
            (favorites
              ? (state.favorites ?? [])
              : state.entries.filter((entry) => entry.pinned)
            ).some((entry) => entry.threadId === `thr_${title}`),
          ).toBe(false),
        );
        await waitFor(() =>
          expect(
            (
              slot.getByRole("button", {
                name: `${favorites ? "Add to favorites" : "Pin"}: ${title}`,
              }) as HTMLButtonElement
            ).disabled,
          ).toBe(false),
        );
      }
      await slot.emitRealtime("tabs-changed", state);
      expect(
        Array.from(slot.container.querySelectorAll(".bb-chat-tabs-homepage-pinned-title")).map(
          (node) => node.textContent,
        ),
      ).toEqual(["A", "B", "C"]);
      const restoreAction = favorites ? "Add to favorites" : "Pin";
      // Both previews are gone: restoration must work from the retained card alone.
      state = { ...state, entries: state.entries.filter((entry) => entry.pinned) };
      await slot.emitRealtime("tabs-changed", state);
      fireEvent.click(slot.getByRole("button", { name: `${restoreAction}: C` }));
      await waitFor(() =>
        expect(
          (favorites ? state.favorites : state.entries.filter((entry) => entry.pinned))?.some(
            (entry) => entry.threadId === "thr_C",
          ),
        ).toBe(true),
      );
      await waitFor(() =>
        expect(
          (slot.getByRole("button", { name: `${action}: C` }) as HTMLButtonElement).disabled,
        ).toBe(false),
      );
      expect(
        Array.from(slot.container.querySelectorAll(".bb-chat-tabs-homepage-pinned-title")).map(
          (node) => node.textContent,
        ),
      ).toEqual(["A", "B", "C"]);
      fireEvent.click(slot.getByRole("button", { name: `${action}: C` }));
      await waitFor(() =>
        expect(
          (slot.getByRole("button", { name: `${restoreAction}: C` }) as HTMLButtonElement).disabled,
        ).toBe(false),
      );
      fireEvent.click(slot.getByRole("button", { name: "C. Project: Project." }));
      await waitFor(() =>
        expect(slot.inspection.sidebarActionCalls).toContainEqual({
          method: "open",
          threadId: "thr_C",
          options: undefined,
        }),
      );
      slot.unmount();
      const reopened = mount();
      await reopened.findByRole("button", { name: "B. Project: Project." });
      expect(
        Array.from(reopened.container.querySelectorAll(".bb-chat-tabs-homepage-pinned-title")).map(
          (node) => node.textContent,
        ),
      ).toEqual(["B"]);
    },
  );

  it("leaves the card removable and shows an error when saving fails", async () => {
    const state: TabsState = {
      version: 1,
      entries: [],
      favorites: [
        {
          threadId: "thr_saved",
          projectId: "proj_api",
          title: "Saved",
          pinned: false,
          openedAt: 1,
        },
      ],
    };
    const slot = renderSlot<
      { projectId: string | null },
      Pick<typeof rpcContract, "tabs_list" | "tabs_set_favorite">
    >(
      homepage!,
      { projectId: null },
      {
        rpc: {
          tabs_list: () => ({ state }),
          tabs_set_favorite: () => {
            throw new Error("Save failed");
          },
        },
      },
    );
    fireEvent.click(await slot.findByRole("button", { name: "Remove from favorites: Saved" }));
    expect((await slot.findByRole("alert")).textContent).toBe("Could not update the chat.");
    await waitFor(() =>
      expect(
        (slot.getByRole("button", { name: "Remove from favorites: Saved" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    expect(slot.getByRole("button", { name: "Saved. Project: Project." })).toBeTruthy();
  });

  it("shows closed favorites independently of the pinned list setting and explicitly reopens them", async () => {
    let state: TabsState = {
      version: 1,
      entries: [],
      favorites: [
        {
          threadId: "thr_saved",
          projectId: "proj_api",
          title: "Saved chat",
          pinned: false,
          openedAt: 1,
        },
      ],
    };
    const slot = renderSlot<
      { projectId: string | null },
      Pick<typeof rpcContract, "tabs_list" | "tabs_sync_activity">
    >(
      homepage!,
      { projectId: null },
      {
        context: { projectId: null, threadId: null },
        settings: { language: "Русский", showPinnedTabsList: false },
        sidebarThreads: {
          threads: [],
          projects: [{ id: "proj_api", name: "API", isPersonal: false }],
        },
        rpc: {
          tabs_list: () => ({ state }),
          tabs_sync_activity: ({ threads }) => {
            state = addTabCandidates(state, threads, 2);
            return { state };
          },
        },
      },
    );
    expect(slot.getByRole("heading", { name: "Избранные чаты" })).toBeTruthy();
    const button = await slot.findByRole("button", { name: "Saved chat. Проект: API." });
    expect(state.entries).toEqual([]);
    fireEvent.click(button);
    await waitFor(() =>
      expect(slot.inspection.sidebarActionCalls).toContainEqual({
        method: "open",
        threadId: "thr_saved",
        options: undefined,
      }),
    );
    expect(slot.inspection.rpcCalls).toContainEqual({
      method: "tabs_sync_activity",
      input: {
        threads: [{ threadId: "thr_saved", projectId: "proj_api", title: "Saved chat" }],
        reopen: true,
      },
    });
    expect(state.entries[0]?.pinned).toBe(false);
    state = { ...state, favorites: [] };
    await slot.emitRealtime("tabs-changed", state);
    expect(slot.queryByRole("button", { name: /Saved chat/ })).toBeNull();
    expect(
      slot.getByText(
        "Избранных чатов пока нет. Откройте меню вкладки и выберите «Добавить в избранное».",
      ),
    ).toBeTruthy();
  });
});
