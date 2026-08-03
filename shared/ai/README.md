# shared/ai

Shared AI prompt utilities for chat, setup guidance, and UI-facing diagnostics.

## Purpose
- Centralize user-visible prompt fragments used by server-side assistants.
- Keep AI output language handling and policy text in one place.
- Keep exports minimal and serializable for server and client prompt assembly.

## Key modules
- `prompt-snippets.ts`
  - `TRACK_GUIDE_PROMPT`
  - `ADJUSTMENT_FORMAT_PROMPT`
- `language.ts`
  - `aiLanguageName`
  - `aiLanguageInstruction`
- `context-window.ts`
  - `contextWindowFor`

## Browser vs Node boundary
- All modules are pure and can run in browser bundles.
- `contextWindowFor` is currently UI-only by contract comment, but still pure and import-safe.
- `aiLanguageInstruction` is server-facing prompt text, currently used in AI prompt builders.

## Dependency direction
- `language.ts` depends on `../i18n/locales.ts`.
- Consumers import these leaves directly:
  - Server prompts: `shared/ai/language`, `shared/ai/prompt-snippets`
  - Client UI helpers: `shared/ai/context-window`
- No re-export barrel used in this domain.

## Add/extend safely
- Add new prompt policy text as a new named export in `prompt-snippets.ts`.
- Keep `aiLanguageInstruction` strict: return empty string for English baseline unless a translated language is requested.
- Add/adjust context limits in `context-window.ts` only for explicit provider/model behavior, return `undefined` when unknown.
- Prefer leaf imports, e.g. `import { ADJUSTMENT_FORMAT_PROMPT } from "@shared/ai/prompt-snippets"`.
