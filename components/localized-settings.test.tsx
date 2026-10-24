// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { rpcContract } from "../server";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { defaultTabAppearance, updateTabAppearance } from "../lib/tab-appearance";
import { LANGUAGE_OPTIONS } from "../lib/languages";
import { resolvePluginLocale, translate } from "../lib/plugin-locale";

const app = await loadPluginApp(() => import("../app"));
const slotDefinition = app.settingsSections.find((slot) => slot.id === "localized-settings");
if (!slotDefinition) throw new Error("Localized settings slot missing");
afterEach(() => {
  cleanup();
  document.documentElement.lang = "";
});

describe("Localized settings", () => {
  it("defaults the chat list to a tree and saves only the explicit toggle", async () => {
    const update = vi.fn((patch: { showChatListAsTree?: boolean }) => ({ values: patch }));
    const slot = renderSlot<{}, Pick<typeof rpcContract, "tabs_settings_update">>(
      slotDefinition!,
      {},
      {
        settings: { language: "English" },
        rpc: { tabs_settings_update: update },
      },
    );
    const toggle = slot.getByRole("switch", { name: "Show chats as a tree" }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    await waitFor(() => expect(update).toHaveBeenCalledWith({ showChatListAsTree: false }));
    expect(toggle.checked).toBe(false);
    expect(slot.inspection.rpcCalls).toHaveLength(1);
  });
  it.each(LANGUAGE_OPTIONS.filter((language) => language !== "Auto"))(
    "renders settings and the portalled project manager in %s with one ordinary language list",
    (language) => {
      const locale = resolvePluginLocale(language, "en", "en");
      const slot = renderSlot(
        slotDefinition!,
        {},
        {
          settings: { language },
          sidebarThreads: { projects: [], threads: [] },
        },
      );
      expect(slot.getByRole("heading", { name: translate(locale, "Configuration") })).toBeTruthy();
      const select = slot.getByRole("combobox", {
        name: translate(locale, "Language"),
      }) as HTMLSelectElement;
      expect([...select.options].map((option) => option.value)).toEqual(LANGUAGE_OPTIONS);
      expect(select.value).toBe(language);
      expect(select.querySelector("optgroup")).toBeNull();
      for (const option of select.options) {
        expect(option.className).toBe("");
        expect(option.getAttribute("style")).toBeNull();
        expect(option.disabled).toBe(false);
      }
      fireEvent.click(slot.getByRole("tab", { name: translate(locale, "Appearance") }));
      expect(slot.getByRole("button", { name: translate(locale, "Save palette") })).toBeTruthy();
      fireEvent.click(
        slot.getByRole("button", { name: translate(locale, "Project aliases and colors") + "…" }),
      );
      const dialog = slot.getByRole("dialog", {
        name: translate(locale, "Project aliases and colors"),
      });
      expect(dialog.lang).toBe(locale);
      expect(dialog.dir).toBe(locale === "ar" ? "rtl" : "ltr");
      expect(
        within(dialog).getByRole("combobox", { name: translate(locale, "Choose a project") }),
      ).toBeTruthy();
      expect(within(dialog).getByRole("button", { name: translate(locale, "Done") })).toBeTruthy();
      expect(slot.inspection.rpcCalls).toEqual([]);
    },
  );

  it("searches all projects with recent non-archived activity first and keeps drafts across tabs", () => {
    const thread: PluginSidebarThread = {
      id: "t",
      projectId: "z",
      title: "Recent",
      titleFallback: null,
      parentThreadId: null,
      sectionId: null,
      originKind: null,
      originPluginId: null,
      providerId: "pi",
      hasPendingInteraction: false,
      activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
      indicator: "none",
      indicatorLabel: null,
      isUnread: false,
      isPinned: false,
      isArchived: false,
      environment: null,
      host: null,
      createdAt: 1,
      updatedAt: 20,
      lastReadAt: null,
      latestAttentionAt: 0,
    };
    const appearance = updateTabAppearance(defaultTabAppearance(), {
      kind: "project",
      projectId: "z",
      alias: "BACK",
    });
    const update = vi.fn(() => ({ values: {} }));
    const slot = renderSlot<{}, Pick<typeof rpcContract, "tabs_appearance_update">>(
      slotDefinition!,
      {},
      {
        settings: { language: "Русский", tabAppearance: JSON.stringify(appearance) },
        sidebarThreads: {
          projects: [
            { id: "a", name: "Alpha dormant", isPersonal: false },
            { id: "b", name: "Beta old", isPersonal: false },
            { id: "p", name: "Personal", isPersonal: true },
            { id: "z", name: "Zulu recent", isPersonal: false },
          ],
          threads: [
            thread,
            { ...thread, id: "old", projectId: "b", updatedAt: 0 },
            { ...thread, id: "personal", projectId: "p", updatedAt: 3 },
            { ...thread, id: "archived", projectId: "a", updatedAt: 1000, isArchived: true },
          ],
        },
        rpc: { tabs_appearance_update: update },
      },
    );
    expect(slot.queryByRole("combobox", { name: "Выберите проект" })).toBeNull();
    const general = slot.getByRole("tab", { name: "Основные" });
    general.focus();
    fireEvent.keyDown(general, { key: "ArrowRight" });
    const appearanceTab = slot.getByRole("tab", { name: "Оформление" });
    expect(document.activeElement).toBe(appearanceTab);
    expect(appearanceTab.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(slot.getByRole("button", { name: "Алиасы и цвета проектов…" }));
    const search = slot.getByRole("combobox", { name: "Выберите проект" });
    fireEvent.focus(search);
    const names = () =>
      within(slot.getByRole("listbox"))
        .queryAllByRole("option")
        .map((option) => option.textContent);
    expect(names()).toEqual(["[BACK] Zulu recent", "Personal", "Beta old", "Alpha dormant"]);
    fireEvent.change(search, { target: { value: "back" } });
    expect(names()).toEqual(["[BACK] Zulu recent"]);
    fireEvent.change(search, { target: { value: "" } });
    fireEvent.click(slot.getByRole("option", { name: "Beta old" }));
    fireEvent.change(slot.getByRole("textbox", { name: "Алиас проекта" }), {
      target: { value: "DRAFT" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Готово" }));
    fireEvent.change(slot.getByLabelText("Цвет 1"), { target: { value: "#abcdef" } });
    fireEvent.click(slot.getByRole("button", { name: "Алиасы и цвета проектов…" }));
    const reopenedSearch = slot.getByRole("combobox", { name: "Выберите проект" });
    fireEvent.change(reopenedSearch, { target: { value: "zzzzzzzz" } });
    expect(slot.getByRole("status").textContent).toBe("Проекты не найдены");
    expect(slot.getByRole("form", { name: "Beta old" })).toBeTruthy();
    fireEvent.change(reopenedSearch, { target: { value: "Zulu" } });
    fireEvent.click(slot.getByRole("button", { name: "Готово" }));
    fireEvent.keyDown(appearanceTab, { key: "Home" });
    expect(document.activeElement).toBe(general);
    expect(slot.queryByRole("textbox", { name: "Алиас проекта" })).toBeNull();
    fireEvent.keyDown(general, { key: "End" });
    expect(slot.getByLabelText("Цвет 1")).toHaveProperty("value", "#abcdef");
    fireEvent.click(slot.getByRole("button", { name: "Алиасы и цвета проектов…" }));
    const restoredSearch = slot.getByRole("combobox", { name: "Выберите проект" });
    expect(restoredSearch).toHaveProperty("value", "Zulu");
    expect(slot.getByRole("textbox", { name: "Алиас проекта" })).toHaveProperty("value", "DRAFT");
    fireEvent.change(restoredSearch, { target: { value: "Beta" } });
    fireEvent.keyDown(restoredSearch, { key: "Enter" });
    expect(slot.getByRole("textbox", { name: "Алиас проекта" })).toHaveProperty("value", "DRAFT");
    expect(update).not.toHaveBeenCalled();
  });
  it("selects project identities with arrows/Enter, ignores IME and closes with Escape or blur", async () => {
    const appearance = updateTabAppearance(defaultTabAppearance(), {
      kind: "project",
      projectId: "second",
      alias: "ALT",
    });
    const update = vi.fn((patch: Parameters<typeof updateTabAppearance>[1]) => ({
      values: {
        language: "Русский",
        tabAppearance: JSON.stringify(updateTabAppearance(appearance, patch)),
      },
    }));
    const slot = renderSlot<{}, Pick<typeof rpcContract, "tabs_appearance_update">>(
      slotDefinition!,
      {},
      {
        settings: { language: "Русский", tabAppearance: JSON.stringify(appearance) },
        sidebarThreads: {
          projects: [
            { id: "first", name: "Same", isPersonal: false },
            { id: "second", name: "Same", isPersonal: false },
          ],
          threads: [],
        },
        rpc: { tabs_appearance_update: update },
      },
    );
    fireEvent.click(slot.getByRole("tab", { name: "Оформление" }));
    fireEvent.click(slot.getByRole("button", { name: "Алиасы и цвета проектов…" }));
    const input = slot.getByRole("combobox", { name: "Выберите проект" });
    fireEvent.change(input, { target: { value: "Same" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(slot.queryByRole("form")).toBeNull();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(document.getElementById(input.getAttribute("aria-activedescendant")!)?.textContent).toBe(
      "Same",
    );
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(document.getElementById(input.getAttribute("aria-activedescendant")!)?.textContent).toBe(
      "[ALT] Same",
    );
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(document.getElementById(input.getAttribute("aria-activedescendant")!)?.textContent).toBe(
      "[ALT] Same",
    );
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveProperty("value", "Same");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(input);
    expect(slot.queryByRole("listbox")).toBeNull();
    fireEvent.change(input, { target: { value: "zzzzzzzz" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(slot.getByRole("textbox", { name: "Алиас проекта" })).toHaveProperty("value", "ALT");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.hasAttribute("aria-activedescendant")).toBe(false);
    fireEvent.click(input);
    expect(input.getAttribute("aria-expanded")).toBe("true");
    fireEvent.blur(input, { relatedTarget: slot.getByRole("textbox", { name: "Алиас проекта" }) });
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(update).not.toHaveBeenCalled();
    fireEvent.change(slot.getByRole("textbox", { name: "Алиас проекта" }), {
      target: { value: "NEW" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Сохранить проект" }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({ kind: "project", projectId: "second", alias: "NEW" }),
    );
    expect(slot.inspection.navigateCalls).toEqual([]);
  });

  it("adds an empty project, edits it and confirms removal without touching tab overrides", async () => {
    let appearance = updateTabAppearance(defaultTabAppearance(), {
      kind: "tab",
      threadId: "t",
      color: 1,
    });
    let fail = false;
    const update = vi.fn((patch: Parameters<typeof updateTabAppearance>[1]) => {
      if (fail) throw new Error("failed");
      appearance = updateTabAppearance(appearance, patch);
      return { values: { language: "Русский", tabAppearance: JSON.stringify(appearance) } };
    });
    const slot = renderSlot<{}, Pick<typeof rpcContract, "tabs_appearance_update">>(
      slotDefinition!,
      {},
      {
        settings: { language: "Русский", tabAppearance: JSON.stringify(appearance) },
        sidebarThreads: { projects: [{ id: "p", name: "API", isPersonal: false }], threads: [] },
        rpc: { tabs_appearance_update: update },
      },
    );
    fireEvent.click(slot.getByRole("tab", { name: "Оформление" }));
    const trigger = slot.getByRole("button", { name: "Алиасы и цвета проектов…" });
    fireEvent.click(trigger);
    expect(slot.getByRole("dialog", { name: "Алиасы и цвета проектов" })).toBeTruthy();
    const input = slot.getByRole("combobox", { name: "Выберите проект" });
    fireEvent.focus(input);
    fireEvent.click(slot.getByRole("option", { name: "API" }));
    fireEvent.click(slot.getByRole("button", { name: "Добавить" }));
    await waitFor(() => expect(appearance.projects.p).toEqual({ alias: "", color: null }));
    await waitFor(() => expect(slot.container.querySelector("fieldset")?.disabled).toBe(false));
    fireEvent.click(slot.getByRole("button", { name: "Редактировать: API" }));
    fireEvent.change(slot.getByRole("textbox", { name: "Алиас проекта" }), {
      target: { value: "BACK" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Сохранить проект" }));
    await waitFor(() => expect(appearance.projects.p?.alias).toBe("BACK"));
    await waitFor(() => expect(slot.container.querySelector("fieldset")?.disabled).toBe(false));
    const count = update.mock.calls.length;
    fireEvent.click(slot.getByRole("button", { name: "Убрать из списка: API" }));
    expect(update).toHaveBeenCalledTimes(count);
    fireEvent.click(slot.getByRole("button", { name: "Отмена" }));
    expect(appearance.projects.p?.alias).toBe("BACK");
    fireEvent.click(slot.getByRole("button", { name: "Убрать из списка: API" }));
    fail = true;
    fireEvent.click(
      within(slot.getByRole("group", { name: "Убрать из списка: API" })).getByRole("button", {
        name: "Убрать из списка",
      }),
    );
    expect(await slot.findByRole("alert")).toHaveProperty(
      "textContent",
      "Не удалось сохранить настройки.",
    );
    expect(appearance.projects.p?.alias).toBe("BACK");
    await waitFor(() => expect(slot.container.querySelector("fieldset")?.disabled).toBe(false));
    fail = false;
    fireEvent.click(
      within(slot.getByRole("group", { name: "Убрать из списка: API" })).getByRole("button", {
        name: "Убрать из списка",
      }),
    );
    await waitFor(() => expect(appearance.projects).toEqual({}));
    expect(appearance.tabs).toEqual({ t: 1 });
    await waitFor(() => expect(slot.container.querySelector("fieldset")?.disabled).toBe(false));
    fireEvent.click(slot.getByRole("button", { name: "Готово" }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(slot.inspection.navigateCalls).toEqual([]);
  });

  it("locks portalled controls and dismissal while a project save is pending", async () => {
    let release: (result: { values: Record<string, string> }) => void = () => {
      throw new Error("no pending save");
    };
    const slot = renderSlot<{}, Pick<typeof rpcContract, "tabs_appearance_update">>(
      slotDefinition!,
      {},
      {
        settings: { language: "Русский" },
        sidebarThreads: { projects: [{ id: "p", name: "API", isPersonal: false }], threads: [] },
        rpc: {
          tabs_appearance_update: () =>
            new Promise((resolve) => {
              release = resolve;
            }),
        },
      },
    );
    fireEvent.click(slot.getByRole("tab", { name: "Оформление" }));
    fireEvent.click(slot.getByRole("button", { name: "Алиасы и цвета проектов…" }));
    fireEvent.focus(slot.getByRole("combobox", { name: "Выберите проект" }));
    fireEvent.click(slot.getByRole("option", { name: "API" }));
    fireEvent.click(slot.getByRole("button", { name: "Добавить" }));
    const dialog = slot.getByRole("dialog");
    expect(dialog.querySelector("fieldset")?.disabled).toBe(true);
    expect(slot.getByRole("button", { name: "Готово" })).toHaveProperty("disabled", true);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(slot.getByRole("dialog")).toBe(dialog);
    release({
      values: {
        language: "Русский",
        tabAppearance: JSON.stringify(
          updateTabAppearance(defaultTabAppearance(), { kind: "project-add", projectId: "p" }),
        ),
      },
    });
    await waitFor(() => expect(dialog.querySelector("fieldset")?.disabled).toBe(false));
  });

  it("links keyboard-accessible tabs to their panels in Arabic RTL without saving", () => {
    const slot = renderSlot(slotDefinition!, {}, { settings: { language: "العربية" } });
    const general = slot.getByRole("tab", { name: "عام" });
    const appearance = slot.getByRole("tab", { name: "المظهر" });
    expect(general.closest("section")?.dir).toBe("rtl");
    general.focus();
    fireEvent.keyDown(general, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(appearance);
    expect(appearance.getAttribute("aria-selected")).toBe("true");
    expect(
      document
        .getElementById(appearance.getAttribute("aria-controls")!)
        ?.getAttribute("aria-labelledby"),
    ).toBe(appearance.id);
    expect(slot.getByRole("tabpanel", { name: "المظهر" })).toBeTruthy();
    expect(slot.inspection.rpcCalls).toEqual([]);
  });

  it("edits palette and project fields through bounded patches and retains a failed draft", async () => {
    let appearance = defaultTabAppearance();
    let fail = false;
    const update = vi.fn((patch: Parameters<typeof updateTabAppearance>[1]) => {
      if (fail) throw new Error("save failed");
      appearance = updateTabAppearance(appearance, patch);
      return { values: { language: "Русский", tabAppearance: JSON.stringify(appearance) } };
    });
    const slot = renderSlot<{}, Pick<typeof rpcContract, "tabs_appearance_update">>(
      slotDefinition!,
      {},
      {
        settings: { language: "Русский" },
        sidebarThreads: { projects: [{ id: "p", name: "API", isPersonal: false }], threads: [] },
        rpc: { tabs_appearance_update: update },
      },
    );
    fireEvent.click(slot.getByRole("tab", { name: "Оформление" }));
    fireEvent.click(slot.getByRole("button", { name: "Алиасы и цвета проектов…" }));
    fireEvent.focus(slot.getByRole("combobox", { name: "Выберите проект" }));
    fireEvent.click(slot.getByRole("option", { name: "API" }));
    fireEvent.change(slot.getByRole("textbox", { name: "Алиас проекта" }), {
      target: { value: "BACK" },
    });
    fireEvent.change(slot.getByRole("combobox", { name: "Цвет проекта" }), {
      target: { value: "2" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Добавить" }));
    await waitFor(() => expect(appearance.projects.p).toEqual({ alias: "BACK", color: 2 }));
    fireEvent.click(slot.getByRole("button", { name: "Готово" }));
    await waitFor(() => expect(slot.container.querySelector("fieldset")?.disabled).toBe(false));
    fireEvent.change(slot.getByLabelText("Цвет 1"), { target: { value: "#123456" } });
    fireEvent.click(slot.getByRole("button", { name: "Сохранить палитру" }));
    await waitFor(() =>
      expect(update).toHaveBeenLastCalledWith({
        kind: "palette",
        colors: [{ index: 0, color: "#123456" }],
      }),
    );
    await waitFor(() => expect(slot.container.querySelector("fieldset")?.disabled).toBe(false));
    expect(appearance.projects.p?.alias).toBe("BACK");
    fireEvent.click(slot.getByRole("button", { name: "Алиасы и цвета проектов…" }));
    fail = true;
    fireEvent.change(slot.getByRole("textbox", { name: "Алиас проекта" }), {
      target: { value: "DRAFT" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Сохранить проект" }));
    expect(await slot.findByRole("alert")).toHaveProperty(
      "textContent",
      "Не удалось сохранить настройки.",
    );
    expect(slot.getByRole("textbox", { name: "Алиас проекта" })).toHaveProperty("value", "DRAFT");
    expect(appearance.projects.p?.alias).toBe("BACK");
  });

  it("follows live BB language changes in Auto mode without saving settings", async () => {
    document.documentElement.lang = "ru";
    const update = vi.fn(() => ({ values: { language: "Auto" } }));
    const slot = renderSlot<{}, Pick<typeof rpcContract, "tabs_settings_update">>(
      slotDefinition!,
      {},
      {
        settings: { language: "Auto" },
        rpc: { tabs_settings_update: update },
      },
    );
    expect(slot.getByRole("heading", { name: "Настройки" })).toBeTruthy();
    document.documentElement.lang = "en";
    expect(await slot.findByRole("heading", { name: "Configuration" })).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
  });

  it("renders Russian labels and translates immediately when the language changes", async () => {
    let values: Record<string, string | boolean> = {
      language: "Русский",
      showTabsOnDesktop: true,
      searchArchivedChats: false,
    };
    const update = vi.fn((patch: Record<string, string | boolean>) => {
      values = { ...values, ...patch };
      return { values };
    });
    const slot = renderSlot<{}, Pick<typeof rpcContract, "tabs_settings_update">>(
      slotDefinition!,
      {},
      { settings: values, rpc: { tabs_settings_update: update } },
    );
    expect(slot.getByRole("heading", { name: "Настройки" })).toBeTruthy();
    expect(slot.getByRole("switch", { name: "Искать архивированные чаты" })).toBeTruthy();
    expect(slot.getByRole("combobox", { name: "Язык" })).toBeTruthy();
    fireEvent.change(slot.getByRole("combobox", { name: "Язык" }), {
      target: { value: "English" },
    });
    await waitFor(() => expect(update).toHaveBeenCalledWith({ language: "English" }));
    expect(await slot.findByRole("heading", { name: "Configuration" })).toBeTruthy();
    expect(slot.getByRole("switch", { name: "Include archived chats in search" })).toBeTruthy();
    fireEvent.click(slot.getByRole("switch", { name: "Include archived chats in search" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ searchArchivedChats: true }));
    expect(
      (slot.getByRole("switch", { name: "Include archived chats in search" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    fireEvent.change(slot.getByRole("combobox", { name: "Tab list button position" }), {
      target: { value: "Right" },
    });
    await waitFor(() => expect(update).toHaveBeenCalledWith({ tabListButtonPosition: "Right" }));
  });

  it("enables workspaces by default and saves disabling/enabling through typed patches", async () => {
    let values: Record<string, string | boolean> = { language: "Русский" };
    const update = vi.fn((patch: Record<string, string | boolean>) => {
      values = { ...values, ...patch };
      return { values };
    });
    const slot = renderSlot<{}, Pick<typeof rpcContract, "tabs_settings_update">>(
      slotDefinition!,
      {},
      { settings: values, rpc: { tabs_settings_update: update } },
    );
    const toggle = slot.getByRole("switch", {
      name: "Включить рабочие пространства",
    }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    await waitFor(() => expect(update).toHaveBeenCalledWith({ enableWorkspaces: false }));
    await waitFor(() => expect(toggle.disabled).toBe(false));
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() => expect(update).toHaveBeenCalledWith({ enableWorkspaces: true }));
    expect(toggle.checked).toBe(true);
  });

  it("rolls back optimistic language changes and reports a translated error on save failure", async () => {
    const slot = renderSlot<{}, Pick<typeof rpcContract, "tabs_settings_update">>(
      slotDefinition!,
      {},
      {
        settings: { language: "Русский" },
        rpc: {
          tabs_settings_update: () => {
            throw new Error("External error text must not be rendered");
          },
        },
      },
    );
    fireEvent.change(slot.getByRole("combobox", { name: "Язык" }), {
      target: { value: "English" },
    });
    expect(await slot.findByRole("alert")).toHaveProperty(
      "textContent",
      "Не удалось сохранить настройки.",
    );
    expect(slot.getByRole("combobox", { name: "Язык" })).toBeTruthy();
    expect(slot.queryByText("External error text must not be rendered")).toBeNull();
  });
});
