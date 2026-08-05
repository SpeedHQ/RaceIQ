# Race Result Inline Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Version and persist race-result metadata during lap processing, then show it inline in session rows.

**Architecture:** Add a processor version to `session_results`; reconcile the affected session after lap writes with per-session coalescing and stale-version detection. Extend session DTOs with result fields and render compact metadata in `SessionsPage`; remove page-top summary mounts and read-triggered writes.

**Tech Stack:** Bun, TypeScript, Hono, Drizzle SQLite, React, TanStack Query, existing `SessionsPage` table primitives.

## Global Constraints

- Current processor identifier is `race-result-v1`.
- Aggregate GET endpoints must not mutate or reconcile database state.
- Reconciliation must remain idempotent and update pit events consistently.
- Existing explicit backfill endpoint remains available for historical/stale rows.
- Use existing session table styles, mobile card layout, and localization patterns where practical.

---

### Task 1: Version result persistence

**Files:**
- Modify: `server/db/schema.ts` session result columns
- Modify: `server/db/migrations.ts` migration registration
- Modify: `server/db/queries.ts` result input/upsert and session result reads
- Modify: `shared/race-results.ts` result DTO
- Test: `test/race-results-storage.test.ts`

**Interfaces:**
- Produce `RACE_RESULT_PROCESSOR_ID = "race-result-v1"`.
- Produce `processorVersion: string` on stored/result DTOs.
- `upsertSessionResult` accepts and persists `processorVersion`.

- [ ] Add a migration for non-null `processor_version` with current-version default.
- [ ] Add `processorVersion` to shared result types and query mappings.
- [ ] Make upsert update processor version and `updatedAt` without creating duplicate session rows.
- [ ] Add a test proving the same session/result remains one row and stores the current processor version.
- [ ] Run `bun test test/race-results-storage.test.ts`.
- [ ] Commit `feat: version race result processor`.

### Task 2: Reconcile after lap persistence

**Files:**
- Modify: `server/race-results/reconcile.ts`
- Modify: `server/race-results/aggregates.ts`
- Modify: `server/pipeline-adapters.ts`
- Modify: `server/import-session-bin.ts` only if adapter completion needs explicit flush
- Test: `test/race-results-storage.test.ts` or a focused new race-result processor test

**Interfaces:**
- Produce `reconcileSessionResult(sessionId, gameId)` with stale-version detection.
- Produce a centralized post-lap trigger that coalesces concurrent requests by session.
- `getRaceResultAggregate` and `getRecentRaceResults` become read-only.

- [ ] Define current processor identifier in one server race-result module.
- [ ] Treat an existing result as unchanged only when all derived fields, pit events, and processor version match.
- [ ] Add a per-session in-flight map so repeated lap writes await one reconciliation rather than decode concurrently.
- [ ] Call the trigger after `RealDbAdapter.insertLap` persists the lap; ensure import capture uses the same path and does not finish before reconciliation is scheduled/awaited.
- [ ] Change aggregate reads to query stored rows only; preserve explicit backfill for missing/stale rows.
- [ ] Update backfill selection to include missing rows and rows with an old processor version.
- [ ] Test stale-version reconciliation and repeated calls/idempotency.
- [ ] Run focused race-result tests.
- [ ] Commit `feat: reconcile versioned race results on lap writes`.

### Task 3: Return result metadata with sessions

**Files:**
- Modify: `shared/types.ts` `SessionMeta`
- Modify: `server/db/queries.ts` `getSessions`
- Modify: `server/routes/session-routes.ts` only if response typing needs adjustment
- Test: focused session-query test or existing session query test convention

**Interfaces:**
- `SessionMeta` adds nullable result fields: `resultClassification`, `finishingPosition`, `qualifyingPosition`, `isPodium`, `isFastestLap`, `pitCount`, and `pitDurationSeconds`.

- [ ] Left-join stored result metadata and aggregate pit duration into `getSessions` without invoking reconciliation.
- [ ] Preserve sessions without result rows as null/undefined metadata.
- [ ] Add query coverage for result-bearing and result-less sessions.
- [ ] Run the focused query test.
- [ ] Commit `feat: include race results in session metadata`.

### Task 4: Render inline session results

**Files:**
- Modify: `client/src/components/SessionsPage.tsx`
- Modify: localization files only if existing messages cannot express labels
- Test: existing client typecheck/build

**Interfaces:**
- Consume the extended `SessionMeta` fields from Task 3.
- Render the same result information in desktop rows and mobile cards.

- [ ] Add compact status badge/text for classification and position.
- [ ] Add podium and fastest-lap indicators without changing row expansion behavior.
- [ ] Add pit count/time only when stored values are available; distinguish unknown from zero.
- [ ] Keep table column count and mobile layout valid for F1 and non-F1 variants.
- [ ] Run client typecheck/build.
- [ ] Commit `feat: show race results in session rows`.

### Task 5: Remove page-top summary mounts

**Files:**
- Modify: `client/src/components/HomePageContainer.tsx`
- Modify: `client/src/components/driver/DriverProfilePage.tsx`
- Modify: `client/src/components/track/TrackDetailRoute.tsx`
- Modify: `client/src/routes/$gameid/cars.tsx`
- Modify: `client/src/components/race-results/ResultSummary.tsx` only if now unused

**Interfaces:**
- No page should trigger reconciliation merely by mounting a summary component.

- [ ] Remove imports and JSX mounts from all four unrelated pages.
- [ ] Delete unused summary component only if no explicit aggregate consumer remains.
- [ ] Search all `RaceResultSummary` references and confirm no accidental page-top consumer remains.
- [ ] Run client build/typecheck and focused tests.
- [ ] Commit `refactor: remove page-top race result summaries`.

### Task 6: Verify and publish

**Files:**
- No source changes unless verification exposes a defect.

- [ ] Run targeted race-result tests.
- [ ] Run client/server smoke checks and inspect generated type/build output.
- [ ] Inspect diff for hidden GET-side writes, unversioned result writes, and stale UI mounts.
- [ ] Push branch with `git push --force-with-lease origin HEAD:feat/issue-181-race-results`.
- [ ] Confirm PR #197 reports the new head and mergeable status.
