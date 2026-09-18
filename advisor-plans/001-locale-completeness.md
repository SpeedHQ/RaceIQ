# Plan 001: Complete locale usage across client UI

> **Executor instructions**: Follow this plan step by step. Do not modify files outside Scope. Skip full validation during implementation; the reviewer will run verification after the diff is complete.
>
> **Drift check**: `git diff --stat 9f2325bff..HEAD -- client/src client/messages client/project.inlang package.json bun.lock`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `9f2325bff`, 2026-09-18

## Why this matters

RaceIQ has Paraglide locale switching for English and German, but multiple active client surfaces still render English literals and browser-default date/number formats. German users therefore receive mixed-language UI and inconsistent formatting. The German catalog also lacks one English key, while the intended validation command currently fails before validation because its transient `@inlang/cli` install cannot resolve `esbuild-wasm`.

## Current state

- Locale setup: `client/project.inlang/settings.json` declares `en` and `de`; `client/src/lib/locale.ts` calls `setLocale(code, { reload: false })` and bumps `uiLocale`; `client/src/routes/__root.tsx` remounts routed content on that key.
- Message convention: all user-facing client copy must use Paraglide messages from `client/messages/`; add or update every supported locale.
- Existing locale-sensitive exemplar: `client/src/components/ActivityHeatmap.tsx:46-53` uses `getLocale()` with `Intl.DateTimeFormat`.
- Existing reactive message exemplar: `client/src/components/settings/general/GeneralSection.tsx:17-45` reads `m.*()` and uses `applyLocale`.
- Known missing key: `sessions_export_motec_whole_session_confirm` exists in `client/messages/en.json` but not `client/messages/de.json`.
- Hardcoded active UI examples: `client/src/components/NoDataView.tsx:95-97`, `client/src/components/DevStateViewer.tsx:17-29`, `client/src/components/RaceInfo.tsx:49`, `client/src/components/InsightPanel.tsx:34-52,86`, `client/src/components/ai-chat/ChatPanel.tsx:104-106`, `client/src/components/analyse/AnalyseDataPanel.tsx:53-63`, and `client/src/components/analyse/AnalyseLapHeader.tsx:15,119`.
- Browser-default formatting examples: `client/src/components/SessionRecap.tsx:206`, `client/src/components/analyse/AnalyseLapHeader.tsx:118-119`, `client/src/components/sessions/SessionDesktopTable.tsx:145-146`, `client/src/components/ActivityHeatmap.tsx:186`, `client/src/components/UpdateModal.tsx:126,141`.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Compile messages | `bun run --cwd client i18n:compile` | exits 0 and regenerates Paraglide output |
| Typecheck | `bun run typecheck` | exits 0 |
| Locale validation | `bun run i18n:validate` | exits 0; currently blocked by transient `esbuild-wasm` resolution, so report if still blocked |
| Client lint | `bun run --cwd client lint` | exits 0 |

## Scope

In scope:
- `client/messages/en.json`
- `client/messages/de.json`
- `client/src/components/**/*.tsx`
- `client/src/components/**/*.ts`
- `client/src/lib/**/*.ts`
- `client/src/routes/**/*.tsx`
- `client/src/paraglide/` only through the existing compile command; never hand-edit generated files

Out of scope:
- Server/API/domain labels and telemetry names unless they are directly rendered as UI copy in listed client files.
- Proper nouns, car/track/game names, units, keyboard glyphs, protocol names, and telemetry field names.
- `client/src/routeTree.gen.ts`.
- Dependency upgrades or lockfile changes.

## Steps

### Step 1: Add missing catalog entry

Add `sessions_export_motec_whole_session_confirm` to `client/messages/de.json`, preserving the English message shape and translating the value into German. Keep key sets identical between `en.json` and `de.json`.

**Verify**: compare sorted top-level keys with `jq`; expected zero missing and zero extra keys.

### Step 2: Replace active hardcoded copy

Search all client TS/TSX under `client/src` for user-facing English literals in JSX, ARIA labels, titles, placeholders, confirmation text, and composed labels. Add message keys to both locale files and replace literals with `m.*()` calls. Preserve technical literals and proper nouns listed Out of scope.

Required known sites include:
- `NoDataView.tsx` iRacing guide steps.
- `DevStateViewer.tsx` labels, pause/resume, waiting state.
- `RaceInfo.tsx` Lap label.
- `InsightPanel.tsx` previous/next event labels and no-issues state.
- `ai-chat/ChatPanel.tsx`, `chat-runtime.tsx`, `token-usage.tsx` visible copy and accessible labels.
- `analyse/AnalyseDataPanel.tsx`, `AnalyseLapHeader.tsx`, `AnalyseDynamicsPanel.tsx`, `AnalyseMetricsPanel.tsx`, `AnalyseTimelineScrubber.tsx` visible copy.
- Any additional active UI literals found by the search.

Use message parameters for dynamic nouns and counts. Do not build English grammar by concatenating translated fragments when a whole sentence/key can express it.

**Verify**: search `client/src` for the known literal phrases; expected no active UI matches except explicitly out-of-scope technical/proper-name values.

### Step 3: Centralize locale-aware formatting

Use `getLocale()` from `@/paraglide/runtime` for browser-visible dates and numbers. Replace `toLocaleDateString()`, `toLocaleTimeString()`, `toLocaleString()`, and bare `toLocaleString()` number formatting in active client UI with explicit locale arguments or shared helpers. Preserve existing formatting options and visual precision. Update composed labels in `AnalyseLapHeader.tsx` to use message keys for Lap/Session/plural forms and the selected locale.

Known sites include `ActivityHeatmap.tsx`, `ChatsPage.tsx`, `SessionRecap.tsx`, `UpdateModal.tsx`, `SessionDesktopTable.tsx`, `SessionMobileList.tsx`, `RecentLaps.tsx`, `DriverTrendOverview.tsx`, `AccCars.tsx`, `CarDetail.tsx`, `CompareModal.tsx`, `ComboDash.tsx`, `analysis-display.tsx`, and `TrackDebugCanvas.tsx`.

**Verify**: search active client UI for bare `toLocaleDateString(`, `toLocaleTimeString(`, and `toLocaleString(`; every remaining call must pass `getLocale()` or be intentionally non-UI/internal and documented inline.

### Step 4: Compile generated messages

Run the existing client i18n compile command. Do not hand-edit `client/src/paraglide/` output.

**Verify**: compile exits 0 and generated declarations expose every newly added key.

## Test plan

No new permanent test is required unless an existing locale test pattern exists. Use the repository's existing tooling and locale key comparison as behavioral checks. If a test is added, cover locale switching and selected-locale date formatting, not implementation details.

## Done criteria

- [ ] English/German top-level message keys are identical.
- [ ] Active client copy uses Paraglide messages except documented technical/proper-name values.
- [ ] User-visible date/number formatting follows selected app locale.
- [ ] Analyse labels support German grammar and pluralization through messages.
- [ ] `bun run --cwd client i18n:compile` exits 0.
- [ ] Reviewer runs `bun run typecheck` and `bun run --cwd client lint`.
- [ ] No generated files hand-edited.

## STOP conditions

- Stop if a candidate string is domain data rather than UI copy and its translation policy is unclear.
- Stop if message-format syntax cannot represent a required plural or parameter without changing the message contract broadly.
- Stop if validation requires dependency installation or lockfile changes; report the blocker instead.

## Maintenance notes

Future UI copy must add both locale entries before component use. New date/number displays must pass the Paraglide runtime locale explicitly. Reviewers should inspect dynamic string composition, plural forms, and accessibility labels separately from visible text.
