# Race-Result Staleness Notification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect outdated stored race results and expose synchronized rerun status, action, and progress in the global prompt and Settings Diagnostics.

**Architecture:** Reuse the existing websocket notification pattern used by stale lap detection. Add database helpers for processor-version filtering, a bulk reconciliation route with progress broadcasts, and a dedicated client store slice consumed by both root notification UI and DiagnosticsSection. Reconciliation remains derived-result-only; lap reprocessing remains separate.

**Tech Stack:** Bun, TypeScript, Hono, Drizzle SQLite, React, Zustand, TanStack Query, Paraglide messages, Vitest.

## Global Constraints

- Current race-result processor ID is `RACE_RESULT_PROCESSOR_ID` from `shared/race-results.ts`.
- Stale means an existing `session_results.processor_version` differs from current ID.
- Do not reparse telemetry or reuse `/api/sessions/reprocess-stale`.
- Preserve lap-detector notification behavior unchanged.
- Use existing websocket and Settings Diagnostics patterns.
- Write tests first and verify each red/green cycle.

---

### Task 1: Detect stale stored race results

**Files:**
- Modify: `server/db/queries.ts` near `getSessionResult`
- Modify: `server/routes/session-routes.ts`
- Test: `test/race-results-storage.test.ts`

**Interfaces:**
- Produce `countStaleRaceResults(currentProcessorVersion: string): Promise<number>` and `getStaleRaceResultSessionIds(currentProcessorVersion: string): Promise<number[]>`.
- Produce `stale-race-results` websocket payload with `{ type, sessionCount, currentVersion }`.

- [ ] Write tests proving matching processor versions are excluded and older versions are counted/listed.
- [ ] Run focused storage test and confirm failure because helpers do not exist.
- [ ] Implement Drizzle filters joining `session_results` to sessions only as needed, using `isNull` excluded by query shape and `not(eq(...))` for old versions.
- [ ] Add startup check beside stale lap-detector check and persist notification through `wsManager`.
- [ ] Run focused storage tests and confirm pass.

### Task 2: Add bulk reconciliation endpoint and progress broadcasts

**Files:**
- Modify: `server/routes/session-routes.ts`
- Modify: `server/race-results/reconcile.ts`
- Test: `test/race-results-storage.test.ts`

**Interfaces:**
- Add `POST /api/race-results/reconcile-stale`.
- Broadcast `{ type: "race-result-reconciled", sessionId, done, total, status }` after each attempted session.
- Clear stale notification only after all attempts succeed; return `{ reprocessed, results }`.

- [ ] Add endpoint test showing stale sessions are reconciled and progress is emitted.
- [ ] Run focused route/storage tests and confirm failure on missing endpoint.
- [ ] Implement sequential stale-ID processing through `reconcileSessionResult`, with per-session error capture and notification retention on failure.
- [ ] Run focused tests and confirm pass.

### Task 3: Add synchronized client race-result status state

**Files:**
- Modify: `client/src/stores/telemetry.ts`
- Modify: `client/src/hooks/useWebSocket.ts`
- Modify: `client/src/messages/en.json`
- Modify: `client/src/messages/de.json`
- Test: `client/test/race-result-ledger.test.ts` or a focused new store test following existing conventions

**Interfaces:**
- Store `staleRaceResults: { sessionCount: number; currentVersion: string } | null`.
- Store `raceResultReprocessProgress: { done: number; total: number } | null`.
- Provide setters/incrementer matching existing reprocess state patterns.

- [ ] Add store transition tests for notification, progress, completion, and retry-preserving error state.
- [ ] Run focused client test and confirm failure.
- [ ] Add store state and websocket handlers for `stale-race-results` and `race-result-reconciled`.
- [ ] Add localized copy for status, action, progress, completion, and errors.
- [ ] Run focused client tests and confirm pass.

### Task 4: Render global prompt and Settings Diagnostics panel

**Files:**
- Modify: `client/src/routes/__root.tsx`
- Modify: `client/src/components/settings/DiagnosticsSection.tsx`
- Test: existing client component test location if present; otherwise rely on store/API tests plus browser smoke.

**Interfaces:**
- Both surfaces read/write the same telemetry-store race-result state.
- Action calls `/api/race-results/reconcile-stale` and initializes progress from `sessionCount`.

- [ ] Add UI tests or deterministic component assertions for stale, running, complete, and no-stale states.
- [ ] Run focused UI test and confirm failure.
- [ ] Add prompt action and progress modal without changing lap-detector controls.
- [ ] Add Diagnostics status card with current version, affected count, action, progress bar, completion, and retry/error handling.
- [ ] Run focused UI tests and confirm pass.

### Task 5: Verify integration

**Files:**
- Modify: `docs/superpowers/specs/2026-08-05-race-result-staleness-design.md` only if review finds ambiguity.

- [ ] Run focused race-result tests.
- [ ] Run client typecheck/build or the narrowest existing equivalent.
- [ ] Exercise websocket/status transitions through the existing browser/dev-server smoke path.
- [ ] Confirm lap-detector stale prompt and endpoint remain unchanged.
- [ ] Store completed architecture and verification summary in ICM.
