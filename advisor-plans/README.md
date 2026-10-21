# Dashboard scalability implementation plans

Proposed on 2026-10-09 against commit `466c5501b` and inspected working-tree source. Existing root `plans/` documents unrelated rendering proposals, so this work uses `advisor-plans/`. This index records implementation status, not a checkpoint or benchmark history.

## E2E-aware package extraction proposal

Planned on 2026-10-21 against `4eef7739c` and inspected working-tree source. Goal: reduce unnecessary E2E executions, first through conservative CI gating and then through feature-owned UI/backend/E2E workspaces. Planning only; no application code, tests, workflows or package configuration changed.

| Document | Purpose | Status |
| --- | --- | --- |
| [002 contract](002-e2e-extraction-contract.md) | Shared selection operation, vertical package boundaries, AC-01–12, integrated E01–10 scenarios | PROPOSED |
| [003 CI plan](003-e2e-selection-plan.md) | Skip unaffected provisioning; own feature E2Es, discovery and final integration | TODO |
| [004 backend plan](004-e2e-backend-plan.md) | Dashboard backend pilot, followed by neutral game-replay extraction | TODO |
| [005 UI plan](005-e2e-ui-plan.md) | Dashboard UI pilot, followed by accidental server-boundary cleanup | TODO |
| [006 change list](006-feature-extraction-change-list.md) | Ordered review/landing slices, file scope, dependencies and acceptance gates | PLANNED |

ADR: [0015 — feature-owned E2E boundaries](../docs/adr/0015-e2e-aware-package-extraction.md).

### Recommended execution order

1. Agree shared contract; establish controlled positive/negative selection evidence.
2. Ship conservative all-or-none browser gating before seed/build/matrix provisioning. Existing eligible PRs currently schedule all ten browser matrix entries.
3. Reconcile active dashboard plan 001 edits. Create ONE `@raceiq/dashboard` workspace: UI/backend implementers work in top-level `ui/` and `server/`, with feature bindings in `contracts/` and Home E2Es in `test/e2e/`. CI owner controls its manifest/exports/configuration, application smoke and selective impact tasks. Keep full compiled-app integration.
4. Validate dashboard-only UI/backend/spec changes select dashboard and genuine cross-feature consumers, not unrelated tuning suites. Shared auth/router/DB/seed changes must still fan out.
5. Extend the proven vertical pattern to tuning/setup, then sessions/import. Specify each feature's contract before implementation. Live/Analyse/Compare follow later because they share more telemetry state.
6. Narrow recording replay fanout using backend plan's later contracts/pipeline/analysis-composition milestone; existing game packages are not recreated.

Every stage requires its mapped passing runtime/E2E evidence. No test-result caching changes or unmeasured savings claims. Existing full-mode coverage, unknown-change fallback and failure propagation remain mandatory. Plan 001's outstanding verification/performance work is neither claimed complete nor silently included.

### Evidence, risks and rejected shortcuts

- Observed root recording E2E definition contains 148 input patterns; game owners extend it. AI/tuning/backend-core changes can therefore reach unrelated replay owners.
- Turbo 2.11.7 dry-run confirms browser execution depends on the complete app build, while its current task dependency override lacks its own runtime transit edge. Do not use that incomplete graph as a safe impact oracle.
- One controlled actual comparison (`HEAD^` → `HEAD`) selected eight executable recording owners. This is not a per-file benchmark or proof of expected savings.
- Each feature package owns UI, server, feature contracts and E2Es together. Explicit `./ui`, `./server` and `./contracts` exports plus scoped typechecks/import rules protect browser/server boundaries; subpaths do not claim separate Turbo package invalidation. Runtime impact selection and full-app build prerequisites remain separate.
- App/source moves alone, deleted dependency declarations, broad `ui-shared` barrels, per-page packages, weakened tests and mock-only integration are rejected.
- Scope audited: workspace manifests, E2E ownership/runners, Turbo task configuration, CI provisioning, app composition and representative dashboard/game/client dependency seams. Not a whole-repository correctness/security audit; no runtime suites, builds or timings were executed for this planning request.


## Execution order and status

| Plan | Title | Priority | Effort | Depends on | Status |
|---|---|---|---|---|---|
| [001](001-sqlite-dashboard-read-model.md) | Correct and scalable mine-only dashboards on existing SQLite | P1 | L | None | IN PROGRESS — monthly rollups implemented; current workload, recording and platform acceptance tracked below |

ADR: [0010 — SQLite dashboard read model](../docs/adr/0010-sqlite-dashboard-read-model.md), status proposed.

## Required decisions retained

- Existing SQLite `app.db` and Bun/libSQL only; no dashboard DuckDB copy or Effect dependency.
- Only exact `sessions.ownership='mine'` contributes anywhere, including recent/latest and all-time comparison. Exclude others/null/unknown; do not relabel ambiguous source rows.
- Recording/source timestamps remain UTC. Existing browser-local calendar presentation converts boundaries to UTC; source timestamps are never shifted or rewritten.
- Lightweight SQL triggers persist revisions/dirty markers; Bun processor handles aggregation and recording-derived facts outside triggers.
- Deleted/ownership-lost sessions retain prior contribution evidence until subtraction; stale contributions are invisible immediately through read reconciliation.
- Preserve source data; append embedded migrations; resumable backfill and rebuildable derived tables.

## Phase dependencies

| Phase | Deliverable | Depends on | Status |
|---|---|---|---|
| 1 | Metric contract, independent oracle, failure reproduction and mutation matrix | — | COMPLETE — `9bbf92736` |
| 2 | Schema/triggers/indexes, atomic summary publication and reconciliation | 1 | COMPLETE — `aba65c8dd` |
| 3 | Full mutation coverage, capture-derived persistence and resumable processor | 2 | COMPLETE — `b40771e1` |
| 4 | Typed dashboard API, all widget/client cutovers and runtime verification | 3 | CODE COMMITTED — `41ae9e00`; browser acceptance pending |
| 5 | Active-user baseline plus 100k/1M archive performance/concurrency proof, docs and final gates | 4 | IN PROGRESS — implementation `ca5ee139`, `b19517e8`, `1806e446`, `41aed132`; monthly rollups implemented; acceptance incomplete |

One integration owner controls schema, triggers, shared contracts and publication semantics. Parallel implementation is safe only after those interfaces are fixed and file ownership is disjoint. Do not dispatch overlapping source editors. No implementation commit/push is authorized merely by publishing this plan.

## Acceptance highlights

Read the full plan for authoritative criteria. Required proof includes exact source-summary equality; no 200-lap dependence; mine-only behavior in every field; zero recording IO on dashboard/recap GET; <=12 dashboard SQL statements after backfill; ten recent sessions; <=128 KiB aggregate response; <=367 points per daily series; revision-safe retries/deletes/ownership changes; live freshness <=2 seconds; and defined 100k/1M-lap latency/memory/write-contention budgets. Performance budgets are proposed targets, not measurements.

## Verification state

- Default workload now assumes 120 stored laps/12 sessions per week (~3 hours at 90 seconds/lap), two years of history, and a ten-lap recap. The 100k/1M profiles are explicitly archive stress, not weekly activity. Exact stored/mine period counts are source-counted outside timing; these are assumed usage volumes, not production observations.
- Monthly producer/read-path regressions passed: 47 tests / 533 assertions, including historical month bounds, stable migration moments, revision-safe corrections and clean/dirty favourite membership. Evidence: `.omp/evidence/sqlite-dashboard/monthly-final-regressions.log`.
- Archive timing, scale correctness and recording figures below predate migration v67 and do not validate current monthly code. They remain historical evidence; no full current archive/recording acceptance is claimed.
- Phase 4 focused query tests and backend typecheck/lint/test shards/unit/tooling/locale/catalog gates passed. Hono I/O evidence: `.omp/evidence/sqlite-dashboard/phase4-endpoint-io-after-completeness.json` (dashboard GET: 10 SQL statements, 8,512 bytes; recap: 3 SQL statements; zero recording/parser calls).
- Runtime/metadata evidence: `.omp/evidence/sqlite-dashboard/phase4-runtime-final.json` and `.omp/evidence/sqlite-dashboard/phase4-metadata-completeness-ui.json`. Desktop/mobile, periods, and refresh scenarios were observed. Isolated loading-only/final-console browser acceptance remains unverified: available page-only capture routes timed out; desktop control was not authorized.
- Optimized-query scale correctness passed 100k standard, 1M standard and 1M boundary-heavy shapes with complete metadata, ten aggregate SQL statements, four recap statements, and dashboard payloads below 128 KiB. Evidence: `.omp/evidence/sqlite-dashboard/phase5-scale-smoke-optimized.log`. Post-remediation timing acceptance remains failed; see the plan's execution-status table and `phase5-timing-optimized.log`. No budgets weakened.
- Final query/oracle and v66 repair gates passed: 30 focused tests / 373 assertions, root typecheck, lint (zero warnings/errors), and 11 changelog checks. Evidence: `.omp/evidence/sqlite-dashboard/retry-repair-targeted-tests.log`, `retry-repair-root-typecheck.log`, `retry-repair-root-lint.log`, and `retry-repair-changelog-test.log`.
- Backend integration remains failed; capture migration timeout and SQLite lock cascade evidence retained at `.omp/evidence/sqlite-dashboard/phase5-integration-diagnosis.txt`. Supported-Windows recording and remaining loading-only/final-console UI checks remain unverified.
- User-reported missing `st.next_retry_at` startup failure is repaired by appended migration v66. Upgrade tests preserve source rows and existing retry history; two production boots publish complete dashboard metadata without changing session/lap source rows. Evidence: `.omp/evidence/sqlite-dashboard/retry-repair-migration-tests.log` and `retry-repair-runtime.log`.
- Recorder-runner repair `41aed132` completes real replay with exact ordered payload fidelity, live-lap visibility and matching final recap fields. Request-only RSS fails; the default runner stops before 100k/1M contention scenarios. Full failed-scenario evidence: `.omp/evidence/sqlite-dashboard/phase5-contention-final.json`. Benchmark-only SQL, stdin lifecycle and timestamped-reader defects are corrected; production UDP/recorder instrumentation was not added.
- Final recorder-runner commit hooks passed root typecheck, lint, unit/tooling, shard assignment, locale and telemetry-catalog gates. Evidence: `.omp/evidence/sqlite-dashboard/recording-runner-commit.log`.
- Boundary-overflow regression fixed and verified through production Hono: HTTP 200; 150/150 clean, ready sessions; `metadataComplete=true`, complete status; 300 laps, 27,300 seconds, best 90, average 91; third session outside interval excluded. Evidence: `.omp/evidence/sqlite-dashboard/phase5-boundary-fixed.json` and `.omp/evidence/sqlite-dashboard/phase5-boundary-regression.log`; focused query tests: 20 passed, 0 failed, 111 expectations. Original counterexample remains preserved in `.omp/evidence/sqlite-dashboard/phase5-boundary-overflow-repro.json` and matching log.

## Considered and rejected

- Increasing generic lap-list limit: preserves incorrect architecture and replaces truncation with growing transfer/browser work.
- DuckDB dashboard store: unnecessary second transactional/synchronization boundary for current metrics. Reconsider only for measured unmet analytical requirements.
- Effect npm package: no needed capability for this processor; retain existing Bun runtime patterns.
- Heavy aggregation in SQL triggers: increases recording-write latency; triggers own invalidation only.
- Daily distinct-count summation, pooled consistency, UTC-day relabeling as local days: mathematically/semantically incorrect.
- Ownership filtering after LIMIT, or `ownership != 'others'`: violates exact mine-only requirement.
