// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import translations from "./plugin-translations.json";
import { LANGUAGE_OPTIONS } from "./languages";
import { resolvePluginLocale, translate, usePluginLocale } from "./plugin-locale";

const previousLanguage = document.documentElement.lang;
afterEach(() => {
  cleanup();
  document.documentElement.lang = previousLanguage;
});

describe("plugin locale", () => {
  it("uses the BB document language, then browser language, with a manual override", () => {
    expect(resolvePluginLocale("Auto", "ru-RU", "en-US")).toBe("ru");
    expect(resolvePluginLocale("Auto", "en-US", "ru-RU")).toBe("en");
    expect(resolvePluginLocale("Auto", "", "ru-RU")).toBe("ru");
    expect(resolvePluginLocale("Русский", "en-US", "en-US")).toBe("ru");
    expect(resolvePluginLocale("English", "ru-RU", "ru-RU")).toBe("en");
    expect(resolvePluginLocale("Auto", "fr-FR", "es-MX")).toBe("fr");
    expect(resolvePluginLocale("Auto", "", "zh-CN")).toBe("zh-CN");
    expect(resolvePluginLocale("Auto", "unknown", "pt-PT")).toBe("pt-BR");
    expect(resolvePluginLocale("Auto", "unknown", "unknown")).toBe("en");
    expect(resolvePluginLocale("العربية", "en", "en")).toBe("ar");
  });

  it("has complete translations and preserved placeholders for every language option", () => {
    const keys = Object.keys(translations.ru);
    expect(LANGUAGE_OPTIONS).toHaveLength(16); // auto + 15 languages
    for (const [locale, pack] of Object.entries(translations)) {
      expect(Object.keys(pack).sort(), locale).toEqual([...keys].sort());
      for (const key of keys) {
        const vars = (key.match(/\{[a-z]+\}/g) ?? []).sort();
        expect((pack as Record<string, string>)[key]?.match(/\{[a-z]+\}/g)?.sort() ?? [], `${locale}: ${key}`).toEqual(vars);
      }
    }
    for (const option of LANGUAGE_OPTIONS.filter((option) => option !== "Auto")) {
      const locale = resolvePluginLocale(option, "", "");
      if (locale !== "en") expect(translations).toHaveProperty(locale);
    }
  });

  it("reacts to the app language changing without a reload", async () => {
    document.documentElement.lang = "en";
    const { result } = renderHook(() => usePluginLocale("Auto"));
    expect(result.current).toBe("en");
    act(() => { document.documentElement.lang = "ru"; });
    await waitFor(() => expect(result.current).toBe("ru"));
  });

  it("translates labels and variables but leaves English source text unchanged", () => {
    expect(translate("ru", "Close tab “{title}”", { title: "Чат" })).toBe("Закрыть вкладку «Чат»");
    expect(translate("en", "Close tab “{title}”", { title: "Chat" })).toBe("Close tab “Chat”");
    expect(translate("ru", "Show {count} more projects", { count: 15 })).toBe("Показать ещё 15 проектов");
  });
});
