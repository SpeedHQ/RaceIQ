# Reconciliation Version Menu Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure stale reconciliation notifications and the reconcile endpoint cover sessions with older lap-detector versions, older result versions, and no stored result.

**Architecture:** Keep existing startup jobs and websocket notification shape. Extend race-result stale queries to derive stale sessions from `sessions` with a left join to `session_results`, so missing results are included. Add focused integration tests in existing domain suites; test the server notification setters through a small test-only seam or the existing manager state/access pattern without rendering React.

**Tech Stack:** Bun test, TypeScript, Drizzle SQLite/libSQL, Hono, existing WebSocket manager.

## Global Constraints

- Tests run with isolated `.data-test` state through `bun run test`.
- Detector staleness requires `sessions.rawFile IS NOT NULL`.
- Detector current IDs are `LAP_DETECTOR_ID`, `LAP_DETECTOR_ACC_ID`, `LAP_DETECTOR_AC_EVO_ID`, and `LAP_DETECTOR_IRACING_ID`.
- Result staleness means missing `session_results` or `processorVersion !== RACE_RESULT_PROCESSOR_ID`.
- Do not change reconcile menu copy, layout, or client behavior.

---

### Task 1: Cover lap-detector stale-version query behavior

**Files:**
- Modify: `test/session-capture/raw-binary-storage.test.ts:269-322`
- Modify: `server/db/session-queries.ts:66-98` only if a query assertion exposes a defect

**Interfaces:**
- Consumes: `countStaleSessions(currentIds)` and `getStaleSessions(currentIds)`.
- Produces: deterministic coverage proving current, old, null, and no-raw-file rows.

- [ ] **Step 1: Add old-version and ID-list assertions**

Insert sessions with raw files stamped `lapdetector_v0`, `null`, and the active `lapdetector_v1`; assert count increases only for old/null rows and `getStaleSessions` contains those IDs, not the active/no-raw IDs.

- [ ] **Step 2: Run focused test**

Run: `bun test test/session-capture/raw-binary-storage.test.ts --timeout 30000`
Expected: PASS. If behavior differs, retain the test as the contract and make the smallest query fix.

- [ ] **Step 3: Commit**

```sh
git add test/session-capture/raw-binary-storage.test.ts server/db/session-queries.ts
git commit -m "test: cover stale lap detector versions"
```

### Task 2: Include resultless sessions in stale-result queries

**Files:**
- Modify: `server/db/session-result-queries.ts:207-224`
- Modify: `test/race-results/race-results-storage.test.ts:83-120`

**Interfaces:**
- Consumes: `sessions.id`, `sessionResults.sessionId`, `countStaleRaceResults`, and `getStaleRaceResultSessionIds`.
- Produces: stale result count/ID queries that include every session lacking a result and older-version result rows, while excluding current rows.

- [ ] **Step 1: Add failing resultless-session assertions**

Create a session with no `session_results` row alongside old/current result fixtures. Assert the stale count increases by two and returned IDs contain the old and resultless session IDs only.

- [ ] **Step 2: Run focused test to confirm failure**

Run: `bun test test/race-results/race-results-storage.test.ts --timeout 30000`
Expected: FAIL because current queries only scan `session_results`.

- [ ] **Step 3: Implement left-join stale queries**

Start from `sessions`, left join `sessionResults` on `sessionResults.sessionId = sessions.id`, select session IDs, and filter `sessionResults.id IS NULL OR sessionResults.processorVersion != currentProcessorVersion`. Return the same ordered ID list and count semantics.

- [ ] **Step 4: Run focused test**

Run: `bun test test/race-results/race-results-storage.test.ts --timeout 30000`
Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add server/db/session-result-queries.ts test/race-results/race-results-storage.test.ts
git commit -m "fix: detect sessions without race results"
```

### Task 3: Reconcile resultless sessions through endpoint

**Files:**
- Modify: `test/race-results/race-results-storage.test.ts:122-145`
- Modify: `server/routes/session-routes.ts:48-70` only if endpoint handling fails after Task 2

**Interfaces:**
- Consumes: `getStaleRaceResultSessionIds`, `reconcileSessionResult`, and `RACE_RESULT_PROCESSOR_ID`.
- Produces: endpoint coverage that resultless stale sessions are reconciled and stamped current.

- [ ] **Step 1: Extend endpoint fixture**

Insert one old-version result session and one session with no result. POST `/api/race-results/reconcile-stale`; assert HTTP 200 and both sessions have current processor-version results afterward.

- [ ] **Step 2: Run focused test**

Run: `bun test test/race-results/race-results-storage.test.ts --timeout 30000`
Expected: PASS.

- [ ] **Step 3: Commit**

```sh
git add test/race-results/race-results-storage.test.ts server/routes/session-routes.ts
git commit -m "test: reconcile sessions without stored results"
```

### Task 4: Verify startup notification contracts

**Files:**
- Create: `test/runtime/stale-session-jobs.test.ts`
- Modify: `server/runtime/startup-jobs.ts` only if notification behavior is incorrect
- Modify: `server/runtime/websocket-manager.ts` only if a minimal read-only test seam is required

**Interfaces:**
- Consumes: `startSyncAndStaleSessionJobs`, active detector IDs, `RACE_RESULT_PROCESSOR_ID`, and websocket notification setters.
- Produces: exact notification type/count/currentVersion assertions for stale and all-current fixtures.

- [ ] **Step 1: Establish test capture before importing startup jobs**

Mock or spy the two websocket setter methods and the unrelated sync/compressor starters. Use unique database fixtures and await a microtask/timer boundary after invoking `startSyncAndStaleSessionJobs` so both count promises settle.

- [ ] **Step 2: Add stale detector notification test**

Seed one raw session with an old detector version and one raw session with null detector version. Assert one `stale-lap-detection` payload with sessionCount 2 and the joined active detector IDs.

- [ ] **Step 3: Add stale result notification test**

Seed one old result and one resultless session. Assert one `stale-race-results` payload with sessionCount 2 and `currentVersion === RACE_RESULT_PROCESSOR_ID`.

- [ ] **Step 4: Add all-current/no-notification test**

Seed only active detector/current result rows (and no resultless session). Assert neither stale setter receives a non-null payload.

- [ ] **Step 5: Run focused test**

Run: `bun test test/runtime/stale-session-jobs.test.ts --timeout 30000`
Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add test/runtime/stale-session-jobs.test.ts server/runtime/startup-jobs.ts server/runtime/websocket-manager.ts
git commit -m "test: cover stale reconciliation notifications"
```

### Task 5: Run verification suite

**Files:**
- No source changes expected.

- [ ] **Step 1: Run affected tests together**

Run: `bun test test/session-capture/raw-binary-storage.test.ts test/race-results/race-results-storage.test.ts test/runtime/stale-session-jobs.test.ts --timeout 30000`
Expected: PASS.

- [ ] **Step 2: Run full server test suite**

Run: `bun run test`
Expected: PASS with no new failures.

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit any final test-only corrections**

```sh
git add server test
 git commit -m "test: verify reconciliation version menu triggers"
```
