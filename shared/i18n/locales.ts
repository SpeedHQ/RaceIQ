export const LOCALES = [
  { code: "en", label: "English", aiName: "English" },
  { code: "de", label: "Deutsch", aiName: "German" },
] as const;

export type LocaleCode = (typeof LOCALES)[number]["code"];

export const LOCALE_CODES = LOCALES.map((l) => l.code);
