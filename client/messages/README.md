# Translations

RaceIQ's UI and AI output are localized with [Paraglide JS](https://inlang.com/m/gerre34r/library-inlang-paraglideJs).
Each language is one flat JSON file in this folder: `en.json` (the base) and one
per locale (`de.json`, …). Keys are shared across all files; values are the
translated strings.

## Contributing a translation

You don't need to be a developer.

**Option A — in the browser (easiest):** open the repo in the
[Fink editor](https://fink.inlang.com), pick a language, fill in the missing
strings, and it opens a pull request for you.

**Option B — edit the JSON directly:** copy a value from `en.json`, translate it
in the matching locale file, and open a PR. Keep the keys and any `{placeholders}`
exactly as they appear in `en.json`.

## Adding a new language

1. Add an entry to `shared/locales.ts` (`code`, `label`, `aiName`).
2. Add the same `code` to `locales` in `client/project.inlang/settings.json`.
3. Create `client/messages/<code>.json` (copy `en.json` as a starting point).
4. Optionally run `bun run i18n:machine-translate` to pre-fill it from English,
   then refine by hand.

## Checking progress

- **VS Code:** install the [Sherlock](https://inlang.com/m/r7kp499g/app-inlang-ideExtension)
  extension for inline per-locale coverage and missing-key highlighting.
- **Terminal:** `bun run i18n:validate` reports missing/broken messages.
- **Fill gaps automatically:** `bun run i18n:machine-translate`.

## Notes

- Only a subset of the UI is extracted so far (setup wizard, settings, nav). More
  strings are migrated over time; untranslated UI falls back to English.
- The AI (chat + lap analysis) is told to respond in the selected language via a
  server-side prompt instruction — that part needs no message files.
