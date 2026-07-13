---
name: project_i18n_paraglide
description: RaceIQ i18n uses Paraglide JS (inlang); locale drives both UI and AI output language
metadata: 
  node_type: memory
  type: project
  originSessionId: dd97b038-d6b5-4f22-9c6b-454bdc29b2f9
---

RaceIQ localization added on branch `feat/i18n-locale-paraglide` (2026-07-13).

**Tooling: Paraglide JS v2 (`@inlang/paraglide-js`)** — chosen over Tolgee and i18next. Why: compiler-first, tree-shakable, no runtime provider, translations are flat JSON in git (contributions = PRs, no DB→git sync), non-devs edit via Fink browser editor, progress via Sherlock (VS Code) + inlang CLI. No server to run/ship — keeps the single-binary `raceiq.exe` clean. User priority was easy contributor workflow + local progress view.

**Architecture:**
- `shared/locales.ts` = single source of truth: `LOCALES` (code/label/aiName), `LOCALE_CODES`, `aiLanguageName()`, `aiLanguageInstruction(code, {json?})`. Seed locales: `en` (base) + `de`.
- Vite plugin `paraglideVitePlugin` in `client/vite.config.ts`, project at `client/project.inlang/`, messages at `client/messages/{en,de}.json`, compiled output `client/src/paraglide/` (git-ignored; regenerated on build). `project.inlang/settings.json` `locales` array must be kept in sync with `LOCALES` by hand.
- One persisted setting `language` (server `settings.ts` zod enum, default "en") drives BOTH: client Paraglide locale (bootstrapped in `__root.tsx` via `setLocale`) and the AI "respond in <language>" instruction.
- AI: `aiLanguageInstruction` appended in 3 prompt helpers (`getSystemPrompt`, `chatSystemPrompt`, `compareEngineerPersona`) + threaded through 4 builders + 4 `lap-routes.ts` call sites. Returns "" for English (no eval-baseline drift). System prompt STAYS English; only appends output-language directive. JSON keys + enum values (good/warning/critical, increase/decrease/adjust) stay English so structured-output parsing doesn't break.
- Pickers: new `StepLanguage` in Onboarding wizard + a `<select>` in Settings general section.

**Scope:** infra + AI-output localization complete. UI extraction is now broad (~502 keys, de 100%): settings + all sub-sections, full onboarding, home, sessions, laps, chats, AI panels, tunes/setups, cars, analyse, compare, telemetry, dev import, updates. Extraction done via parallel Haiku agents (English-only) + one Sonnet pass for German, assembled centrally into en/de.json. Duplicate per-page labels consolidated into shared `label_*`/`common_*` keys (one translation each). Final wave added F1 live/telemetry/grid panels, TrackDetail, F125 leaderboard (~569 keys total, de 100%). **Intentionally NOT translated:** dev/debug tooling (DevStateViewer, dev routes, track-debug panels) — product decision. **Still English (deferred):** deeply JSX-embedded setup-instruction `<ol>` lists, data-driven labels (tune sections/categories). **Rules:** game names are proper nouns kept verbatim (like track/car/corner names); ERS mode names + DRS/telemetry abbreviations kept verbatim in German. Switching language is reload-free (uiLocale remount key); memoized m.*() strings must include uiLocale in deps.

**tsconfig gotcha:** Paraglide emits JSDoc-typed `.js` (no `.d.ts`), so `client/tsconfig.app.json` needs `allowJs: true` + `checkJs: false`. `client build` runs `paraglide-js compile` BEFORE `tsc -b` (compiled dir is git-ignored → absent on fresh clone/CI).

**Contributor scripts:** root `i18n:machine-translate` + `i18n:validate` (both `bunx @inlang/cli`). Docs in `client/messages/README.md`.

Related: [[project_ai_chat_mastra]] [[project_unit_middleware_refactor]] [[feedback_no_dynamic_imports]]
