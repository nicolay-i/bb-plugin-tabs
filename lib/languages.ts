// Settings persist these autonyms. Auto is first; all languages share stable English collation.
export const LANGUAGE_OPTIONS = [
  "Auto",
  "Bahasa Indonesia",
  "Deutsch",
  "English",
  "Español",
  "Français",
  "Italiano",
  "Português (Brasil)",
  "Tiếng Việt",
  "Türkçe",
  "Русский",
  "العربية",
  "हिन्दी",
  "한국어",
  "中文（简体）",
  "日本語",
] as const;
export type LanguageSetting = (typeof LANGUAGE_OPTIONS)[number] | undefined;
