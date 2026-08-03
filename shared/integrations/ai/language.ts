import { LOCALES } from "@shared/platform/i18n/locales";

/** Human-readable language name for the AI "respond in <language>" instruction. */
export const aiLanguageName = (code: string): string =>
  LOCALES.find((locale) => locale.code === code)?.aiName ?? "English";

/**
 * System-prompt line steering AI output into the user's language.
 * English returns an empty string to preserve existing prompt baselines.
 */
export function aiLanguageInstruction(code: string, opts?: { json?: boolean }): string {
  const name = aiLanguageName(code);
  if (name === "English") return "";
  const base = `\n\nIMPORTANT: You MUST write your entire response in ${name}, regardless of the language of these instructions. Keep proper nouns in their original form — track names, car names, and named corners (e.g. Eau Rouge, Parabolica, 130R) are never translated.`;
  return opts?.json
    ? `${base} Also keep every JSON key and every schema-constrained enum value exactly as the schema defines it, in English (e.g. good/warning/critical, increase/decrease/adjust, minor/moderate/major, A/B) — translate only the human-readable string values.`
    : base;
}
