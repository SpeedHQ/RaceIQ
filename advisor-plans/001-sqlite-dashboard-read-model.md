# Plan 001: Make historical dashboards correct and scalable on the existing SQLite database

> Executor: this is a proposed implementation plan, not implemented functionality. Follow phases in dependency order; complete each phase's verification before cutover. Read root project instructions. Preserve unrelated working-tree edits. No database-engine replacement, production database reset, or raw-recording rewrite is authorized.
>
> Drift check: `git diff --stat 466c5501b..HEAD -- server/db server/session-capture server/race-results server/telemetry apps/backend/src/routes apps/backend/src/runtime client/src/components/home client/src/hooks shared/racing/sessions`. Also inspect uncommitted changes in these scopes; the commit comparison alone does not capture working-tree drift. Compare the excerpts below with current source. Expected changes introduced by earlier phases are not drift.

## Status and architecture

- Priority: P1; category: correctness/performance/migration.
- Effort: L; risk: HIGH for aggregate correctness and concurrent publication, MED for indexed read cutover.
- Planned at: commit `466c5501b`, 2026-10-09, with working-tree source inspected during planning.
- Status: IN PROGRESS. Phases 1–4 and Phase 5 runner/startup-repair implementation are committed; Phase 5 acceptance remains incomplete. Do not mark DONE until every named gate below passes, including supported-Windows recording and browser acceptance.


### Execution status (2026-10-09)

Archive timing, scale smoke and recording figures below predate monthly migration v67. They are retained historical evidence, not validation of the current monthly producer/read path.

- Phases 1–3 and Phase 4 implementation are present in commits `9bbf92736`, `aba65c8dd`, `b40771e1`, and `41ae9e00`. Phase 4 focused query tests and backend typecheck/lint/test shards/unit/tooling/locale/catalog gates passed.
- Phase 4 Hono I/O evidence: `.omp/evidence/sqlite-dashboard/phase4-endpoint-io-after-completeness.json` (GET 10 SQL statements / 8,512 bytes; recap 3 SQL statements; zero recording/parser calls).
- Phase 4 runtime and completeness evidence: `.omp/evidence/sqlite-dashboard/phase4-runtime-final.json`, `.omp/evidence/sqlite-dashboard/phase4-metadata-completeness-ui.json`. Desktop/mobile, period, and refresh scenarios were observed; isolated loading-only/final-console browser acceptance remains unverified because available page-only capture routes timed out. No desktop authorization.
- Phase 5 committed implementation: runner/cursor repair `ca5ee139`, favourite podium/oracle correction `b19517e8`, retry-column repair `1806e446`, recorder-runner repair `41aed132`. Optimized-query scale correctness smoke passed all three shapes (100k standard, 1M standard, 1M boundary-heavy), including independent dashboard/recap comparisons, complete metadata, ten aggregate SQL statements, four recap statements, and payloads below 128 KiB. Evidence: `.omp/evidence/sqlite-dashboard/phase5-scale-smoke-optimized.log`. Single-request times are not p95 acceptance results.
- Post-remediation timing acceptance failed at the 100k standard weekly aggregate. Evidence: `.omp/evidence/sqlite-dashboard/phase5-timing-optimized.log`; earlier monthly failure retained in `phase5-timing-oracle-fixed.log`. No budgets weakened; the plan's STOP condition applies.
- Corrected actual-recorder control completed with all 11,912 ordered UDP payloads matching, four persisted writes visible within 383 ms, complete metadata on every observed response, and matching final recap fields. Request-only RSS failed, so the runner stopped before 100k/1M contention scenarios; no full recording/backfill acceptance is claimed. Full failed-scenario evidence: `.omp/evidence/sqlite-dashboard/phase5-contention-final.json` and `phase5-contention-final.log`. Earlier benchmark-only SQL, open-stdin and legacy-reader defects are corrected; diagnostic evidence retained in `recording-runner-lifecycle-diagnosis.json` and `recording-timestamp-reader-control.log`.
- Favourite podium evidence now merges canonical summary and partial-day source identities without an extra SQL statement. Real Bun/libSQL query regressions cover absent, confirmed zero and positive podiums, native strings, ordinal zero, game scope and excluded ownership. The independent oracle keeps all-game brand cards on game-scoped requests. Focused query gate: 21 passed, 219 assertions. Evidence: `.omp/evidence/sqlite-dashboard/podium-optimized-query-tests.log`.
- Final query/oracle and v66 repair gates passed: 30 focused tests / 373 assertions, root typecheck, root lint (zero warnings/errors), and 11 changelog checks. Evidence: `.omp/evidence/sqlite-dashboard/retry-repair-targeted-tests.log`, `retry-repair-root-typecheck.log`, `retry-repair-root-lint.log`, and `retry-repair-changelog-test.log`. The earlier `TS2589` failure is preserved at `podium-root-typecheck.log`; no cause is claimed for its disappearance.
- Recorder-runner repair commit hooks passed root typecheck, lint, unit/tooling, shard assignment, locale and telemetry-catalog gates. Evidence: `.omp/evidence/sqlite-dashboard/recording-runner-commit.log`. Final changelog check: 11 passed, evidence `recording-runner-changelog-tests.log`. No production UDP/recorder benchmark instrumentation was added.
- Backend integration remains failed: 2,658 passed, four skipped, 19 failed, two errors. Prior isolated diagnosis located the six-capture migration timeout and subsequent SQLite lock cascade; no migration optimization has been applied. Evidence: `.omp/evidence/sqlite-dashboard/phase5-integration-diagnosis.txt`.
- Supported-Windows recording and isolated loading-only/final-console browser acceptance remain unverified; no Windows target or restored authorized page-only surface is available. Cadence evidence alone does not satisfy recording acceptance.
- Phase 5 boundary-overflow regression is fixed: production Hono returned HTTP 200 with 150/150 clean, ready sessions, `metadataComplete=true`, complete status, 300 laps, 27,300 seconds, best 90, average 91; third session outside the interval was excluded. Evidence: `.omp/evidence/sqlite-dashboard/phase5-boundary-fixed.json` and `.omp/evidence/sqlite-dashboard/phase5-boundary-regression.log`; focused query tests: 20 passed, 0 failed, 111 expectations. Original failure evidence remains at `.omp/evidence/sqlite-dashboard/phase5-boundary-overflow-repro.json` and its matching log.
- User-reported startup failure `no such column: st.next_retry_at` is addressed by appended migration v66, which repairs retry count, deadline and success-history columns without replacing existing values. Already-applied and fresh migration regressions passed; two production boots published the fixture with complete dashboard metadata and unchanged session/lap source rows. Evidence: `.omp/evidence/sqlite-dashboard/retry-repair-migration-tests.log` and `retry-repair-runtime.log`. No historical migration or production database was rewritten.
- Monthly rollup correctness is implemented with appended migration v67, stable pooled moments, atomic correction/deletion/ownership updates, and disjoint indexed daily boundary ranges. Historical complete months also use monthly grain; routing is capped to the requested interval and reserves the latest 30 days relative to the later of wall clock and request end. Exact source and daily history remain retained.
- Current monthly regressions passed: 47 tests / 533 assertions, including v66 upgrades, leap February, historical month bounds, dirty corrections before/after publication, and clean/dirty favourite session membership. Evidence: `.omp/evidence/sqlite-dashboard/monthly-final-regressions.log`; original favourite-count counterexample: `monthly-membership-regression-before.json`.
- Depends on: none; phases below have explicit dependencies.
- ADR: [SQLite dashboard read model](../docs/adr/0010-sqlite-dashboard-read-model.md).
- Index: [Execution status](README.md).

| Failed acceptance gate | Observed | Required |
| --- | ---: | ---: |
| 100k weekly aggregate warm p95 | 425.10 ms | ≤150 ms |
| Clean-finalization request-only incremental RSS | 85.875 MiB | ≤64 MiB |

## Goal and non-negotiable requirements

Main dashboard and every per-game dashboard must report the full selected period accurately, independent of the generic lap-list limit. They must use the existing `<DATA_DIR>/app.db`, Bun/libSQL connection, Drizzle schema, and embedded SQLite migrations. Dashboard reads must not parse, decompress, or stat raw recording files. Historical data must remain intact; derived summaries must be disposable and rebuildable. Reads and backfill must coexist with live recording and imports without lost updates or visible partial summaries.

The deliverable includes all existing dashboard metrics, all-game brand cards on game pages, recent sessions, heatmap, chart trends, and latest-session recap. This is not a totals-only replacement. It includes coverage for inserts, corrections, reprocessing, deletes, result reconciliation, import rollback, restart, processor-version changes, and concurrent reads.

**User-required ownership rule:** include only sessions explicitly stored as `ownership='mine'` everywhere: totals, all-game cards, heatmap, trends, favourites, distinct counts, session-type shares, consistency, recent sessions, latest-session selection, recap and historical best/sector comparisons. Apply the predicate before aggregation, ranking and LIMIT, not afterward in the browser. `others`, null and unknown ownership do not qualify; do not use `ownership != 'others'` or normalize arbitrary values into mine. Existing released migrations that already assign mine to historical sessions remain authoritative; this change does not relabel ambiguous source rows.

**UTC requirement:** recording/acquisition timestamps and persisted source timestamps remain UTC. Never shift recording timestamps, rewrite recordings, or persist browser-local wall time. Existing dashboard membership uses stored lap/session `createdAt`, interpreted as UTC; recording frame acquisition timestamps are a separate clock and must not silently replace `createdAt` for imported recordings. Dashboard calendar aggregation and request bounds use fixed UTC days; browser-local timezone is presentation-only for labels.

**Invalidation decision:** use lightweight SQLite triggers for durable source-change revision/dirty bookkeeping, with Bun processing and transactional compare-and-publish. Do not add the Effect npm package, a second queue framework, or heavyweight trigger aggregation. Triggers cover direct SQL as well as ordinary query helpers; application integration remains necessary for recording-file-only changes and client notifications.

Out of scope: PostgreSQL/DuckDB/Redis for dashboard storage; new external service; packet parser or recording format changes; retention changes; AI analysis rewrites; broad UI redesign; blanket replacement of general lap/session endpoints; speculative indexes for unrelated queries. Do not increase `getLaps` limits as the fix. Do not add a second database connection stack.

## Current state and verified evidence

Main `/` and game roots such as `/acc/` mount `HomePageContainer`. Relevant source:

```tsx
// client/src/components/home/HomePageContainer.tsx:22-23
const { data: allLaps = [], isLoading: lapsLoading, isError: lapsError } = useLaps({ allGames: true });
const { data: sessions = [], isLoading: sessionsLoading, isError: sessionsError } = useSessions({ allGames: true });
```

```ts
// server/db/lap-read-queries.ts:72,115-116
export async function getLaps(gameId?: GameId, limit: number = 200, sessionId?: number): Promise<LapMeta[]> {
// ...
.orderBy(sessionId != null ? laps.lapNumber : desc(laps.id))
.limit(sessionId != null ? 1_000_000 : limit);
```

- `HomePageContainer.tsx:27-44,88-118`: client-local today, rolling 7/30/365 days, filtering after fetch, sorting sessions and taking ten, ordinal-only distinct counts in period summary.
- `client/src/components/home/dashboard-insights.ts:76-89,204-390`: game-scoped native identities, ownership filtering, positive-time clean trend, podium rules, top-five distribution, per-session population standard deviation, elapsed-duration session-type shares, favourites and distance coverage.
- `client/src/components/home/HomePageView.tsx:115-136`: brand cards, insight panels, recent sessions and activity heatmap share these lists.
- `server/db/session-queries.ts:283-402`: unlimited session rows; shared capture lookup; sequential elapsed-duration processing; per-session lap/result/pit queries.
- `server/session-capture/elapsed-duration.ts:6-8,17-101`: recording-frame iteration with a 128-entry in-process cache.
- `server/db/session-queries.ts:414-559`: latest recap fetches session laps, may decode native-sector telemetry, reads historical valid sector arrays and best lap excluding current session.
- `apps/backend/src/routes/session-routes.ts:57-94`: recap weather can decode a lap.
- `server/db/lap-mutation-queries.ts`: ordinary insert, validity edit, transient delete, regular delete, and persisted fuel/wear metrics.
- `server/db/lap-reprocessing-queries.ts` and `server/session-capture/reprocess.ts:137-195`: in-place updates or delete/reinsert replacement.
- `server/session-capture/import-pipeline.ts:190-209`: waits for pending writes; rollback deletes inserted sessions.
- `server/db/session-result-queries.ts`, `server/race-results/reconcile.ts`: persisted classification/results and pit updates must participate in invalidation.
- `client/src/hooks/useWebSocket.ts:126-128,169-172`: lap saves invalidate lap lists, not session lists; reprocessing invalidates both.
- `server/db/index.ts:52-80`: existing libSQL/Drizzle client; WAL, foreign keys, five-second busy timeout.

Existing index coverage: `laps(session_id)`, experiment indexes; `sessions(game_id,car_id)` and `sessions(game_id,track_id)`; result session and pit result indexes. There are no timestamp dashboard indexes or materialized dashboard summaries in the inspected scope.

Audit evidence: local DB had 32 laps and nine sessions. Disposable SQL smoke with current table definitions demonstrated 205 laps (five ACC followed by 200 iRacing) returning zero ACC laps to the dashboard. Python SQLite query plans showed a raw-file scan and timestamp sorting; proposed timestamp/raw-file indexes removed those operations in a disposable DB. These are correctness/plan checks, not Bun/libSQL or large-database latency measurements. `bun run typecheck` passed before this documentation-only plan. HTTP endpoint smoke could not run: localhost port 3117 refused connections.

### Repository patterns to reuse

- Persist through responsibility-scoped `server/db/*-queries.ts`; raw recordings remain authoritative replay sources (`server/db/README.md:15-21`).
- Change `server/db/schema.ts` plus a new final version in `server/db/migrations.ts`. Never rewrite historical migrations or use `db:push` for rollout.
- Hono routes use `zValidator`; client uses typed Hono RPC, React Query and existing game-context conventions. Match `apps/backend/src/routes/session-routes.ts:53-60` and `client/src/hooks/session-queries.ts:10-29`.
- `server/race-results/aggregates.ts:9-10` already documents the intended pattern: results are materialized on completion/backfill, not derived by GET.
- Preserve source-defined sectors; do not assume three sectors or reinterpret native channels.
- Static imports only. Avoid temporary aliases or duplicate legacy implementations after caller migration.
- Reuse the current UI and translations; changed visible copy must update every supported locale.

## Scope and proposed files

Existing files allowed when directly needed:

- `server/db/{schema,migrations,index,lap-mutation-queries,lap-reprocessing-queries,session-queries,session-result-queries}.ts`.
- `server/session-capture/{import-pipeline,reprocess,elapsed-duration}.ts`, capture finalization owner discovered through references, `server/telemetry/live-pipeline.ts`, adapter mutation owners.
- `server/race-results/{reconcile,aggregates}.ts` only for summary invalidation integration.
- `apps/backend/src/routes/{index,session-routes}.ts`; `apps/backend/src/runtime/{boot,startup-jobs,shutdown}.ts`.
- `client/src/components/home/{HomePageContainer,HomePageView,DashboardInsights,dashboard-insights,types}.tsx` or their existing `.ts` variants; `client/src/components/ActivityHeatmap.tsx`; `client/src/hooks/{useWebSocket,query-keys,session-queries}.ts` and existing recap consumers.
- `shared/racing/sessions/` contracts, `shared/package.json`, `server/package.json` only if exports require updates.
- Relevant backend/client tests, backend test shard manifests, benchmark suite, `package.json` only for new documented command registration, `CHANGELOG.md`, affected DB/API documentation and translations.

Proposed new files (names may change only consistently across this plan and all imports):

- `shared/racing/sessions/dashboard.ts`: shared dashboard request/response contract.
- `server/db/dashboard-queries.ts`: bounded dashboard SQL and fresh fallback reads.
- `server/db/dashboard-summary-queries.ts`: transaction-aware summary publication and dirty-state operations.
- `server/session-capture/dashboard-summary-processor.ts`: bounded rebuild/backfill lifecycle.
- `apps/backend/src/routes/dashboard-routes.ts`: aggregate endpoint and schema validation.
- `client/src/hooks/dashboard-queries.ts`: typed RPC and stable dashboard query keys.
- `apps/backend/test/db/dashboard-{queries,summaries,mutations}.test.ts`.
- `apps/backend/test/db/migrations/dashboard-migration.test.ts`.
- `apps/backend/test/session-capture/dashboard-processing.test.ts`.
- `apps/backend/test/benchmarks/dashboard-read-model.bench.ts` and `dashboard-read-model-smoke.ts`.

Use LSP references before changing exported APIs. The scope list is not permission for unrelated cleanup. Discover exact capture-finalization owners before changing them; document additional required files instead of silently broadening scope.

## Metric contract: define before schema or cutover

All requests use an explicit half-open UTC instant interval `[from,to)`. Client computes today from UTC midnight and rolling periods from captured `now` with UTC instants. Validate finite timestamps, `from < to`, maximum 366-day span, and valid game ID; calendar aggregation has no timezone parameter. Normalize legacy SQLite timestamps and ISO timestamps before indexed comparison; do not compare mixed string formats lexically or wrap indexed timestamp columns in functions in every read. Existing stored timestamps are not rewritten without a separately reviewed migration. Prefer indexed integer projection columns in derived tables and a dedicated lap-time projection/index if boundary facts require it.

The client refreshes period bounds at UTC midnight and when returning after a stale UTC day, rather than freezing them for the component lifetime. Supply one `to` for all widgets in a response.

Proposed authoritative definitions (deliberate corrections must be documented):

| Metric | Eligibility and calculation |
|---|---|
| Ownership | Every dashboard surface includes only parent sessions with exact `ownership='mine'`. Exclude others/null/unknown before aggregation, ranking and LIMIT. Source records remain intact; general non-dashboard list contracts are unchanged. |
| Lap count | All mine-session stored laps in lap timestamp interval; incomplete/zero-time laps still count as recorded laps. Expose positive/completed counts separately. |
| Valid / best / average | Valid, finite positive-time laps; averages divide valid-time sum by valid count. Empty best/average are null, not invented zero. |
| Driven time / brand cards / distribution | Sum finite positive lap times, including invalid positive-time laps, matching current driven-time metric. Keep incomplete eligibility explicit: favourite candidates exclude `invalidReason='incomplete'`, as current favourites do. |
| Heatmap | Sum finite positive lap time for mine-session laps by the user's local calendar day; retain driven-duration tooltip semantics rather than replacing it with a lap-count chart. |
| Clean rate | Valid positive-time laps divided by all positive-time laps. Return raw numerator/denominator; chart cumulative period rate derives from bucket counts. |
| Distinct identities | Game-scoped canonical track/car keys; native identity first, known ordinal fallback. Zero is legitimate; null/-1 are unknown. Normalize numeric native IDs versus ordinal equivalents consistently with game contracts. Do not merge unrelated games. |
| Favourite track/car | Highest eligible driven time, existing deterministic tie-break; include distinct sessions, known-distance lap coverage and confirmed race podium evidence. Session membership follows current union of qualifying lap sessions and eligible period session rows. |
| Podiums | Owned confirmed finished race sessions with finite integer position >0; podium means position 1–3. Preserve unavailable versus confirmed zero. Use session timestamp interval. |
| Consistency | Per eligible session, population standard deviation over valid positive-time laps in requested lap interval, at least two laps and one consistent game/car/track context. Average these session standard deviations unweighted; use existing 0.1...0.9 bucket bounds. Session eligibility also follows session timestamp interval, matching current insights. |
| Session-type share | Persisted recording elapsed seconds for eligible period sessions, classified using shared session-type policy; unknown type separate, unavailable duration excluded from denominator. This is not summed lap time. |
| Recent sessions | Mine only, selected game or all games, session timestamp interval, `(createdAt DESC,id DESC)`, SQL limit ten AFTER ownership filtering. |
| Latest recap | Latest mine session only. Historical best and sectors compare only other mine sessions, excluding current session; retain native layout/count, null/unavailable treatment and session-lap sparkline through separate endpoint. An others-session ID must not be exposed through a dashboard recap request. |

Publish these rules as shared executable selectors/reducers, not independent UI/SQL interpretations. Keep a SQL/reference oracle independently formulated enough to catch shared implementation mistakes. Existing snapshot/default-wording tests are not acceptance proof.

## Proposed SQLite schema

These are normal tables in existing `app.db`; SQLite has no native materialized-view statement. Version all derived data. Keep live lap/session source rows and raw captures intact.

Only mine sessions receive dashboard metric rows. State and prior contribution rows may temporarily survive deletion or mine-to-others transitions solely for subtraction/cleanup; they must be excluded from GET results immediately. Reads account for current parent ownership and dirty/tombstone revisions, not stale cached ownership. Backfill and coverage denominators enumerate mine sessions only. Mine-to-others makes old contributions invisible in the same source transaction, with physical cleanup by the bounded processor; others-to-mine rebuilds current contributions without double counting.

### `dashboard_summary_state`

Primary key `session_id`, deliberately WITHOUT a source-session FK cascade so deleted-session tombstones survive. Fields: `source_revision`, `published_revision`, `processor_version`, metadata/capture dirty flags, `deleted`, retry metadata, last error code, last successful processing instant. Triggers increment revision and mark dirty transactionally with source mutations. Keep prior per-session contribution rows until the processor subtracts them; never let source deletion cascade those rows away first. Derived child tables may reference the state ledger and cascade only when the processor deliberately removes that ledger row after successful subtraction. Source IDs remain immutable/autoincrement; stale workers verify source existence, ownership and revision before publication. Persist keyset backfill cursor/version separately; no in-memory-only queue.

### `dashboard_session_summary`

Primary key session ID; indexed integer session timestamp, game and canonical identities, ownership; source/published revision and processor version. Store lap/positive/valid counts, positive driven sum, valid mean and M2, best lap/time, min/max eligible lap timestamps, session consistency value, distance coverage, and capture-derived duration/layout/weather plus their evidence/version status. Do not copy all result fields: join persisted results and aggregate pits in set-based SQL, invalidating dependent rollups when they change. Duration is nullable; preserve shared-file ambiguity.

### `dashboard_session_day_laps`

Primary key `(session_id,utc_day)`; child of the derived state ledger, not cascading from the source session. Store integer bucket bounds, game/identity keys needed by indexed scope queries; total/positive/valid counts, driven sum, valid mean/M2, best lap, favourite-eligible counts/time, distance-known counts/sum. One row per session-day, not one row per lap. Separate counters where eligibility differs; prior contributions survive a source delete until subtraction completes.

### `dashboard_day_entities`

Primary key `(utc_day,game_id,car_key,track_key)` using non-null canonical unknown sentinels. Materialize mine-only additive lap/day/entity counters from session-day contributions. Enables day/game cards, favourites and distribution without visiting every lap/session. Distinct car/track counts group canonical keys over interval, never sum daily distinct counts. Exact distinct-session membership comes from session-day rows plus eligible mine session rows, not this table's summed session counter. All-game totals derive from per-game rows, not separately maintained all-game counters.

### `dashboard_month_entities`

Primary key `(utc_month,game_id,car_key,track_key)` with UTC `YYYY-MM` month keys and the same additive/statistics columns as day entities. Migration v67 backfills from retained day aggregates using weighted means and stable two-pass pooled M2. Publication replaces month contributions atomically with day contributions under the same revision check. Reads select only complete months before the request's trailing-30-day cutoff; remaining full days and source edges are disjoint. Dirty sessions subtract prior session-day facts once across both grains before current source facts are added. Daily detail and source data remain available; this is a query-grain optimization, not destructive retention.


### `dashboard_session_sectors`

Primary key `(session_id,layout_key,sector_index)`; best eligible time and source revision. Layout key includes game/track/layout evidence, not merely sector count. Historical comparison joins compatible per-session minima and excludes current session. Minima remain rebuildable when winning laps are edited/deleted.

### `dashboard_session_time_buckets` and `dashboard_time_buckets`

Preserve exact UTC-day heatmap and trends without rereading a year of source laps. Store sparse 15-minute UTC contributions per mine session (primary key session/bucket), and publish additive game/bucket totals (primary key game/bucket) in the same old-versus-new transaction as day entities. Counters include positive driven seconds, positive/valid laps and confirmed race finishing-position counts, with lap events keyed by lap timestamp and race events by session timestamp. Per-session contributions enable exact subtraction on deletion/ownership/result changes; global buckets avoid per-session history reads for charts.

Map UTC-day intervals onto complete 15-minute UTC buckets in set-based SQL; partial interval endpoints use indexed source facts only. Materialize no empty bins and retain no per-lap payload. Measure write/storage overhead; the extra grain preserves UTC bucket semantics. The final 367-point response remains independent of internal bin count.

### Projection and indexing rules

Required access paths: global and game-specific session timestamp/id; lap timestamp/session boundary access; day/game/entity rollups; dirty state/version/keyset cursor; per-session laps; canonical game/car/track session lookup; per-session sector layout/index lookup. Add projection columns/table only where existing mixed timestamp/identity storage prevents a safe indexed range.

Candidate source indexes, subject to final query plans: `sessions(created_at DESC,id DESC)`, `sessions(game_id,created_at DESC,id DESC)`, `sessions(raw_file)`, `sessions(game_id,track_ordinal,car_ordinal)` and native-ID equivalent; `laps(session_id,lap_time,id) WHERE is_valid=1 AND lap_time>0`. Timestamp indexes on original text are usable only when storage normalization has been established. Preserve `idx_laps_session`; partial best-lap index cannot replace all-lap reads. Drop a replaced redundant index only with evidence; do not add every candidate blindly.

## Refresh, concurrency and failure model

- Use the existing client and transaction API. SQLite triggers, not duplicated helper calls, own revision/dirty updates for SQL source mutations. Application helpers own atomic multi-row business changes, recording-file-only checkpoints and client notifications. No nested transaction or global-client write hidden inside a transaction helper.
- Every dashboard query, fallback, ownership-sensitive join, recent/latest selection and all-time comparison requires exact `sessions.ownership='mine'`. Apply it before LIMIT/top-N. Test others-only databases and mine-to-others transitions; a faster others lap must never affect personal-best status.
- Cheap ordinary lap edits/inserts may synchronously rebuild small affected session/day contributions. Large import/reprocess batches commit durable dirty markers and rebuild once per session/batch. Work always goes through the same publication service.
- Read metadata/source revision, compute expensive recording-derived fields outside a write transaction, then publish only if source revision still matches. A stale worker discards its candidate and retries latest work; it cannot clear a newer dirty marker.
- Publication atomically replaces session/day/sector summaries and adjusts day-entity totals by old-versus-new contributions. Delete zero-contribution aggregate rows. Repeating publication of same revision is a no-op. Recompute minima rather than subtracting them.
- Source-session deletion marks a durable tombstone without deleting prior derived contributions. The processor subtracts all prior day/time aggregate contributions and removes derived rows atomically, then clears the tombstone/ledger as appropriate. While cleanup is pending, GET subtracts tombstoned contributions from global rollups, so no deleted/others data leaks. Import rollback and direct SQL deletion use the same trigger-backed contract.
- Recording-derived fields carry separate capture revision/fingerprint and processor version. Active capture duration can be accumulated from observed clocks with periodic bounded checkpoints; it cannot be treated as final on initial lap save. Flush/finalization publishes final status. Raw-file replacement, identity/source changes, shared path changes and compression must preserve or invalidate evidence deliberately.
- No long-lived SQLite read snapshot across raw decoding. A dashboard response uses a short consistent snapshot for SQL reads, released before response serialization; backfill publication must remain atomic across related tables.
- Worker: one owned bounded processor, initial metadata batch size 25 sessions, concurrency one for capture decode; yield between batches. No full-lifetime arrays; keyset enumeration, bounded record streaming, clean stop/restart. Backfill errors stay visible and retryable; no silent conversion to zero.
- Reads during backfill use one short snapshot: global published additive rollups MINUS prior contributions of every dirty/stale/deleted/no-longer-mine session PLUS exact current metadata contributions of eligible dirty/missing mine sessions. Per-session nonadditive values use fresh summaries UNION disjoint current-source fallback, never subtraction of minima or distinct counts. This reconciliation is set-based and read-only. Never invoke processing/write on GET. Missing expensive duration/layout/weather returns pending/unavailable with mine-only coverage; partial totals cannot masquerade as complete.
- A stale summary must never replace newer source truth silently. If fallback work exceeds configured safe limits, return explicit processing status rather than false totals. Final readiness gates require complete metadata coverage and no pending rows in benchmark fixtures.

### SQLite trigger contract

Install triggers in the appended embedded migration and include all names/definitions in migration regression checks. They write only the small state ledger; they never decode captures, rebuild histograms, scan all laps, publish summary tables or emit network events.

| Source mutation | Trigger behavior |
|---|---|
| Lap INSERT | Mark NEW.session_id metadata-dirty and increment its source revision when mine or prior contribution state exists. |
| Lap DELETE | Mark OLD.session_id dirty; retain old published contributions for reconciliation. |
| Lap UPDATE of metric/timestamp/sector/parent fields | Mark old and new parent IDs; if parent unchanged bump once. Detect actual relevant value changes using null-safe comparison. Notes/favourites alone do not require metric rebuild unless a current dashboard field depends on them. |
| Session INSERT | Queue mine metadata projection/backfill; do not materialize others. |
| Session UPDATE of ownership, game/identity/type/timestamp/source/raw capture/version fields | Increment revision; set appropriate metadata/capture flags; ownership loss is immediately excluded through reconciliation. |
| Session DELETE | Retain old ID in ledger as deleted/dirty; cleanup processor retains access to previous contributions even during FK cascades of source laps/results. Tombstone cannot be cleared by child-delete triggers. |
| Session result INSERT/UPDATE/DELETE | Mark affected old/new session IDs metadata-dirty for podium/result dependent summaries. |
| Pit event INSERT/UPDATE/DELETE | Resolve old/new result parent session while it is available; result/session-delete triggers cover cascaded deletion when parent lookup no longer resolves. |

Use `INSERT ... ON CONFLICT(session_id) DO UPDATE` to bump revisions atomically. Preserve deleted status until processing proves a current source row exists; immutable IDs cannot be repurposed silently. Trigger operations roll back with the source transaction. Summary-table writes do not trigger source invalidation, preventing feedback loops. No trigger-owned transaction boundaries.

File growth/finalization, raw-file replacement without a SQL change, and processor-version upgrades are NOT observable by SQL triggers: existing capture lifecycle must transactionally call one explicit dirty/checkpoint function for these events. Do not count on `raw_file` path updates when file bytes change in place. Coalesce publication scheduling, not lost revision marks. Persisted triggers are the integrity boundary; Bun worker concurrency/cancellation use existing runtime patterns and AbortSignal where appropriate, not Effect.

## Dashboard API and client contract

Create `GET /api/dashboard` with validated `from`, `to`, optional game selection through existing game-context/header convention, and UTC calendar buckets. Inspect existing route context handling; never introduce a fallback game. Main request has no game restriction; game request selects one game but returns separate all-game brand-card totals for the same interval. Export typed contract through existing workspace exports.

Response contains numeric aggregates, null availability, interval echo, summary revision/coverage, six-game card totals, selected scope totals, bounded UTC chart buckets, top five tracks plus others, favourite car/track, consistency histogram/count/average, session-type shares, at most ten recent sessions with resolved identity/display metadata, and latest recap session ID. No raw lap list, per-session lifetime list, car setup, raw capture path, or processor provenance dump.

Heatmap/clean/podium daily series: at most 367 fixed UTC-day buckets per series, each 86,400,000 ms, with ISO UTC day labels and bounds. SQLite UTC rollups answer whole UTC days; process exact partial-day edges. A capped/downsampled series is allowed for cumulative trends only while preserving exact endpoints and documented bucket semantics; individual-lap trends become daily aggregate trends, a deliberate documented presentation change. Client formats dates in browser-local timezone for presentation only.

Create separate `GET /api/dashboard/sessions/:id/recap`, with typed `useDashboardRecap` in the dashboard hook module. Enforce current `ownership='mine'` and game match server-side; return 404 for others/null/unknown or deleted sessions. Reuse existing pure `computeRecap` and `SessionRecap` response contract, but source capture-derived inputs from persisted facts. Keep generic `/api/sessions/:id/recap` and `useSessionRecap` semantics for non-dashboard analysis consumers; do not silently remove their ability to inspect others recordings. Dashboard recap remains a separate bounded latest-session query so long-session sparklines do not bloat aggregate response. Compare historical best and sectors from mine-session summaries plus disjoint mine metadata fallback, excluding current session; avoid scanning all historical sector arrays and all capture access.

Client query key includes game/from/to only. Remove dashboard dependency on `useLaps({allGames:true})` and `useSessions({allGames:true})`; keep these hooks for real list consumers. Replace raw-array dashboard reducers with typed response adapters, delete obsolete dashboard-only reducers after tests move. Keep general list contracts unchanged unless a separate named consumer requires correction. Invalidate dedicated dashboard and latest recap keys after source publication/result changes. Coalesce import/reprocess bursts; update after final batch. Live lap-save must refresh session counts and recap even when latest session ID is unchanged. No idle polling as substitute for missing mutation hooks.

## Phases, implementation steps and gates

### Phase 1 — Freeze semantics and reproduce failures

1. Inventory LSP references for mutation functions, session source/raw-file/identity updates, cleanup and result writes. Produce a concise mutation matrix in PR/plan evidence, including direct seed/import/reprocess SQL that bypasses ordinary helpers.
   Include ownership changes and stale-result reads: mine-to-others removes old contributions; others-to-mine adds them. An others-only DB produces empty personal dashboards despite retained source rows.
2. Add shared metric contract and independent reference queries. Characterize intended selectors, not current 200-row truncation or ordinal-only bugs.
3. Add permanent >200 cross-game regression, ownership/native-identity/ordinal-zero, period-boundary, unknown-duration and recap exclusion cases.
4. Establish read-only SQL/query instrumentation in an isolated harness, not production telemetry. Record baseline query counts and raw recording access before change.

**Gate:** `bun test ./apps/backend/test/db/dashboard-queries.test.ts --timeout 60000` passes the independent oracle cases; an explicit failing-before probe demonstrates capped client source disagrees with it. `bun run typecheck` exits zero. Do not mark fixed yet.

### Phase 2 — Add schema, indexed queries and safe publication

1. Append next free embedded migration; create derived tables, trigger definitions, revisions, indexes and timestamp projections without altering old migrations/source rows. Startup creates schema/queues work, never synchronously decodes lifetime captures. Trigger creation follows source-table creation; avoid missing triggers during future table rebuild migrations.
2. Implement trigger-owned dirty/revision bookkeeping, source snapshot, metadata rebuild and atomic compare-and-publish. Unit/integration tests use real libSQL transactions, including raw SQL mutation bypassing application helpers and transaction rollback.
3. Implement session-day/entity publication, deletion subtraction, layout-aware sector minima, Welford merging and minimum recomputation.
4. Add set-based recent-session/metadata aggregate reads. Select recent ten before joins/aggregation, and preaggregate pits/results to avoid multiplying lap counts through joins.
5. Capture `EXPLAIN QUERY PLAN` through Bun/libSQL for every final query shape; verify predicates actually use intended indexes.

**Gate:** `bun test ./apps/backend/test/db/dashboard-summaries.test.ts ./apps/backend/test/db/migrations/dashboard-migration.test.ts --timeout 60000` exits zero: fresh install, upgrade, migration rerun, atomic rollback, idempotent publication, deletion and numerical cases pass. Gate includes real SQLite SQL capabilities; do not assume optional `sqrt`/JSON extensions without a probe. Compute standard deviation in Bun when required; keep complete-session reductions in SQL and exceptional boundary merges bounded. `bun run typecheck` exits zero.

### Phase 3 — Cover all mutations and move recording work off reads

1. Integrate and verify trigger matrix from Phase 1: lap insert/validity/delete/transient delete, in-place/replacement reprocess, session ownership/metadata/identity/raw-file/source updates, results/pits, capture cleanup, import rollback. Remove duplicate application dirty marks for trigger-covered SQL mutations; retain explicit marks for recording-file-only changes.
2. Persist duration/layout/weather from existing parser/capture processing pass when available; do not add a second pass per lap. Legacy backfill may stream one capture once for several derived fields. Preserve incomplete/unknown evidence and shared capture semantics.
3. Add processor startup/shutdown lifecycle, durable dirty work and resumable versioned backfill. Work prioritizes currently visible/live sessions but historical keyset cursor cannot starve.
4. Backfill metadata separately from expensive capture fields so accurate lap totals become available early. Session rebuild and capture processing are retry-safe after crashes.
5. Use session best/layout/weather summary inputs for recap. Keep dynamic historical comparison exact and capture-free.

**Gate:** `bun test ./apps/backend/test/db/dashboard-mutations.test.ts ./apps/backend/test/session-capture/dashboard-processing.test.ts ./apps/backend/test/lap-analysis/recap --timeout 60000` exits zero. Deterministic concurrency barriers prove revision-race safety. Crash/restart and retry smoke through actual Bun process shows complete recovery, no double counts, no resurrected deleted rows. `bun run typecheck` exits zero.

### Phase 4 — Cut over all dashboard consumers

1. Register typed Hono dashboard route, query validation and scoped aggregate reads; reject invalid intervals/game scope and distinguish zero from unavailable.
2. Implement dashboard hook, response adapters and all widget inputs. Preserve established layout, game cards, selected-game filtering, latest recap and current session navigation.
3. Replace local lifetime filtering/name fanout with bounded server results. Provide processing coverage states through translated UI copy only where needed.
4. Integrate commit/publication invalidations; no caller remains on old raw-array dashboard calculations. Remove dead dashboard-only computations and their incidental tests.
5. Keep non-dashboard list/analysis consumers intact; exported contract migrations require references and caller tests.

**Gate:** `bun test ./apps/backend/test/db/dashboard-queries.test.ts --timeout 60000`, targeted existing/added HTTP contract tests, and `bun run typecheck` exit zero. Launch actual app with isolated DATA_DIR and seeded workload; browser verify `/` and every enabled game root, four periods, live-save updates, empty/loading/error/pending states and latest recap. Verify no dashboard `GET /api/laps` or unlimited `GET /api/sessions`, max ten recent sessions, no console errors. Inspect desktop/mobile states in one pass. Unit tests alone do not pass this gate.

### Phase 5 — Prove scale, document rollout and close

1. Add deterministic scale fixture generator/runner using real Bun/libSQL and embedded migrations. Record reproducible dataset distribution, seed, revisions, runtime/SQLite versions and machine.
2. Run `bun apps/backend/test/benchmarks/dashboard-read-model-smoke.ts` for scale assertions, `bun apps/backend/test/benchmarks/dashboard-read-model.bench.ts` for timing, and `bun apps/backend/test/benchmarks/dashboard-contention.bench.ts --output=<path>` for recording/backfill contention. The contention runner requires an output path and uses `test/artifacts/sessions/fm-2026-04-09T21-55-03-186Z.bin.gz` by default; the committed candidate is measured at 11,912 frames over 198.985 seconds (59.763 Hz). This cadence probe is not UDP concurrency/finalization acceptance; those remain a separate gate.
3. Register new benchmark commands only if useful; update all manifests/docs/shards/references as project requires. Smoke runner must exit nonzero on a failed acceptance gate, use an isolated temporary DATA_DIR, and never reseed production.
4. Fix measured query/index/worker issues within scope; rerun only invalidated gates. Tune batch/concurrency only against capture latency/write contention evidence.
5. Update customer changelog for corrected statistics and bounded chart presentation; document summary rebuild/backfill/coverage, internal processor lifecycle and expected migration space. Remove throwaway probes. Store full benchmark JSON/logs under ignored durable `.omp/evidence/sqlite-dashboard/`, not in this plan.

**Gate:** scale assertions below pass, `bun run typecheck`, `bun run lint`, and `bun run --filter @raceiq/backend test:integration` exit zero; required changed-path browser smoke passes. Use `bun run test:shards` if test manifests changed. Use `bun test ./apps/backend/test/changelog.test.ts --timeout 60000` only if that path exists at implementation time; locate actual changelog test before executing instead of guessing. No full unrelated test suite is required beyond project CI policy. Attach exact command/evidence paths and mark plan DONE only after all named gates.

## Permanent behavioral test matrix

Use `apps/backend/test/db/lap-ownership.test.ts` as DB setup/cleanup pattern; existing recap files as statistical/sector behavior patterns. Native-adapter tests initialize shared/server registries. Test preload `server/test-support/setup-data-dir.ts` owns isolated DATA_DIR and calls initDb. Never close the global client in individual test teardown.

| Scenario | Required invariant |
|---|---|
| 205+ laps across games; target game's oldest five | Full-period totals include all five regardless of generic list cap. |
| Others-only DB; newer others sessions; faster others laps/sectors | All personal metrics empty when no mine data; latest/recent use mine-before-LIMIT; personal best compares only mine. |
| Mine-to-others and others-to-mine, including pending publication | Immediate exclusion/inclusion through source reconciliation, followed by exact rollup subtraction/addition; coverage denominators remain mine-only. |
| Null/unknown ownership | Excluded, not normalized into mine or leaked through fallback. |
| Direct raw SQL INSERT/UPDATE/DELETE and transaction rollback | Triggers mark correct old/new parents; dirty/revision state rolls back with source writes. |
| Parent DELETE with cascading lap/result/pit deletes | Tombstone persists, prior contributions survive until subtraction, no FK failure or dirty-marker resurrection. |
| Summary-only publication; irrelevant source-field update | No recursive invalidation or unnecessary metric rebuild; capture-only changes explicitly invalidate. |
| UTC acquisition versus imported-row createdAt; browser zone change | UTC source bytes/instants unchanged; reporting uses documented timestamp source and exact UTC bounds for calendar grouping. |
| Same ordinals across games; ordinal zero; LMU native string IDs | Correct distinct/favourite scopes without collisions or zero loss. |
| Valid/invalid/incomplete/zero/unknown source data | Exact separate numerator/denominator/time rules; finite outputs or null. |
| Repeated entity/session across days | Exact distinct counts and session union; no sum-of-daily-distinct bug. |
| Exact from/to boundary; rolling noon cutoff; local midnight; DST shift | Half-open period membership and correct calendar buckets. |
| Session crosses period/day boundary | Consistency uses eligible lap subset and session eligibility; mean/M2 merges correctly. |
| Unbalanced sessions with different variances | Average of session deviations, not pooled or weighted deviation. |
| Best lap/sector winner deleted or invalidated | Next eligible winner becomes best; minima never remain stale. |
| Current session owns all fastest sectors | Other-session recap excludes all current-session candidates. |
| Different sector layouts with same count | No incompatible sector comparison. |
| Unknown/shared capture duration; confirmed zero duration | Null evidence preserved; zero distinct from missing; no double-counted shared file. |
| Provisional/DNF/confirmed results and pit updates | Correct podium eligibility, availability, pit sums and no join multiplication. |
| Insert/update/delete/import rollback/reprocess twice | Oracle equality and no double counting. |
| Worker reads revision A, writer commits B before publish | A cannot publish or clear B dirty marker. |
| Worker processing session, session deleted | No orphan/resurrected summary or day totals. |
| Crash before publication, crash after commit, restart | Durable queue recovers exactly once logically. |
| GET during partial backfill and active writes | Snapshot-consistent fresh-plus-source totals; explicit expensive-data coverage. |
| Empty DB/missing recording/unsupported channel | Valid empty/null response, no fabricated facts, no recording access on GET. |
| Summary processor version upgrade | Old version treated stale; rebuild is resumable and exact. |

Counts, IDs, buckets and statuses must match exactly. Floating sums/mean/M2/seconds use justified tolerances: absolute error <=1e-6 seconds for mean/best, summed time <=max(1e-6,1e-9 * absolute reference sum), standard deviation <=1e-6 seconds for deterministic fixtures. Reject nonfinite results and significant negative variance; clamp only documented roundoff-sized negative values. Preserve deterministic tie ordering.

## Success criteria and measurement protocol

### Correctness and resource gates (mandatory)

- Every metric matches source SQL/independent reference across permanent matrix and generated datasets; no list-limit dependency.
- All final queries execute through existing Bun/libSQL, not only Python SQLite. Source DB, recordings and old migration history preserved through upgrade.
- Dashboard aggregate GET and dashboard-specific recap GET perform ZERO recording file stat/read/decompression/parser calls. Backfill/recording writers and general non-dashboard analysis routes are measured separately; this requirement is not a blanket ban on telemetry replay.
- SQL recent-session limit is ten; top tracks five plus others; each daily series <=367 points; no raw-lap/lifetime-session arrays in aggregate response.
- Others/null/unknown sessions contribute zero to every dashboard field and availability flag, never occupy recent/latest slots, and never affect historical best/sector comparison. Others-only DB yields empty dashboards; latest mine session wins even when many newer others sessions exist. Ownership transitions update all contributions within freshness target.
- Fully backfilled dashboard request uses <=12 SQL statements, independent of lifetime session count; recap <=8. Temporary exact fallback/boundary algorithms must report statement/row counts separately. Do not hide chunked queries or per-day fanout behind one function.
- Trigger invalidation works for direct SQL, rollback and cascaded deletion; publication does not reinvalidate source. No Effect dependency or dashboard DuckDB store introduced.
- Warm requests do not visit source laps except explicitly necessary partial time-bin/period-boundary facts or current dirty metadata. Older complete months use month summaries; recent and boundary days use day summaries. Local-calendar charts retain time-bucket summaries; recap historical sectors use per-session minima.
- Dashboard response <=128 KiB uncompressed for acceptance datasets, excluding separate recap; stable size as historical laps grow outside the interval.
- Summary freshness for metadata <=2 seconds after ordinary completed live lap/write in active dashboard; capture-derived final fields <=5 seconds after finalization when no legacy backlog. During backlog pending coverage is explicit, not a fake pass.
- Backfill restart and all supported mutations preserve source-summary equality; zero unrecovered dirty metadata rows after fixture drain.
- No SQLite lock errors, lost/duplicated lap inserts, or unbounded write queue while recording/import/backfill run together. No raw decoding held inside write transaction.

### Proposed performance budgets (acceptance targets, not observed results)

Use one documented reference machine first, then run concurrency/recording gates on supported Windows target before release. Fix Bun version, data distribution, processor versions and dataset between before/after. Run >=30 measured requests after five warmups per scope/period; record p50/p95, statement counts, rows, payload, process RSS and writer latency. Cold means new process/client and empty application caches; OS page-cache flush is optional and must be labeled, never implied.

| Workload | Target |
|---|---|
| Active-user baseline, 120 stored laps/12 sessions per week over two years | Aggregate warm p95 <=150 ms; cold p95 <=750 ms; request incremental RSS <=64 MiB. Exact stored/mine period counts must be reported. |
| Archive stress: 100k stored laps / 10k sessions across history, not in a weekly window | Aggregate endpoint warm p95 <=150 ms; cold p95 <=750 ms. |
| Archive stress: 1M stored laps / 100k sessions across history, not in a weekly window | Aggregate endpoint warm p95 <=300 ms; cold p95 <=1.5 s. |
| Latest recap on 1M-lap DB, 500-lap selected session | Warm p95 <=200 ms; zero capture access; historical sector rows do not scale with all historical laps. |
| 1M-lap DB with one 60 Hz live recording plus backfill | Aggregate p95 <=500 ms; lap persistence p95 <=100 ms and <=20% regression versus same recording with processor disabled; no capture sequence loss. |
| Request memory at 1M laps | Peak incremental RSS <=64 MiB over idle server for request workload; no lifetime-sized JS arrays. |
| Backfill metadata/recording processing | Peak incremental RSS <=128 MiB over corresponding baseline workload; one recording decoder; memory plateaus with history size, excluding documented single-source import materialization already inherent to its format. |

Default active-user fixture assumptions are 120 stored laps/12 sessions per week at typical 90-second spacing over two years, with recurring identities, interleaved skewed games and excluded ownership. Source SQL reports exact stored/mine period membership before timing; this is an explicit assumed usage profile, not observed production data. Separate archive-stress fixtures retain six skewed games, 50+ tracks/game and 200+ cars/game, hot identities, unknowns, ownership mix, confirmed/provisional/no results, varied sectors, invalid/incomplete laps, 24 months of history and a 500-lap selected recap session. Preserve the separate adversarial single-day/boundary-heavy shape and report its results; never relabel archive cardinality as weekly activity or silently exclude it from resource claims. Raw-IO concurrency proof uses committed representative real recording fixtures, not fabricated telemetry packets.

If a budget fails, report measured evidence, identify query or processing bottleneck, and fix within scope. Changing budgets requires explicit maintainer acceptance, not weakened assertions. These budgets are engineering targets; planning has not established feasibility on all hardware.

## Commands and safety

Existing commands: `bun run typecheck`, `bun run lint`, `bun run --filter @raceiq/backend test:integration`, `bun run test:shards`, and `bun run dev --onboarding false`. Phase 5 direct benchmark entrypoints are documented in [the architecture overview](../docs/architecture/overview.md); no package-script aliases are registered. Benchmark completion and gates require separate evidence.

Tests use repository preload and temporary DATA_DIR. Actual app/benchmark server must receive an explicitly isolated temporary DATA_DIR before startup; tests can delete their test DB, so never point test preload at user data. No `db:seed --clean`, `--reset`, `db:push`, production reprocessing or destructive maintenance on user DB. Build gates must not be confused with runtime proof.

No commit/push authorization is granted by this plan. Follow operator's branch/PR instructions, preserve staged user work, and use coherent phase commits only when separately authorized or required by active orchestrate mode.

## STOP and escalation conditions

Stop affected work and report concrete prerequisite if:

- Live source materially disagrees with current-state excerpts or another owner edits shared interfaces; reconcile scope before implementing.
- Required libSQL transactions, FK behavior, UPSERT, timestamp projection, SQL functions or native layout evidence are unsupported by actual runtime. Do not substitute another DB or invent fallback data.
- Existing source does not contain enough information to reconstruct a metric: return null/pending with evidence, preserve source; never fabricate recording elapsed time or sector layout.
- A mutation bypasses revision marking and cannot be migrated safely without touching a new subsystem: identify exact caller/interface and amend scope first.
- Background publishing cannot be made revision-safe or GET fallback would present incomplete totals as complete.
- Migration requires deleting source data, rewriting released migrations, unsafe whole-DB rebuild or blocking lifetime capture processing at startup.
- Final performance/resource gates fail after targeted remediation: record evidence; do not mark DONE or silently shrink acceptance.

Missing desktop/browser authorization is a verification limitation, not permission to tunnel through native automation. Use authorized page-only tooling. Complete non-browser checks and record exact remaining UI gate if unavailable.

## Completion checklist and maintenance

- [ ] Phases 1–5 gates passed with exact command/scenario evidence.
- [ ] Main and all enabled game dashboards, all four periods and latest recap use new contract; generic list users remain functional.
- [ ] Mutation matrix fully covered, old dashboard reducers removed, no duplicate source of metric semantics.
- [ ] Mine-only restriction verified for every surface, fallback, latest/recent selection and historical comparison; ownership-transition and others-only fixtures pass.
- [ ] Existing and upgraded SQLite DBs retain source rows/recordings; summary rebuild/reset touches derived tables only.
- [ ] Race/crash/retry/version tests and oracle equality pass; expensive-data gaps remain explicit.
- [ ] Scale/concurrency/memory budgets pass on documented reference machine; supported Windows recording gate passes before release.
- [ ] Typecheck/lint/integration/shard gates pass as applicable; changed UI actually exercised.
- [ ] Customer changelog, internal operational docs and command references updated; throwaway tooling removed.
- [ ] Evidence links recorded in advisor-plans index; index status updated honestly.

Review future new mutations against revision matrix. Changes to eligibility, UTC-day grouping, canonical identity, sector layouts or parser versions require processor-version/invalidation review and a source-vs-summary regression. Store detailed benchmark results separately; this plan remains requirements and current execution status, not an append-only log.
