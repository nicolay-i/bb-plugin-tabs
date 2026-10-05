// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { rpcContract } from "../server";

const app = await loadPluginApp(() => import("../app"));
const slotDefinition = app.settingsSections.find((slot) => slot.id === "localized-settings");
if (!slotDefinition) throw new Error("Localized settings slot missing");
afterEach(() => { cleanup(); document.documentElement.lang = ""; });

describe("Localized settings", () => {
  it("scopes duplicate-form suppression to Chat Tabs and restores the native fallback", async () => {
    const css = await readFile(`${process.cwd()}/tabs.css`, "utf8");
    const selector = css.match(/(\[data-testid="plugin-detail-tabs"\]:has\(\.bb-chat-tabs-settings\)[^{]+)\{\s*display: none;/)?.[1].trim();
    expect(selector).toBeTruthy();
    const root = document.createElement("div");
    root.innerHTML = '<div data-testid="plugin-detail-tabs"><div class="overflow-hidden" id="native-form"></div><div><section class="bb-chat-tabs-settings"></section></div></div><div data-testid="plugin-detail-other"><div id="other-form"></div></div>';
    expect(Array.from(root.querySelectorAll(selector!), (node) => node.id)).toEqual(["native-form"]);
    root.querySelector(".bb-chat-tabs-settings")!.remove();
    expect(root.querySelectorAll(selector!)).toHaveLength(0);
  });

  it("follows live BB language changes in Auto mode without saving settings", async () => {
    document.documentElement.lang = "ru";
    const update = vi.fn(() => ({ values: { language: "Auto" } }));
    const slot = renderSlot<{}, Pick<typeof rpcContract, "tabs_settings_update">>(slotDefinition!, {}, {
      settings: { language: "Auto" }, rpc: { tabs_settings_update: update },
    });
    expect(slot.getByRole("heading", { name: "Настройки" })).toBeTruthy();
    document.documentElement.lang = "en";
    expect(await slot.findByRole("heading", { name: "Configuration" })).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
  });

  it("renders Russian labels and translates immediately when the language changes", async () => {
    let values: Record<string, string | boolean> = { language: "Русский", showTabsOnDesktop: true, searchArchivedChats: false };
    const update = vi.fn((patch: Record<string, string | boolean>) => {
      values = { ...values, ...patch };
      return { values };
    });
    const slot = renderSlot<{}, Pick<typeof rpcContract, "tabs_settings_update">>(slotDefinition!, {}, { settings: values, rpc: { tabs_settings_update: update } });
    expect(slot.getByRole("heading", { name: "Настройки" })).toBeTruthy();
    expect(slot.getByRole("switch", { name: "Искать архивированные чаты" })).toBeTruthy();
    expect(slot.getByRole("combobox", { name: "Язык" })).toBeTruthy();
    fireEvent.change(slot.getByRole("combobox", { name: "Язык" }), { target: { value: "English" } });
    await waitFor(() => expect(update).toHaveBeenCalledWith({ language: "English" }));
    expect(await slot.findByRole("heading", { name: "Configuration" })).toBeTruthy();
    expect(slot.getByRole("switch", { name: "Include archived chats in search" })).toBeTruthy();
    fireEvent.click(slot.getByRole("switch", { name: "Include archived chats in search" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ searchArchivedChats: true }));
    expect((slot.getByRole("switch", { name: "Include archived chats in search" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.change(slot.getByRole("combobox", { name: "Tab list button position" }), { target: { value: "Right" } });
    await waitFor(() => expect(update).toHaveBeenCalledWith({ tabListButtonPosition: "Right" }));
  });

  it("rolls back optimistic language changes and reports a translated error on save failure", async () => {
    const slot = renderSlot<{}, Pick<typeof rpcContract, "tabs_settings_update">>(slotDefinition!, {}, {
      settings: { language: "Русский" },
      rpc: { tabs_settings_update: () => { throw new Error("External error text must not be rendered"); } },
    });
    fireEvent.change(slot.getByRole("combobox", { name: "Язык" }), { target: { value: "English" } });
    expect(await slot.findByRole("alert")).toHaveProperty("textContent", "Не удалось сохранить настройки.");
    expect(slot.getByRole("combobox", { name: "Язык" })).toBeTruthy();
    expect(slot.queryByText("External error text must not be rendered")).toBeNull();
  });
});
