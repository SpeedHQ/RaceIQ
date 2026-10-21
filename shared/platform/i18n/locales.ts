export const LOCALES = [
  { code: "en", label: "English", aiName: "English" },
  { code: "de", label: "Deutsch", aiName: "German" },
  { code: "fr", label: "Français", aiName: "French" },
  { code: "it", label: "Italiano", aiName: "Italian" },
  { code: "es", label: "Español", aiName: "Spanish" },
  { code: "pt-BR", label: "Português (Brasil)", aiName: "Brazilian Portuguese" },
  { code: "pt-PT", label: "Português (Portugal)", aiName: "European Portuguese" },
  { code: "ja", label: "日本語", aiName: "Japanese" },
  { code: "ko", label: "한국어", aiName: "Korean" },
  { code: "uk", label: "Українська", aiName: "Ukrainian" },
  { code: "nl", label: "Nederlands", aiName: "Dutch" },
  { code: "pl", label: "Polski", aiName: "Polish" },
  { code: "fi", label: "Suomi", aiName: "Finnish" },
  { code: "ru", label: "Русский", aiName: "Russian" },
  { code: "zh-CN", label: "简体中文", aiName: "Simplified Chinese" },
  { code: "hi", label: "हिन्दी", aiName: "Hindi" },
] as const;

export type LocaleCode = (typeof LOCALES)[number]["code"];

export const LOCALE_CODES = LOCALES.map((l) => l.code);
