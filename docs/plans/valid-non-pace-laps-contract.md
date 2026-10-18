# Valid non-pace laps: shared implementation contract

Status: implementation boundary for the automatic-upgrade work. The acceptance matrix remains required; this document is not evidence of passing verification or architectural approval.

- [Feature requirements and native detection rules](valid-non-pace-laps.md)
- [Backend implementation plan](valid-non-pace-laps-backend-plan.md)
- [UI implementation plan](valid-non-pace-laps-ui-plan.md)
- [ADR](../adr/0011-valid-non-pace-laps.md)

## Ownership and authoritative definitions

The backend implementer owns shared TypeScript DTOs, route registration, notification schemas, and durable migration state. The UI implementer consumes those DTOs and may use conforming development fixtures. The integration owner owns real-system E2E execution and evidence. Changes to this boundary must update both linked plans and notify both implementers before dependent work continues.

Native evidence, category precedence, quality handling, and source limitations remain authoritative in the feature plan's evidence section. The following contract owns cross-layer metadata and migration semantics; do not redefine them in either implementation plan.

## Lap metadata and pace eligibility

`LapClassification = 'pace' | 'out_lap' | 'in_lap' | 'pit_lap' | 'grid_start' | 'caution'`. Add required `classification: LapClassification | null` to shared lap metadata and registered lap/list/summary/completion payloads. New processing returns a category only when supported by the detection rules. `null` means historical/unclassified or insufficient evidence, never an observed green flag. Old imported metadata without the field normalizes to `null`; new export metadata includes it. Raw bytes do not change.

Keep `isValid` and `invalidReason` independent. Priority is `grid_start`, `pit_lap`, `in_lap`, `out_lap`, `caution`, then `pace`; collect boundary evidence before resolving. Native fields retain their source meaning. Shared pure policy belongs beside lap analysis in `analysis-core`; portable engines compose it.

Normal pace requires valid telemetry, finite positive lap time, and classification `pace` or legacy `null`. Exact legacy pit reasons must be backfilled before eligibility cutover, without restoring validity before quality reassessment. Legacy inclusion exists only for pending or evidence-limited historical data. Experiment/manual restrictions remain additional independent exclusions. A DB-owned SQL equivalent filters before rank/limit, with behavioral parity checks. All-lap inventory and explicit ID inspection retain non-pace laps; intentional comparison labels them without changing aggregate/default selection.

## Recording lifecycle and transaction boundary

A recording is one immutable source capture plus its associated session boundaries, not one lap or a lap number. Multiple session rows sharing a capture are grouped and parsed once. A durable opaque `recordingId` identifies that group; paths are not public identifiers. Discover all pre-upgrade recordings, including sessions whose source is missing, after DB readiness. Active captures defer until finalized. New imports/recordings use current processing directly; scheduler reconciliation catches any historical work not yet registered.

Persist requested classification version, source/result revision, attempt, outcome, and diagnostic code independently of lap category. Successful version is set only for a complete evidence-supported pass. Terminal limitations are accounted for but are not successful version markers.

| State | Meaning and next transition |
| --- | --- |
| `pending` | Awaiting worker or finalized source/maintenance ownership; enters `running` when safe. |
| `running` | One owner parses the capture with full context; crash returns it to `pending` on startup. |
| `completed` | Metadata and durable aggregate invalidation committed for the current version/source revision; unchanged work is skipped. |
| `limited` | Missing source or insufficient native evidence; preserved reliable legacy metadata, visible reason; no automatic retry of unchanged input. |
| `failed` | Corrupt source, ambiguous matching, or processing failure; no partial metadata changes; no automatic retry of unchanged input. |

New classification versions enqueue historical work again. Repaired source or explicit retry can move `limited`/`failed` to `pending`. Repeated retry while pending/running is idempotent. A current completed result is not downgraded by duplicate requests. Reprocessing/import/source replacement must invalidate obsolete version/outcome markers and coordinate through the existing capture maintenance lock plus a source/result revision check. If evidence changes during work, discard computed changes and requeue; never overwrite newer results. Shared-file session grouping and matching use recording/frame ranges plus session boundaries, never lap ordinal alone. Any ambiguous/unmatched historical lap fails the entire recording without destructive replacement.

Default to one background recording worker, yielding between bounded frame batches and giving live capture priority; stream input instead of materializing the library. Do not hold a DB transaction across decoding. Commit only classification and justified validity/reason changes after quality reassessment; preserve IDs, timing, user decisions, notes, favorites, ownership, associations, raw offsets, indexes, and unrelated analysis.

**Atomic commit:** lap updates, successful version/outcome, and durable aggregate dirty flags/source revisions belong to the same transaction. Extend dashboard lap projection/trigger handling to classification (existing trigger in `server/db/migrations.ts` watches only timing/validity/reason and other old fields). Append a migration; never edit a released migration. Any other affected persistent read model needs equivalent durable invalidation. After commit, existing workers rebuild from dirty state and publish query invalidations. On restart they must drain committed dirty work even when classification is already completed. Reconnect/refetch must recover missed notifications; a WebSocket delivery is not a durability mechanism. A crash before commit exposes no partial changes; a crash immediately after commit cannot preserve stale bests as current or require classification replay.

## Status, retry, and notifications

Implement feature-owned typed Hono RPC operations alongside `apps/backend/src/routes/session-routes.ts`; register static paths before `:id` routes. Inherit existing session API access controls and ownership filtering. Do not introduce public file paths or a separate auth model.

All object fields below are required unless marked optional. IDs/cursors are opaque strings; versions/revisions are non-negative integers; counters are non-negative integers. Timestamps, where used internally, are not required by this UI contract.

```ts
type ClassificationMigrationStatus = {
  version: number;
  revision: number; // persisted monotonic snapshot revision, including across restart
  status: 'idle' | 'running' | 'complete' | 'attention';
  total: number;
  pending: number;
  running: number;
  completed: number;
  limited: number;
  failed: number;
  aggregatesPending: boolean;
};
type ClassificationMigrationRecording = {
  recordingId: string;
  sessionIds: number[];
  state: 'pending' | 'running' | 'completed' | 'limited' | 'failed';
  reason: null | 'active_capture' | 'maintenance_busy' | 'source_changed'
    | 'missing_source' | 'insufficient_evidence' | 'corrupt_source'
    | 'ambiguous_match' | 'processing_error';
  retryable: boolean; // true only for limited/failed; retry need not succeed
};
```

`total = pending + running + completed + limited + failed`. `idle` means total zero; `running` means pending/running work or dirty aggregates remain; `attention` means no work remains but limited/failed counts are nonzero; otherwise `complete`. Counts describe the current version's discovered historical inventory, not fresh live laps. `complete` never means all native signals are supported; unsupported evidence is `attention`, not successful classification. Deleted inventory is removed consistently from counters. `aggregatesPending` remains true until durable refresh catches up.

| Operation | Request | Success | Errors |
| --- | --- | --- | --- |
| `GET /api/sessions/classification-migration-status` | No body | `200 ClassificationMigrationStatus` | Existing API error handling. |
| `GET /api/sessions/classification-migration-recordings` | Optional `cursor`, optional integer `limit` (default 50, range 1–100) | `200 { revision: number, recordings: ClassificationMigrationRecording[], nextCursor: string | null }` | `400 { error: string }` for invalid query; `409 { error: string }` for stale snapshot cursor, then restart pagination. |
| `POST /api/sessions/classification-migration-retry` | `{ recordingId: string }` | `202 { recordingId: string, state: 'pending' | 'running' | 'completed' }` after durable enqueue, or idempotent current state | `400 { error: string }` invalid body; `404 { error: string }` unknown/inaccessible recording; other failures follow existing API errors. |

Recording listing returns unresolved states only (`pending`, `running`, `limited`, `failed`), ordered by stable `recordingId`, with revision-bound cursors and no duplicates. UI restarts pagination on 409. A missing source retry is accepted, then returns to `limited` if still missing; it does not claim repair. No start/confirm, cancel, or defer operation exists: upgrade starts automatically.

Use the existing global WebSocket notification envelope: `{ type: 'classification-migration-status', ...ClassificationMigrationStatus }`. Send full snapshots after durable state changes; older revisions are ignored. On connect/reconnect and inline Refresh, GET authoritative status and unresolved pages; a failed fetch preserves last known state with a translated connection error, never resets to success. Post-commit `lap-reprocessed` notifications retain their existing schema and invalidate affected lap/session/pace queries; refresh those queries on reconnect as well. Maintain all listeners, including affected dashboard queries.

Example partial outcome: `{ "version": 1, "revision": 12, "status": "attention", "total": 4, "pending": 0, "running": 0, "completed": 2, "limited": 1, "failed": 1, "aggregatesPending": false }`. Example unresolved record: `{ "recordingId": "capture-17", "sessionIds": [17], "state": "limited", "reason": "missing_source", "retryable": true }`.

## Presentation boundary

Follow [background-operation composition](../contributing/background-operation-flow.md), not sparse conversion's consent requirement. Mount a feature-owned non-modal dock in the app shell and persistent inline details in `ProcessingMaintenance`. Recording-layout migration has first dock priority, sparse conversion second, classification third; suppression never stops work or hides inline status. Do not add a global queue abstraction.

Pending/running copy says historical pace may change; limited/failed copy distinguishes source limitations from success. Show classified, limited, failed, and pending counts separately. Terminal dock can be dismissed locally without clearing authoritative state; unresolved inline details and retry remain available. Use Paraglide in every supported locale, accessible status/alert text, keyboard controls, and viewport-safe sizing. An empty eligible pace set uses the existing empty state, never a non-pace fallback. Classification badges do not replace validity or experiment exclusion badges.

## Acceptance criteria and E2E evidence map

Each row is required. Scenario definitions below include setup, action, and observable results. Both implementation plans depend on this same matrix.

| ID | Observable acceptance | E2E |
| --- | --- | --- |
| AC-01 | Validity and each category remain independent, including overlap priority and malformed/native-invalid traces. | E2E-01, E2E-02 |
| AC-02 | Native start/yellow evidence survives portable/live/batch/compact/selected replay with no boundary leakage; #222 is repaired without ordinal heuristics. | E2E-01, E2E-02 |
| AC-03 | SQL/pure/default UI pace choices exclude faster non-pace laps before rank/limit, preserve inventory and manual restrictions, and show empty states. | E2E-01, E2E-07 |
| AC-04 | Explicit inspection, API metadata, intentional comparison, export/import, and reprocessing retain category and telemetry, including old exports. | E2E-01, E2E-07 |
| AC-05 | Normal startup automatically discovers and processes historical recordings once per version with no confirmation; identity and unrelated metadata/bytes remain unchanged. | E2E-01, E2E-03, E2E-05 |
| AC-06 | Crash/restart is recording-atomic; committed dirty aggregates recover without replaying completed classification or serving stale results as current. | E2E-03 |
| AC-07 | Ambiguous/missing/corrupt/unsupported sources preserve originals, expose specific limitations, continue other work, and do not spin on unchanged input. | E2E-04 |
| AC-08 | Active capture, shared-file session boundaries, and concurrent processing cannot produce stale overwrites; work remains bounded and live capture/startup remain usable. | E2E-05 |
| AC-09 | Real app restores status after restart/reconnect, exposes translated progress/limitations/retry, refreshes pace caches, and remains accessible at narrow/wide sizes. | E2E-03, E2E-06, E2E-07 |

### Shared E2E execution strategy

Extend `apps/backend/test/e2e/database-upgrade.test.ts` for real `bootServer` subprocess/restart coverage and add classification cases alongside it. Extend the existing seeded Playwright project with `playwright/tests/seeded/sessions/classification-migration.spec.ts`. Existing `reprocessing.spec.ts` uses mocked HTTP/WebSocket and is supplemental only, not migration proof. Follow [E2E conventions](../contributing/e2e-testing.md).

Use isolated temporary DATA_DIRs and a pinned pre-feature release tag/fixture schema, not whichever release is latest at execution time. Seed captures through the release parser/DB path, then boot the changed app against those files. Preserve committed fixture provenance and expected lap/frame matches; snapshot IDs, annotations, associations, timing, offsets, raw checksums, and unrelated analyses. Use the shared production parser/detector with deterministic native fixtures; do not replace DB, worker, parser, HTTP, or WebSocket integration with mocks. The actual #222 capture or faithful protocol fixture with verified start evidence remains a shipping prerequisite, not a conditional skip.

Extend the upgrade subprocess harness to report an ephemeral HTTP address and allow browser attachment to that same upgraded DB. Start/stop only owned subprocesses. Add test-only barriers before transaction, inside transaction, immediately after commit/before rebuild, and during bounded decoding; enable only in explicit test mode. They pause real execution, not replace processing. Drive SIGKILL/restart at barriers, wait on persisted state/readiness rather than sleeps, and remove temporary data after each scenario. The minimal browser extension must use this upgrade harness rather than overwrite the shared seeded server's DB.

| Scenario | Setup → action → required observations |
| --- | --- |
| E2E-01: normal upgrade and parity | Pre-feature DB with pace, out/in/pit, grid (#222), caution, category-only invalid, genuine invalid, and overlapping-category captures → normal boot without start/reprocess request → categories/quality equal fresh processing of same source; faster non-pace never wins; inspect each by ID; invariant snapshot unchanged; second boot performs no completed decode. |
| E2E-02: evidence boundaries | Native fixtures for practice/qualifying Lap 1, first capture mid-race, rolling start, unknown/missing session, restart/rewind/parser reset, first next-lap flag, transient yellow then green, SC/VSC, stale/default flags, first pit exit/final entry, Forza provisional correction, and legitimate versus malformed open traces → replay through actual acquisition/replay entry points, portable batch and compact/selected processing → only positively evidenced categories, correct completed-lap ownership and priority, quality retained; selected processing matches full pass with bounded context priming. Exercise each supported game source; document unsupported evidence as limitation. |
| E2E-03: crash and refresh | Seed old bests and open dashboard in browser; gate before/inside commit and immediately after commit before rebuild → kill/restart at each point → precommit changes/markers roll back together; unfinished work resumes; postcommit pass is skipped but dirty aggregate rebuild drains, old best never presented as current, reconnect invalidates browser queries. Observe persisted state plus HTTP/UI results, not only log markers. |
| E2E-04: limitations and repair | Include duplicate lap numbers across sessions/restarts, mismatched indexes, missing and corrupt sources, absent native signals, and one good recording → boot → ambiguity/corruption fails atomically, missing/evidence is limited, good recording completes, legacy metadata/validity remain reliable, no unchanged-input retry loop; repair file and click real Retry → one durable job, current metadata or explicit remaining limitation; duplicate clicks/restart do not duplicate work. |
| E2E-05: concurrency and load | Multiple sessions share source; finalized backlog plus active capture; pause worker mid-decode → finalize capture and run real import/manual reprocessing/source replacement while worker runs → single ownership, source/result revision mismatch discards stale computation, finalized pending input eventually runs, one source parse per attempt not per lap. At frame-batch barrier, health/status request and live frame ingestion/completion succeed before releasing backfill; assert one worker and bounded buffering independently of library size. |
| E2E-06: status and recovery UI | Browser attaches to real upgrade server with gated work and unresolved records → navigate, reconnect, restart, refresh, page unresolved list, retry, suppress/dismiss dock → counters follow contract, stale revision ignored, cursor revision mismatch restarts listing, status survives browser loss; inline details remain when suppressed/dismissed; no start confirmation. Verify existing dock priorities, keyboard focus, status/alert labels, 390px/1440px layouts and a long-copy locale. Exercise real request failure/recovery by owned server stop/restart, without response mocks. |
| E2E-07: consumers and transfer | Upgraded DB with a faster classified lap, slower pace lap, invalid lap, manual experiment exclusion, and non-pace-only combo → inspect actual session/analyse/compare/dashboard/review/strategy paths → API/default/SQL bests and sectors select only eligible candidates, inventory unchanged, explicit selection warns but works, empty combo has no fallback. Export/import compact/full and legacy export then reprocess through production entry points → telemetry/category preserved or recomputed with context, legacy-null visibly limited/pending rather than silently complete; verify narrow/wide badges and accessible labels. |

Implementation must run all scenarios and record command, fixture/baseline, outcome, and evidence location in the PR or repository's existing evidence location. Required commands include `bun test --timeout 600000 apps/backend/test/e2e/database-upgrade.test.ts apps/backend/test/e2e/classification-migration.test.ts`; `cd playwright && bunx tsc --project tsconfig.json --noEmit`; targeted `E2E_SERVER_MODE=dev PW_SERVER_SET=seeded bunx playwright test --project=seeded-e2e tests/seeded/sessions/classification-migration.spec.ts` from `playwright/`; and root `bun run typecheck`. Run relevant existing consumer suites as supplements. A missing capture, release baseline, browser, dependency, or unimplemented scenario is a named blocker, never passing evidence. Record actual integration outcomes after execution rather than treating implementation as proof.

### Executed automatic-upgrade evidence

The integration owner ran the commands above against isolated v0.19.2 release-seeded ACC, F1, and Tourist data. The upgrade suite passed 12 scenarios; the real browser maintenance scenario passed, including offline Refresh, WebSocket restart restoration, keyboard Retry, completion, and layout-dock priority. Root typecheck, lint, Playwright TypeScript, and targeted native/parser, SQL, and dashboard regressions passed. English 1440px/390px and German 390px maintenance captures were inspected.

The acceptance-specific [execution record](../../.omp/evidence/valid-non-pace-upgrade/acceptance-results.json) links exact commands, logs, and screenshots. AC-05–09 have exercised automatic-upgrade coverage; this is not blanket closure of every edge case in E2E-01–07. Positive #222 repair lacks native start evidence and has a mismatched first historical range; `ambiguous_match` with unchanged rows is the verified safe result. The complete native-boundary, shared-source/load, consumer/transfer, all-locale accessibility, and postcommit pace-view cache matrices remain open as recorded there.

## PR review corrections

The existing API, nullable metadata, validity, replay, and dock-priority contracts remain unchanged. These corrections restore that agreed behavior. Backend and UI owners can implement independently; the integration owner runs the real-system scenarios below after both slices finish.

| ID | Acceptance and edge handling | End-to-end verification scenario |
| --- | --- | --- |
| F01 | Trailing next-lap/delayed-finish context completes detection without owning frames or downgrading saved validity. | Seed a valid exported lap with completion only in trailing context; run the production migration worker; assert category, validity, ID, timing, and owned range remain correct. |
| F02 | Parser bootstrap restores validated game/version state; malformed bootstrap fails atomically. | Import a checkpoint-backed selected F1 capture into historical inventory; run migration; assert full owned-range matches and no partial updates on invalid bootstrap. |
| F03 | F1 checkpoint replay retains start, freshness, and rewind evidence; older checkpoints remain readable with unknown missing evidence. | Split/replay native STLG/LGOT and subsequent race-lap input through production checkpoint restore; compare classifications with continuous parsing, including rewind and older checkpoint cases. |
| F04 | Result reconciliation never changes quality validity solely because a linked pit event exists. | Save valid in/out/pit laps plus genuinely invalid laps; reconcile real session results; assert quality decisions remain unchanged and category evidence remains available. |
| F05 | Supported AC Evo non-race session context reaches full and indexed classification identically; unknown sessions stay unknown. | Replay native AC Evo input through full/indexed parsers and actual detector; run historical migration; assert eligible pace classification and unchanged missing-evidence behavior. |
| F06 | Live reference lap and best sectors use only eligible pace laps; validity-only wear processing remains independent. | Feed non-pace then pace laps through the live pipeline; assert only pace laps seed/replace delta references and sector bests. |
| F07 | Source replacement registers the new group and prunes obsolete groups; deletion removes orphan counts without restart. | Reconcile inventory, compress/relocate a source or delete its last session, run idle scheduling, then inspect real status/list APIs; assert current groups only and destination processing. |
| F08 | Empty Race/Quali pace subsets show empty statistics without losing filter controls. | In the app, open track data with single-lap pace and multi-lap non-pace sessions; select Race then All; assert no crash, empty statistics, and restored pace statistics. |
| F09 | Postcommit and reconnect refresh Track Detail classifications and pace results without navigation. | Open real Track Detail during gated migration; release commit and reconnect; assert track-lap requests refresh and faster non-pace laps cease contributing. |
| F10 | Dock priority is layout, sparse, classification, including completion/dismissal; inline details remain available. | In the actual app, show concurrent operation states at 390px/1440px; complete/dismiss sparse work; assert only the highest-priority dock appears and classification becomes available afterward. |
| F11 | Legacy fixtures match main's exact `invalid_reason='inlap'/'outlap'` representation with `is_valid=0`, rather than preclassified rows. | Seed those rows before upgrading through the real migration list; assert `in_lap`/`out_lap` backfill retains original validity/reason. Then replay available source through normal boot and assert only justified quality reassessment can restore validity; missing source retains the legacy decisions. |

Reuse backend upgrade/replay suites and the seeded Playwright upgrade attachment. Add focused regressions at existing seams; mocks do not replace real parser/DB/HTTP/WebSocket integration. Run targeted suites, changed-path runtime smoke, root typecheck, and applicable lint checks. Record passed/failed/blocked outcomes per correction; unavailable fixtures or runtime dependencies are verification gaps, not success.

### Correction verification

The [correction execution record](../../.omp/evidence/pr469-review-fixes/results.json) records passing production-upgrade scenarios, native and consumer regressions, main-compatible legacy pit fixtures, real browser integration, typechecks, lint, and inspected 390px/1440px captures. The upgrade suite includes checkpoint-dependent F1 replay, malformed-bootstrap atomic failure, selected ACC trailing completion context, and source replacement/deletion. Legacy pit reasons are checked before upgrade; source reassessment can restore validity only when recording quality supports it, while genuine native/manual failures remain invalid.

This correction-specific evidence does not close the pre-existing broader feature gaps listed above, including the absence of positive native start evidence in the real #222 capture.
