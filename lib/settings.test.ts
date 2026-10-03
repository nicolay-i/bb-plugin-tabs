import { describe, expect, it } from "vitest";
import translations from "./plugin-translations.json";
import { SETTINGS } from "./settings";

describe("Settings translations", () => {
  it("describes the enabled state and identifies where each feature appears", () => {
    for (const key of ["showPinnedTabsList", "showTabsOnDesktop", "showTabsOnMobile", "showTabListPinned", "showTabListHistory"] as const) {
      expect(SETTINGS[key].description).toMatch(/^Shows /);
      expect(translations.ru[SETTINGS[key].label]).toMatch(/^Показывать /);
      expect(translations.ru[SETTINGS[key].description]).toMatch(/^Показывает /);
    }
    expect(translations.ru[SETTINGS.language.description]).toContain('В режиме «Авто»');
    expect(translations.ru[SETTINGS.showTabListPinned.description]).toContain('При выключении чаты остаются закреплёнными.');
    expect(translations.ru[SETTINGS.showTabListHistory.description]).toContain('история посещений продолжает записываться.');
    expect(translations.ru[SETTINGS.tabListButtonPosition.description]).toContain('слева или справа от полосы вкладок чатов');
  });

  it("provides every label, description and localized option for all non-English languages", () => {
    const keys = [...Object.values(SETTINGS).flatMap((field) => [field.label, field.description]), "Configuration", "Auto", "Left", "Right", "Could not save settings."];
    expect(Object.keys(translations)).toHaveLength(14);
    for (const [locale, dictionary] of Object.entries(translations)) {
      for (const key of keys) {
        expect((dictionary as Record<string, string>)[key], `${locale}: ${key}`).toBeTruthy();
      }
    }
  });
});
