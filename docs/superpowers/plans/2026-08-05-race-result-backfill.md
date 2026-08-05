# Automatic Race Result Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconcile all historical sessions automatically after server startup so races created before persisted race-result processing receive metadata.

**Architecture:** Reuse `backfillRaceResults` as the bounded per-game worker. Add an all-game startup coordinator that walks registered server adapters in batches of 100, yields between batches, logs progress, and runs after HTTP server startup so existing users are not blocked. Processor-version checks keep reruns idempotent; the existing manual endpoint remains available for targeted retries.

**Tech Stack:** Bun, TypeScript, Hono, Drizzle/SQLite, Bun test.

## Global Constraints

- Do not make normal GET endpoints mutate database state.
- Process every registered game adapter, not just selected game.
- Use batch size 100 and `afterSessionId` cursor.
- Startup backfill must run in background after server begins listening.
- Preserve existing manual backfill endpoint.
- No new dependencies.

---

### Task 1: Add tested all-game backfill coordinator

**Files:**
- Modify: `server/race-results/reconcile.ts`
- Test: `test/race-results-storage.test.ts`

**Interfaces:**
- Consumes existing `backfillRaceResults({ gameId, limit, afterSessionId })`.
- Produces `backfillAllRaceResults(): Promise<void>` that processes every registered server game in ascending session-ID batches.

- [ ] **Step 1: Write failing test**

Add a test that inserts historical sessions for two supported game IDs, calls the all-game coordinator, and asserts both sessions receive `RACE_RESULT_PROCESSOR_ID` results.

- [ ] **Step 2: Run targeted test and verify expected failure**

Run `bun test test/race-results-storage.test.ts`. Expected failure: all-game coordinator is not exported.

- [ ] **Step 3: Implement coordinator**

Import `getAllServerGames` from `server/games/registry`. For each adapter ID, repeatedly call `backfillRaceResults({ gameId, limit: 100, afterSessionId })`, advance the cursor to the greatest processed session ID, stop on fewer than 100 processed sessions, and yield with `await Bun.sleep(0)` between batches. Log per-game counts. Catch per-game errors, log them, and continue with remaining games.

- [ ] **Step 4: Run targeted tests and verify pass**

Run `bun test test/race-results-storage.test.ts`. Expected: all storage tests pass, including both historical games being reconciled.

- [ ] **Step 5: Commit**

Run `git add server/race-results/reconcile.ts test/race-results-storage.test.ts && git commit -m "feat: add all-game race result backfill"`.

### Task 2: Start backfill after HTTP startup

**Files:**
- Modify: `server/index.ts`

**Interfaces:**
- Consumes `backfillAllRaceResults()`.
- Produces background startup invocation after `Bun.serve` returns.

- [ ] **Step 1: Add startup invocation**

Import `backfillAllRaceResults` and call it after the server is listening using `void backfillAllRaceResults().catch(...)`. Do not await it before `Bun.serve`; log failures without terminating the server.

- [ ] **Step 2: Run build and targeted tests**

Run `bun run build && bun test test/race-results-storage.test.ts test/race-results-derive.test.ts test/race-results-source.test.ts`. Expected: build succeeds and all targeted tests pass.

- [ ] **Step 3: Commit**

Run `git add server/index.ts && git commit -m "feat: backfill race results on startup"`.

### Task 3: Verify and push

**Files:**
- No source changes expected.

- [ ] **Step 1: Run verification**

Run `git diff --check`, `bun run build`, and the targeted race-result test set. Expected: no diff errors, successful build, all tests pass.

- [ ] **Step 2: Push branch**

Run `git push origin feat/issue-181-race-results`.

- [ ] **Step 3: Confirm PR state**

Run `gh pr view 197 --repo SpeedHQ/RaceIQ --json headRefName,headRefOid,mergeable,state`. Expected: correct branch, open PR, mergeable status.
