export const LOCALES = [
  { code: "en", label: "English", aiName: "English" },
  { code: "de", label: "Deutsch", aiName: "German" },
  { code: "fr", label: "Français", aiName: "French" },
  { code: "it", label: "Italiano", aiName: "Italian" },
  { code: "es", label: "Español", aiName: "Spanish" },
  { code: "pt-BR", label: "Português (Brasil)", aiName: "Brazilian Portuguese" },
  { code: "ja", label: "日本語", aiName: "Japanese" },
  { code: "uk", label: "Українська", aiName: "Ukrainian" },
  { code: "nl", label: "Nederlands", aiName: "Dutch" },
  { code: "pl", label: "Polski", aiName: "Polish" },
  { code: "fi", label: "Suomi", aiName: "Finnish" },
  { code: "ru", label: "Русский", aiName: "Russian" },
] as const;

export type LocaleCode = (typeof LOCALES)[number]["code"];

export const LOCALE_CODES = LOCALES.map((l) => l.code);
