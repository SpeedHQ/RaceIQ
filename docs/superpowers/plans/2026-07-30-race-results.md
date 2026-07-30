# Race and Stint Result Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one persisted, provenance-aware race-result contract with ordered pit events, deterministic historical reconciliation, typed APIs, aggregates, and UI summaries across all supported games.

**Architecture:** Keep game-neutral result DTOs and pure derivation in `server/race-results/`. Game adapters expose only source extraction. Store one `session_results` row and ordered `pit_events` children, then query through shared aggregate functions used by every surface. Reconciliation is the single write path for both completed live sessions and historical backfill.

**Tech Stack:** Bun, TypeScript, Drizzle query builder, SQLite hand-rolled migrations, Hono RPC, React 19, TanStack Query, Tailwind/shadcn, Bun tests.

## Global Constraints

- Hand-rolled SQL in `server/db/migrations.ts` is runtime migration source of truth; never use `db:push`.
- No dynamic imports.
- `gameId` is mandatory for scoped API calls; never fall back to `fm-2023`.
- Unknown source values stay `null`/`unknown`; absence never creates an inferred event.
- All aggregate queries apply game scope before identity filters.
- Reconciliation is bounded, deterministic, idempotent, and reports skipped/ambiguous records.
- Existing sessions without raw telemetry remain valid.

---

### Task 1: Persist result and pit-ledger rows

**Files:**
- Modify: `server/db/schema.ts` after `sessions`/`laps` declarations
- Modify: `server/db/migrations.ts` append migration v48
- Modify: `server/db/queries.ts` add result/pit insert, upsert, and read helpers
- Create: `test/race-results-storage.test.ts`

**Interfaces:**
- Produces `sessionResults`, `pitEvents`, `RaceResultRow`, and stable helpers `upsertSessionResult(input)`, `replacePitEvents(resultId, events)`, `getSessionResult(sessionId, gameId)`.
- `upsertSessionResult` must use `session_id` uniqueness and return whether the row changed.
- `replacePitEvents` must delete/reinsert only for the target result inside one transaction and preserve sequence order.

- [ ] Write failing storage tests for migration shape, one result per session, stable rerun, ordered events, and game mismatch rejection.
- [ ] Add Drizzle schema columns for session type/classification, positions, flags, pit count, strategy JSON, provenance, unresolved reasons, timestamps; add child event columns for lap/time/duration/service/tyres/fuel/linkage/raw source.
- [ ] Add migration v48 with `CREATE TABLE IF NOT EXISTS`, indexes, foreign key cascade, and unique `(result_id, sequence)`.
- [ ] Implement typed JSON serialization/parsing and numeric/null normalization in query helpers.
- [ ] Run `bun test --timeout 60000 test/race-results-storage.test.ts` and require PASS.
- [ ] Commit `feat: persist race result metadata`.

### Task 2: Implement pure shared result derivation

**Files:**
- Create: `server/race-results/types.ts`
- Create: `server/race-results/derive.ts`
- Create: `server/race-results/pit-ledger.ts`
- Create: `test/race-results-derive.test.ts`
- Create: `test/pit-ledger.test.ts`

**Interfaces:**
- `RaceSessionInput`: `{ gameId, sessionId, sessionType, laps, sourcePackets }`.
- `deriveRaceResult(input): DerivedRaceResult`.
- `derivePitLedger(input): { events, pitCount, reasons }`.
- `DerivedRaceResult` contains normalized status, nullable positions/flags, strategy summaries, source rules, and reason codes.

- [ ] Add tests for practice/qualifying/race/other/unknown normalization, finished/DNF/retired/qualifying/unknown classification, podium boundaries 1/3/4, fastest-lap source provenance, and no-inference null behavior.
- [ ] Add pit tests for ordered multiple stops, tyre-only, fuel-only, combined, unknown-service, pit-with-no-service, and unlinked tyre/fuel observations.
- [ ] Implement pure functions over normalized source observations; do not access SQLite or decode packets here.
- [ ] Ensure fuel added and fuel level are separate fields and never derived from one another.
- [ ] Run both focused test files and require PASS.
- [ ] Commit `feat: derive race result contracts`.

### Task 3: Add per-game source extraction

**Files:**
- Create: `server/race-results/source.ts`
- Modify: `server/games/types.ts` to add optional result-source extractor contract
- Modify: `server/games/fm-2023/index.ts`
- Modify: `server/games/f1-2025/index.ts`
- Modify: `server/games/acc/index.ts`
- Modify: `server/games/ac-evo/index.ts`
- Modify: `server/games/iracing/index.ts`
- Create: `test/race-results-source.test.ts`

**Interfaces:**
- `extractRaceSource(gameId, packets): RaceSourceObservation` returns explicit values only.
- `RaceSourceObservation` includes session type, classification/position candidates, fastest-lap candidates, pit transitions, tyre changes, fuel values, and provenance/reason codes.
- Existing parsers remain unchanged unless a source field is already decoded but not exposed.

- [ ] Add fixtures using existing normalized telemetry shapes for each adapter and assert supported fields plus explicit unknowns.
- [ ] Map F1 grid/session history fields, ACC shared-memory session/pit/fuel/tyre fields, AC Evo session/pit fields, iRacing SDK fields, and Forza fields only where their packet contract is explicit.
- [ ] Register extractors statically in the existing game adapters.
- [ ] Keep unsupported fields out of derivation rather than guessing from lap validity or lap count.
- [ ] Run focused source tests and require PASS.
- [ ] Commit `feat: extract game race result sources`.

### Task 4: Build reconciliation and live-session integration

**Files:**
- Create: `server/race-results/reconcile.ts`
- Modify: `server/routes/session-routes.ts` add session-result and backfill endpoints
- Modify: session completion path identified by existing session/lap finalization code to call `reconcileSessionResult`
- Modify: `server/routes.ts` only if route composition requires registration
- Create: `test/race-results-reconcile.test.ts`
- Create: `test/race-results-routes.test.ts`

**Interfaces:**
- `reconcileSessionResult(sessionId, opts?): Promise<ReconcileSessionReport>`.
- `backfillRaceResults(opts: { gameId: GameId; limit: number; afterSessionId?: number }): Promise<BackfillReport>`.
- `ReconcileSessionReport` reports `enriched | unchanged | skipped | ambiguous | error`, reason codes, and event counts.

- [ ] Add tests for empty/legacy sessions, decode failures, bounded batches, deterministic reports, repeated runs without duplicate rows, and mandatory game scope.
- [ ] Implement one decode pass per available raw session, normalize sources, derive result/ledger, and atomically upsert.
- [ ] Preserve raw source payload/provenance on every write and replace only deterministically owned event rows.
- [ ] Add `GET /api/sessions/:id/result?gameId=...` and `POST /api/race-results/backfill` with existing Hono validation conventions.
- [ ] Call reconciliation from the existing completed-session path; avoid duplicate background workers.
- [ ] Run focused reconciliation/route tests and require PASS.
- [ ] Commit `feat: reconcile historical race results`.

### Task 5: Add shared aggregate query/API contract

**Files:**
- Create: `server/race-results/aggregates.ts`
- Modify: `server/routes/session-routes.ts` or create `server/routes/race-result-routes.ts` for summary endpoints
- Modify: `server/routes.ts` route composition
- Modify: `shared/types.ts` for client-visible DTOs if shared types are the established contract
- Create: `test/race-results-aggregates.test.ts`

**Interfaces:**
- `getRecentRaceResults(gameId, limit)`.
- `getDriverRaceResultSummary(gameId)`.
- `getCarRaceResultSummary(gameId, carOrdinal)`.
- `getTrackRaceResultSummary(gameId, trackOrdinal)`.
- Every summary returns finished/DNF/qualifying/unknown counts, podium/fastest-lap counts, positions, pit totals/duration, tyre strategy, fuel strategy, and explicit availability flags.

- [ ] Add multi-game fixture tests proving no cross-game leakage and correct null/unknown aggregation.
- [ ] Implement SQL aggregates over `session_results`/`pit_events` with stable ordering and bounded result lists.
- [ ] Expose typed Hono endpoints consumed through `client/src/lib/rpc.ts`; avoid raw fetch.
- [ ] Run aggregate and route tests and require PASS.
- [ ] Commit `feat: expose race result aggregates`.

### Task 6: Enrich Home and session result surfaces

**Files:**
- Modify: `client/src/routes/index.tsx` or current Home container discovered during implementation
- Modify: `client/src/routes/$gameid/sessions.tsx`
- Create: `client/src/components/race-results/ResultStatusBadge.tsx`
- Create: `client/src/components/race-results/ResultSummary.tsx`
- Create: `client/src/components/race-results/PitLedger.tsx`
- Create: `client/src/lib/race-results.ts`
- Create: `client/src/components/race-results/ResultSummary.test.tsx`

**Interfaces:**
- Components consume `RaceResult`/aggregate DTOs only; no page-local calculations.
- Unknown is rendered separately from zero and status labels are Finished, DNF, Retired, Qualifying, Unknown.

- [ ] Add component tests for each status, podium/fastest-lap flags, no-data strategy, and ordered pit ledger.
- [ ] Add typed TanStack Query hooks using Hono RPC.
- [ ] Render recent results/highlights on Home and per-session result context in session history.
- [ ] Render pit count/duration/tyre/fuel only when availability flags support them.
- [ ] Run client component tests and `cd client && bun run build`.
- [ ] Commit `feat: show race results on home and sessions`.

### Task 7: Enrich Driver, Car, and Track surfaces

**Files:**
- Modify: `client/src/routes/$gameid/driver.tsx`
- Modify: `client/src/routes/$gameid/cars.tsx` and car detail route discovered from route tree
- Modify: `client/src/routes/$gameid/tracks.$trackOrdinal.$tab.tsx` and/or track detail container
- Create: `client/src/components/race-results/ResultAggregateGrid.tsx`
- Create: `client/src/components/race-results/StrategySummary.tsx`
- Create: `client/src/components/race-results/ResultAggregateGrid.test.tsx`

**Interfaces:**
- All pages use the aggregate hooks from Task 6 and the same shared components.
- Game scope is inherited from `GameProvider`/route game id and sent as `X-Game-Id` or existing RPC query contract.

- [ ] Add tests for driver breakdown, car/track breakdown, qualifying-to-race movement, pit totals, tyre/fuel strategy, and multi-game scope.
- [ ] Render result distributions, podium/fastest-lap counts, DNF history, qualifying movement, pit activity, tyre usage, and fuel usage.
- [ ] Render explicit unavailable state where source data cannot support a metric.
- [ ] Run client tests and `cd client && bun run build`.
- [ ] Commit `feat: add race result aggregates to detail pages`.

### Task 8: Release documentation and full verification

**Files:**
- Modify: `CHANGELOG.md` under `## Unreleased` / `### Features`
- Modify: `docs/superpowers/specs/2026-07-30-race-results-design.md` only if implementation decisions materially change it
- Modify: `docs/superpowers/plans/2026-07-30-race-results.md` to check completed steps

- [ ] Run `bun test --timeout 60000` and require zero failures.
- [ ] Run `cd client && bun run build` and require success.
- [ ] Run `bun test test/changelog.test.ts --timeout 60000`.
- [ ] Exercise backfill against a temporary database and verify rerun report is unchanged and event count does not grow.
- [ ] Add concise user-visible changelog entry.
- [ ] Commit `docs: document race result metadata`.
