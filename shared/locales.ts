// Canonical list of app locales. Single source of truth for:
//   - the server settings `language` enum (server/runtime/config/settings.ts)
//   - the AI system-prompt language name (server/ai/*)
//   - the language picker UI options (Settings + Onboarding)
//
// NOTE: `client/project.inlang/settings.json` holds its OWN `locales` array
// (plain JSON — it cannot import this file). Keep the two in sync by hand.
// Adding a language = one entry here + one entry in project.inlang/settings.json
// + a `client/messages/<code>.json` file. See client/messages/README.md.

export const LOCALES = [
  { code: "en", label: "English", aiName: "English" },
  { code: "de", label: "Deutsch", aiName: "German" },
] as const;

export type LocaleCode = (typeof LOCALES)[number]["code"];

export const LOCALE_CODES = LOCALES.map((l) => l.code);

/** Human-readable language name for the AI "respond in <language>" instruction. */
export const aiLanguageName = (code: string): string =>
  LOCALES.find((l) => l.code === code)?.aiName ?? "English";

/**
 * The system-prompt line that steers AI output into the user's language.
 * Returns "" for English so English requests are byte-for-byte unchanged
 * (keeps the AI eval baselines stable). Pass `json: true` for any flow whose
 * output is parsed against a schema, so the model translates only
 * human-readable string values while leaving JSON keys and schema-constrained
 * enum values in English — translating those breaks structured-output parsing.
 * Freeform flows (chat) leave it off.
 */
export function aiLanguageInstruction(code: string, opts?: { json?: boolean }): string {
  const name = aiLanguageName(code);
  if (name === "English") return "";
  const base = `\n\nIMPORTANT: You MUST write your entire response in ${name}, regardless of the language of these instructions. Keep proper nouns in their original form — track names, car names, and named corners (e.g. Eau Rouge, Parabolica, 130R) are never translated.`;
  return opts?.json
    ? `${base} Also keep every JSON key and every schema-constrained enum value exactly as the schema defines it, in English (e.g. good/warning/critical, increase/decrease/adjust, minor/moderate/major, A/B) — translate only the human-readable string values.`
    : base;
}
