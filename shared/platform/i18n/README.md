# Internationalization

Locale registry and language metadata shared across UI and AI prompt paths.

## Purpose
- Centralize locale identity (`LOCALES`) used by UI and runtime settings.
- Emit locale-backed AI prompt language hints.
- Drive UI locale switch boundaries and validation wiring.

## Key modules
- `locales.ts`
  - `LOCALES`
  - `LocaleCode`
  - `LOCALE_CODES`

## Browser vs Node boundary
- Pure constants module, browser-safe.
- No Node APIs.
- Used by both client message wiring and server settings validation.

## Dependency direction
- `LOCALES` flows to:
  - `shared/integrations/ai/language.ts` for `aiLanguageInstruction`
  - `client/src/components/Onboarding.tsx`, `Settings.tsx`
  - `server/runtime/config/settings.ts` validation via `LOCALE_CODES`
  - translation files under `client/messages/` (external to this folder)

## Source-of-truth and regeneration
- Locale source-of-truth for in-app locale membership is `shared/platform/i18n/locales.ts`.
- Translation payloads are `client/messages/*.json`.
- Update sequence for adding a locale:
  1. Add locale entry in `shared/platform/i18n/locales.ts`.
  2. Add same locale to `client/project.inlang/settings.json`.
  3. Add `client/messages/<code>.json`.
  4. Run:
     - `bun run i18n:validate`
     - `bun run i18n:machine-translate` (optional baseline)

## Add/extend safely
- Keep keys aligned across message files; do not change keys, only values.
- Keep each locale's `aiName` aligned with the language name used in AI prompts.
- Import locale data directly from `shared/platform/i18n/locales`.
