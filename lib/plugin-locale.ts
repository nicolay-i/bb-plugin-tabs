import { useEffect, useState } from "react";
import translations from "./plugin-translations.json";
import type { LanguageSetting } from "./languages";
export type { LanguageSetting } from "./languages";

export type PluginLocale = "en" | keyof typeof translations;
export type TranslationKey = keyof typeof translations.ru;

const manualLocales: Record<Exclude<LanguageSetting, "Auto" | undefined>, PluginLocale> = {
  English: "en",
  Русский: "ru",
  Español: "es",
  "Português (Brasil)": "pt-BR",
  Français: "fr",
  Deutsch: "de",
  "中文（简体）": "zh-CN",
  हिन्दी: "hi",
  العربية: "ar",
  日本語: "ja",
  "Bahasa Indonesia": "id",
  Türkçe: "tr",
  한국어: "ko",
  "Tiếng Việt": "vi",
  Italiano: "it",
};

function localeFromLanguage(language: string): PluginLocale | null {
  const primary = language.trim().split(/[-_]/)[0]?.toLowerCase();
  if (primary === "zh") return "zh-CN";
  if (primary === "pt") return "pt-BR";
  if (primary && primary in translations) return primary as PluginLocale;
  if (primary === "en") return "en";
  return null;
}

/** The SDK has no locale hook: use the BB page, then browser, then English. */
export function resolvePluginLocale(
  setting: LanguageSetting,
  documentLanguage: string | null,
  browserLanguage: string,
): PluginLocale {
  if (setting && setting !== "Auto") return manualLocales[setting];
  return localeFromLanguage(documentLanguage ?? "") ?? localeFromLanguage(browserLanguage) ?? "en";
}

export function usePluginLocale(setting?: LanguageSetting): PluginLocale {
  const detect = () => resolvePluginLocale(
    setting,
    typeof document === "undefined" ? null : document.documentElement.lang,
    typeof navigator === "undefined" ? "en" : navigator.language,
  );
  const [locale, setLocale] = useState(detect);
  useEffect(() => {
    const update = () => setLocale(detect());
    update();
    if (typeof MutationObserver === "undefined" || typeof document === "undefined") return;
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
    return () => observer.disconnect();
  }, [setting]);
  return setting && setting !== "Auto" ? manualLocales[setting] : locale;
}

/** English source text is the key and fallback; interpolation never changes user-supplied titles. */
export function translate(
  locale: PluginLocale,
  key: TranslationKey,
  variables: Record<string, string | number> = {},
): string {
  const template: string = locale === "en" ? key : translations[locale][key] ?? key;
  return template.replace(/\{([a-z]+)\}/g, (match, name: string) =>
    name in variables ? String(variables[name]) : match,
  );
}
