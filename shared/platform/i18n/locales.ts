export const LOCALES = [
  { code: "en", label: "English", aiName: "English" },
  { code: "de", label: "Deutsch", aiName: "German" },
  { code: "fr", label: "Français", aiName: "French" },
  { code: "it", label: "Italiano", aiName: "Italian" },
] as const;

export type LocaleCode = (typeof LOCALES)[number]["code"];

export const LOCALE_CODES = LOCALES.map((l) => l.code);
