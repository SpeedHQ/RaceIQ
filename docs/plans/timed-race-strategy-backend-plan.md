# Timed race strategy backend implementation

Boundary: [shared contract](timed-race-strategy-contract.md). Paired [UI plan](timed-race-strategy-ui-plan.md). Backend/shared owner implements the contract independently; coordinator owns integration verification and cross-boundary decisions.

## Ownership and tasks

Backend/shared scope owns `shared/racing/live/race-plan.ts`, `server/db/race-plan-queries.ts`, and `apps/backend/test/live-strategy/race-plan.test.ts`. Existing routes already consume shared schemas. No database migration is needed for fields in JSON payload. Do not edit UI, locale catalogs, existing compact-panel changes, or unrelated transaction logic.

1. Extend shared types and strict schemas with optional discriminated raceLength and legacy lap normalization. Export the agreed bounded estimator; enforce finite positive duration/pace and exact derived totalLaps in time mode. Preserve existing source, ownership, ordering, and fuel validation. T1, T4.
2. Verify normalized mode, duration, and pace survive existing create/update/list/active JSON persistence. Existing payloads without raceLength read as lap mode. Reject inconsistent timed input without changing saved state. Coordinate all race-plan mutations with the existing database write lease so live ingestion cannot cause SQLITE_BUSY; retain atomic rollback and original domain-error identities for existing HTTP mappings. T2, T4.
3. Extend behavioral backend regressions for exact/partial rounding, limits, invalid time/pace/lap mismatch, legacy reads, persistence, and rejected-update immutability. Do not run tests/build/lint/formatters while implementation is in flight; coordinator runs gates after edits settle.

## Acceptance, edges, and E2E

T1/T4 map to E1/E4, T2 to E2, existing evidence/fuel invariants supporting T3 to E3, and production route integration T5 to E5 in the shared contract. Edge strategies are defined there: legacy omission normalizes to laps, invalid/oversized time returns null in the helper and 400 at HTTP, inconsistent stops/laps are rejected, zero/null fuel semantics remain unchanged. Coordinator extends and executes `playwright/tests/seeded/strategy/race-plan.spec.ts` through existing StrategyRuntime/native ingestion and production routes/SQLite. Isolated backend tests and typecheck supplement, not replace, passing E1–E5 integration evidence.

## Verification outcome

Verified 2026-10-21:

- E1–E5/T1–T5 passed through real native ingestion, UI, existing production routes, SQLite, and backend restart. [Timed acceptance artifacts](../../playwright/test-results/timed-strategy-acceptance/). Time/lap consistency, positive/bounded inputs, ordered stops, and rejected-update immutability were exercised through actual HTTP requests.
- R1–R8 lifecycle, identity, retry, save-lock, and compatibility scenarios passed in four tests. [Lifecycle artifacts](../../playwright/test-results/timed-strategy-lifecycle/). The save-lock scenario originally exposed SQLITE_BUSY under live ingestion; it passed after all race-plan mutations joined the existing write lease. Domain errors remain unwrapped for existing HTTP mappings.
- Six race-plan backend tests passed, covering the estimator, persistence, invalid updates, existing source rules, and legacy normalization. [Targeted backend output](../../playwright/test-results/timed-strategy-backend-targeted.log).
- `bun run typecheck`: 33/33 packages passed after final production edits; changed-path oxlint passed. [Gate output](../../playwright/test-results/timed-strategy-typecheck-lint.log).
- `bun --filter @raceiq/backend test:integration`: 2991 passed, four skipped, one failed, with an associated worker-exit error after the five-second timeout in `live-worker-catchup.test.ts`. [Full output](../../playwright/test-results/timed-strategy-backend-integration.log). The first targeted rerun overlapped browser verification and both worker cases timed out; no timeout or assertion was changed.
- After other gates stopped, `bun test --preload ./server/test-support/setup-data-dir.ts --preload ./apps/backend/test/support/setup-app.ts --max-concurrency=1 apps/backend/test/session-capture/live-worker-catchup.test.ts` passed both cases with 38 assertions. [Serial worker output](../../playwright/test-results/timed-strategy-backend-worker-serial.log). This resolves the failed cases in isolation, not a claim that the full-suite invocation itself passed.
- Controlled liter/zero/unknown fixture writes now occur only while the disposable backend is stopped, with restart before real API/browser assertions; initial fixture lock/identity-cleanup failures are not treated as product passes.
