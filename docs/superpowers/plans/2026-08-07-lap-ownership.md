# Lap Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classify every imported session as `Mine` or `Others`, filter owned statistics correctly, preserve cross-group session actions, and label ownership in Compare and Analyse.

**Architecture:** Store ownership on `sessions`, independent from telemetry provenance such as `source = motec`. Thread one validated `mine | others` value through the common import pipeline and expose it through `SessionMeta`/`LapMeta`. Keep ownership filtering server-side for statistics and driver-profile pools; keep Sessions tab state purely client-side and preserve selected IDs across tab changes.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, SQLite append-only migrations, React, TanStack Query/Router, Paraglide messages, Vitest/Bun tests, Playwright component/page tests.

## Global Constraints

- Existing and live sessions resolve to `mine`.
- Ownership choice is required for `.bin`, `.bin.gz`, `.ibt`, and MoTeC `.ld` imports.
- `others` stays visible to general listing, comparison, and export.
- `others` is excluded from user-owned statistics and driver-profile aggregation.
- Do not reuse `sessions.source` for ownership; preserve provenance semantics.
- Selection must survive switching `Mine` and `Others` tabs.
- Compare and Analyse labels must come from persisted ownership.

---

### Task 1: Add persisted session ownership and migration

**Files:**
- Modify: `server/db/schema.ts` — add `ownership` to `sessions` with the `mine | others` type and default.
- Modify: `server/db/migrations.ts` — append migration adding/backfilling the column.
- Modify: `shared/racing/sessions/types.ts` — add ownership to `SessionMeta` and `LapMeta`.
- Test: `server/db/migrations/migration-regression.test.ts` — verify old session rows migrate to `mine`.

**Interfaces:**
- Produces `type SessionOwnership = "mine" | "others"` in the shared sessions contract.
- Produces persisted `sessions.ownership` with default `mine`.

- [ ] **Step 1: Write migration regression coverage**

Insert a legacy `sessions` row using the pre-ownership shape in the migration fixture, run the migration bootstrap, then assert `SELECT ownership FROM sessions` returns `mine`. Add an insert assertion that omitting ownership also stores `mine`.

- [ ] **Step 2: Run the focused migration test and confirm failure**

Run `bun test server/db/migrations/migration-regression.test.ts`. Expected: failure because the schema and migration do not expose `ownership`.

- [ ] **Step 3: Add the shared type and Drizzle column**

Define the shared union once, use it for `SessionMeta.ownership` and `LapMeta.ownership`, and add the SQLite text column with a database default of `mine`. Keep `source` unchanged.

- [ ] **Step 4: Append the migration**

Add the next migration entry using `ALTER TABLE sessions ADD COLUMN ownership TEXT NOT NULL DEFAULT 'mine'`, then explicitly update null/legacy values to `mine`. Do not rewrite existing migrations.

- [ ] **Step 5: Run the focused migration test**

Run `bun test server/db/migrations/migration-regression.test.ts`. Expected: PASS, including existing migration cases.

- [ ] **Step 6: Commit**

```bash
git add server/db/schema.ts server/db/migrations.ts shared/racing/sessions/types.ts server/db/migrations/migration-regression.test.ts
git commit -m "feat: persist session ownership"
```

### Task 2: Thread ownership through all import pipelines

**Files:**
- Modify: `server/session-capture/import-capture.ts` — accept ownership in import options.
- Modify: `server/session-capture/import-pipeline.ts` — apply ownership when inserting sessions.
- Modify: `server/telemetry/pipeline-ports.ts` and the real DB adapter implementation — accept session ownership without changing live callers.
- Modify: `server/routes/laps/transfer-routes.ts` — validate ownership for binary, MoTeC, and IBT requests.
- Modify: `server/motec/import.ts` — pass ownership through MoTeC import options.
- Modify: `server/games/iracing/import-ibt.ts` — thread ownership into staged commit.
- Test: `server/session-capture/import-pipeline.test.ts` and focused route/import tests matching existing conventions.

**Interfaces:**
- Consumes `SessionOwnership` from Task 1.
- Produces `importSessionBin(bytes, gameId, { ownership })`, `importSessionFrames(..., { ownership })`, and commit payload validation requiring `ownership`.

- [ ] **Step 1: Add failing pipeline tests**

Add tests importing a minimal fixture with `ownership: "others"` and assert every created session has `others`; add a default-options test asserting omitted ownership creates `mine`.

- [ ] **Step 2: Run focused import tests and confirm failure**

Run the existing import pipeline test command plus the new test names. Expected: failure because ownership is not accepted or persisted.

- [ ] **Step 3: Extend pipeline options and adapter contracts**

Add `ownership?: SessionOwnership` to import options, normalize omitted values to `mine`, and pass it to session creation. Update the real adapter and live recording callsites with the default so live capture behavior is unchanged.

- [ ] **Step 4: Validate HTTP inputs**

Add a shared request schema/helper that accepts only `mine` or `others`. Binary multipart reads the form field; MoTeC reads the form field; IBT commit validates JSON ownership. Reject missing/invalid values with 400 rather than silently changing a user choice.

- [ ] **Step 5: Thread MoTeC and IBT ownership**

Add ownership to `MotecImportOptions`; preserve `MOTEC_SESSION_SOURCE`. Extend staged IBT commit to pass ownership only when committing, not during preview.

- [ ] **Step 6: Run focused import and route tests**

Run the import pipeline, transfer-route, MoTeC, and IBT focused tests. Expected: PASS with all import paths covered.

- [ ] **Step 7: Commit**

```bash
git add server/session-capture server/telemetry/pipeline-ports.ts server/routes/laps/transfer-routes.ts server/motec/import.ts server/games/iracing/import-ibt.ts test
 git commit -m "feat: classify imported sessions by ownership"
```

### Task 3: Expose ownership and enforce owned-stat filtering

**Files:**
- Modify: `server/db/session-queries.ts` — select/normalize ownership in `getSessions`; add ownership to session recap inputs if displayed there.
- Modify: `server/db/lap-read-queries.ts` — select/normalize ownership in all LapMeta queries and filter `getLapStats` plus profile-scope queries to `mine`.
- Modify: `server/db/lap-meta.ts` — map ownership at the DB boundary.
- Modify: `server/driver-profile/load.ts` and `server/driver-profile/runner.ts` only if their callers need an explicit owned-pool contract.
- Test: `server/db/lap-read-queries.test.ts` or the nearest existing DB query test file.

**Interfaces:**
- `getSessions()` returns `SessionMeta.ownership`.
- Every LapMeta-producing query returns `LapMeta.ownership`.
- `getLapStats(gameId?)` counts only sessions with ownership `mine`.
- `getLapMetaForProfileScope()` returns only `mine` laps before pagination/decoding.

- [ ] **Step 1: Write failing query tests**

Seed one `mine` and one `others` session with equal valid laps. Assert `getLapStats()` counts only the mine row, `getLapMetaForProfileScope()` excludes the others row, while `getSessions()` and `getLaps()` return both with correct ownership.

- [ ] **Step 2: Run focused DB tests and confirm failure**

Run the focused query test file. Expected: statistics include both rows and DTOs lack ownership.

- [ ] **Step 3: Add the shared SQL predicate**

Use the same SQL condition (`ownership = 'mine'` with a defensive null fallback only during rollout) in aggregate and profile-pool queries. Apply it before grouping, limits, or profile decoding.

- [ ] **Step 4: Extend all lap/session projections**

Select ownership wherever `toLapMeta` is built, normalize legacy nulls to `mine`, and include ownership in session recap data only where the DTO identifies a session/lap.

- [ ] **Step 5: Run focused DB/profile tests**

Run query, driver-profile, and recap tests. Expected: PASS with foreign rows visible to general reads but absent from owned pools.

- [ ] **Step 6: Commit**

```bash
git add server/db server/driver-profile test
 git commit -m "fix: exclude other drivers from owned stats"
```

### Task 4: Replace Sessions tabs and preserve cross-group selection

**Files:**
- Modify: `client/src/components/sessions/types.ts` — replace tab union with `mine | others`.
- Modify: `client/src/components/sessions/helpers.ts` — filter by ownership instead of source.
- Modify: `client/src/components/sessions/SessionToolbar.tsx` — render Mine/Others and show selections across hidden tabs.
- Modify: `client/src/components/sessions/SessionsPage.tsx` — preserve selected IDs in `setTab`; keep bulk actions and compare navigation cross-group.
- Modify: `client/src/routes/$gameid/sessions.tsx` and route search validation — migrate query parameter names/defaults.
- Modify: `client/src/paraglide/messages/*` through the project’s message-generation workflow — add Mine/Others and ownership copy.
- Test: `client/src/components/sessions` tests/stories and relevant Playwright session tests.

**Interfaces:**
- `filterSessions(sessions, search, tab)` filters `session.ownership`.
- Selection sets remain authoritative across tab changes; actions use IDs, not visible rows.

- [ ] **Step 1: Write failing UI tests**

Render Sessions with one mine and one others session. Assert tab labels, filtering, and that selecting one row then switching tabs retains the selection and enables delete/compare actions.

- [ ] **Step 2: Run focused UI tests and confirm failure**

Run the Sessions component test/story test command. Expected: current Recorded/Imported labels and tab change clearing fail the new assertions.

- [ ] **Step 3: Replace tab state and filter logic**

Change the tab type/search validation and helper predicate to ownership. Preserve `selectedSessions` and `selectedLaps` in `setTab`; do not remove hidden selections when filtering.

- [ ] **Step 4: Update toolbar action presentation**

Show counts for selected sessions/laps independent of current tab. Keep compare enabled when two selected laps have compatible tracks even if they belong to different ownership tabs. Keep bulk delete ID-based.

- [ ] **Step 5: Update localization and route compatibility**

Add message keys for Mine/Others and ownership labels, update all callers, and map old `tab=recorded/imported` URLs to `mine` for compatibility without retaining old UI semantics.

- [ ] **Step 6: Run focused UI tests**

Run Sessions component tests and the targeted Playwright session flow. Expected: PASS for filtering, persistent selection, cross-group compare, and delete.

- [ ] **Step 7: Commit**

```bash
git add client/src/components/sessions client/src/routes client/src/paraglide
 git commit -m "feat: filter sessions by ownership"
```

### Task 5: Add ownership choice to every import UI

**Files:**
- Modify: `client/src/components/analyse/useAnalyseImports.ts` — collect ownership before binary/IBT import and include it in requests.
- Modify: `client/src/components/analyse/AnalyseLapHeader.tsx` or a focused import-choice modal — render explicit Mine/Others choice for binary and IBT flows.
- Modify: `client/src/components/analyse/IbtImportPreviewModal.tsx` — collect/submit choice at commit.
- Modify: `client/src/components/sessions/MotecImportModal.tsx` — collect and submit ownership.
- Modify: `client/src/components/dev/ImportDumpPanel.tsx` — collect ownership for dev dump imports.
- Modify: import-related Paraglide messages.
- Test: import UI component tests and targeted Playwright import flows.

**Interfaces:**
- Each import request carries `ownership: "mine" | "others"`.
- Choice defaults to `mine` in UI but is explicit in submitted payloads.

- [ ] **Step 1: Write failing UI tests**

For each import modal/path, assert both choices render, Mine is the initial selection, and selecting Others changes the submitted form field/JSON body. For IBT assert the choice is submitted on commit.

- [ ] **Step 2: Run focused import UI tests and confirm failure**

Run the import component tests. Expected: no ownership control or request field exists.

- [ ] **Step 3: Build the shared ownership choice control**

Use existing app button/radio patterns and accessible labels. Keep one shared value type and avoid duplicating request serialization logic.

- [ ] **Step 4: Wire binary, IBT, MoTeC, and dev dump requests**

Append ownership to multipart forms or JSON bodies. Ensure the IBT preview remains classification-neutral and commit carries the selected value.

- [ ] **Step 5: Run focused UI/import tests**

Run component tests and targeted browser import flows. Expected: PASS for every supported file type.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/analyse client/src/components/sessions/MotecImportModal.tsx client/src/components/dev/ImportDumpPanel.tsx client/src/paraglide
 git commit -m "feat: choose lap ownership during import"
```

### Task 6: Label ownership in Compare and Analyse

**Files:**
- Modify: `client/src/components/comparison/ComparisonSelectors.tsx` and `client/src/components/comparison/LapComparison.tsx` — render Mine/Others badges for selected laps.
- Modify: `client/src/components/analyse/AnalyseLapHeader.tsx`, `client/src/components/analyse/useAnalyseSelections.ts`, and related lap header views — render the persisted label for the active lap.
- Modify: server compare/analyse response builders only where ownership is currently dropped from selected-lap DTOs.
- Modify: relevant localization messages.
- Test: Compare/Analyse component tests and targeted browser flows.

**Interfaces:**
- Consumers read `LapMeta.ownership`; no tab state is passed into Compare/Analyse to infer ownership.

- [ ] **Step 1: Write failing label tests**

Render a mine lap and an others lap in Compare and Analyse fixtures. Assert visible, accessible labels match each lap’s persisted ownership.

- [ ] **Step 2: Run focused tests and confirm failure**

Run the Compare/Analyse component tests. Expected: selected lap identity has no ownership label.

- [ ] **Step 3: Render ownership badges**

Place a compact text badge beside each lap/session identity in selectors and headers. Use stable `data-testid` or accessible text for tests; do not alter lap values or comparison math.

- [ ] **Step 4: Run focused UI tests and browser smoke**

Run component tests, then exercise one cross-owner comparison and one Analyse selection in the browser. Expected: labels remain correct after navigation.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/comparison client/src/components/analyse client/src/paraglide server
 git commit -m "feat: label lap ownership in analysis views"
```

### Task 7: Full verification and release notes

**Files:**
- Modify: `CHANGELOG.md` — add an Unreleased user-visible entry following repository release-note conventions.
- Test: affected server/client test suites and a browser smoke path.

- [ ] **Step 1: Run targeted server tests**

Run migration, import pipeline, transfer route, lap query, driver-profile, MoTeC, and IBT tests. Expected: PASS.

- [ ] **Step 2: Run targeted client tests**

Run Sessions, import UI, Compare, and Analyse tests. Expected: PASS.

- [ ] **Step 3: Run the application smoke path**

Start the app, import one binary or MoTeC file as Others, verify it appears under Others and is absent from owned stats, switch tabs with a selected row, compare it against a Mine lap, delete the cross-tab selection, and confirm Compare/Analyse labels.

- [ ] **Step 4: Run typecheck/build checks**

Run the repository’s documented typecheck and production build commands. Expected: no TypeScript or generated-message errors.

- [ ] **Step 5: Add release note**

Document Mine/Others import classification, cross-tab selection, and Compare/Analyse labels under Unreleased.

- [ ] **Step 6: Commit verification artifacts**

```bash
git add CHANGELOG.md
git commit -m "docs: note lap ownership controls"
```
