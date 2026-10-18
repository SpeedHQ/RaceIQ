# Valid non-pace laps: backend implementation plan

Status: automatic-upgrade implementation and its exercised regression gates pass. See [executed evidence and remaining full-feature acceptance](valid-non-pace-laps-contract.md#executed-automatic-upgrade-evidence); this does not close the broader acceptance matrix.

Requirements: [feature plan](valid-non-pace-laps.md). Boundary and acceptance authority: [shared contract](valid-non-pace-laps-contract.md). Architecture: [ADR](../adr/0011-valid-non-pace-laps.md). UI counterpart: [UI plan](valid-non-pace-laps-ui-plan.md).

The proposed additive capture-order metadata projection for Sessions timeline consumption is scoped in the [timeline backend plan](session-classification-timeline-backend-plan.md) against its [shared boundary and TL acceptance matrix](session-classification-timeline-contract.md). This extension is planning-only; no new schema or endpoint is planned.

## Scope and ownership

Backend owner implements shared metadata/DTOs, native/portable classification, persistence, automatic upgrade scheduling, API/status/retry/notifications, transfer paths, and every server-side pace consumer. Own `packages/analysis-core`, telemetry/processor/game packages, `shared/racing`, `server/db`, `server/session-capture`, affected server consumers, `apps/backend/src/routes/session-routes.ts`, and runtime boot integration. Extend existing tests in their current package locations. UI components/store/rendering are outside this ownership.

Backend owner is sole editor of shared DTOs and contract amendments. Integration owner runs the shared E2E matrix after both layers are integrated. UI work may start against agreed contract fixtures immediately; backend availability is not a prerequisite for UI implementation.

## Tasks

1. Confirm native source meanings/freshness per game and obtain #222 evidence; follow feature-plan detection rules. Publish supported/limited matrix. Missing actual start evidence blocks AC-02, not permission for a first-lap heuristic.
2. Add shared classification and pure eligibility. Carry evidence through live/batch/replay/compact/selected processing and provisional/finalized boundaries. Remove category-only invalidation and obsolete first-lap knobs; retain real quality/native failures. Reference AC-01/02 and E2E-01/02.
3. Append schema migration for classification and durable recording work state. Backfill exact legacy pit reasons before consumer cutover without restoring validity. Propagate required nullable metadata through mutations, queries, registered API/WebSocket results, and compact/full import/export. Reference AC-01/04/05.
4. Implement one bounded streaming worker after DB readiness. Reuse source loader, parser/detector, and capture maintenance coordination, but do not invoke destructive/lap-timing-changing reprocess behavior for migration. Group shared-file sessions, match by source ranges/session boundaries, reassess quality, and update only permitted metadata. Persist version/source/result revision and terminal outcomes according to contract. Reference AC-05/07/08.
5. Make metadata, successful marker, dashboard projection, and durable dirty revisions atomic. Add classification-aware trigger/projection handling through a new migration, update summary processor version as needed, and ensure startup drains dirty read models independently of completed classification work. Publish existing lap invalidation notifications only after commit; reconnect refetch recovers lost messages. Reference AC-03/06/09.
6. Add typed status/list/retry operations and global snapshot notification from contract. Preserve session API ownership/access controls, static route ordering, bounded pagination, restart-persistent revision, and idempotent enqueue. Coordinate current import/manual reprocessing and startup historical repair so stale/destructive repair cannot run concurrently or undo classification results. Reference AC-05–09.
7. Migrate SQL and pure-policy consumers named in feature plan, filtering before ranking/limits; retain inventory counts, manual exclusions, and explicit retrieval. Remove obsolete legacy policy/callers. Reference AC-03/04.
8. Extend real boot/replay E2E harness and upgrade fixtures described in shared contract. Backend owner provides test-only barriers, ephemeral HTTP readiness, pinned release baseline, and source fixtures; integration owner drives crash/browser scenarios. Update maintained detection docs and one coherent customer-facing changelog entry only after verified behavior.

## Acceptance and edge handling

All acceptance definitions and setup/action/assertion scenarios are in the [shared matrix](valid-non-pace-laps-contract.md#acceptance-criteria-and-e2e-evidence-map).

| Backend acceptance | Shared criteria | Required E2E |
| --- | --- | --- |
| BE-01: source-derived category/quality parity across engines | AC-01/02 | E2E-01/02 |
| BE-02: preserved identity/metadata/telemetry and transfer | AC-04/05 | E2E-01/07 |
| BE-03: atomic restart and read-model recovery | AC-06/09 | E2E-03 |
| BE-04: visible source limitations, bounded scheduling, safe concurrent work | AC-05/07/08 | E2E-04/05 |
| BE-05: contract-conforming real status/retry and correct pace consumers | AC-03/09 | E2E-06/07 |

Native missing/stale state, rolling starts, unknown sessions, and cross-lap evidence use positive-evidence/reset rules (E2E-02). Ambiguous matches/corruption roll back the recording; missing source/evidence is a visible limitation; other work continues without unchanged-input retry loops (E2E-04). Active captures defer; shared-file grouping and maintenance/revision coordination prevent stale overwrites (E2E-05). Precommit crashes roll back; postcommit crashes leave durable aggregate dirty work, not a completed-but-stale dashboard (E2E-03). Nullable legacy metadata remains compatible, not falsely classified (E2E-01/07).

## Verification and completion dependency

Execute shared E2E-01 through E2E-07 against actual production processing and HTTP/WebSocket entry points. Reuse the release-upgrade suite and seeded browser harness; follow the shared contract's exact setup and commands. Focused engine/SQL parity tests and root typecheck supplement, never replace, E2E. Record every criterion's fixture, command, outcome, and evidence. Backend completion depends on passing real UI/backend integration E2E-03/06/07 after both implementations; isolated DTO tests or mock UI do not close it. Missing #222 fixture, release baseline, or runtime capability must be reported explicitly. Code implementation alone does not close the acceptance matrix.

## PR correction implementation

Acceptance, edge cases, and concrete integration scenarios: [F01–F07 and F11 in the shared contract](valid-non-pace-laps-contract.md#pr-review-corrections). Replay owner edits classification migration replay and inventory scheduling (F01/F02/F07); native owner edits F1 checkpoint state and AC Evo projections/classification (F03/F05); consumer owner edits result reconciliation and live reference eligibility (F04/F06). The integration owner verifies main-compatible legacy pit-reason fixtures (F11). Preserve existing APIs, released migrations, raw ownership, quality failures, and unrelated metadata. Extend the existing regression suites in each scope.

These backend slices run in parallel with the [UI corrections](valid-non-pace-laps-ui-plan.md#pr-correction-implementation). The integration owner executes the contract scenarios through production parser, migration, live-pipeline, and HTTP/WebSocket entry points after integration, records outcomes, and runs root typecheck. Passing isolated unit tests does not close unavailable end-to-end scenarios.

Correction execution results are recorded in [the shared evidence record](../../.omp/evidence/pr469-review-fixes/results.json). This records correction-specific verification, not closure of the feature's pre-existing broader acceptance gaps.
