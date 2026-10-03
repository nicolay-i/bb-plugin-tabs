// Settings selects persist their displayed value, not a separate ID.
export const LANGUAGE_OPTIONS = [
  "Auto", "English", "Русский", "Español", "Português (Brasil)", "Français",
  "Deutsch", "中文（简体）", "हिन्दी", "العربية", "日本語",
  "Bahasa Indonesia", "Türkçe", "한국어", "Tiếng Việt", "Italiano",
] as const;
export type LanguageSetting = typeof LANGUAGE_OPTIONS[number] | undefined;
