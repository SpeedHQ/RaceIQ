# Valid non-pace lap classification — issue #229

Status: automatic-upgrade implementation in progress against the linked contract. Full-feature completion and architectural approval are not implied.

Issue: [#229](https://github.com/SpeedHQ/RaceIQ/issues/229). Origin: [#222](https://github.com/SpeedHQ/RaceIQ/issues/222).
ADR: [Separate validity from pace classification](../adr/0011-valid-non-pace-laps.md).

This document is the feature requirements and sequencing overview, not a combined UI/backend implementation plan. Implementation is split into [backend](valid-non-pace-laps-backend-plan.md) and [UI](valid-non-pace-laps-ui-plan.md) plans against one [shared contract and E2E matrix](valid-non-pace-laps-contract.md). The contract specifies the proposed boundary; reconcile changes in both plans before either implementation begins. Once that boundary is agreed, UI work can proceed with conforming development fixtures in parallel with backend work. Real integration verification is a shared completion dependency.

## Outcome and scope

Preserve valid telemetry for out laps, in laps, grid-start laps, and caution/yellow laps without treating those laps as ordinary flying-lap pace. Expose their category to API/UI consumers and retain explicit inspection. A classification must never be inferred solely from Lap 1, the first recorded lap, or the slowest lap.

Cover live detection, batch processing, persistence, import/export, reprocessing, API metadata, pace consumers, and existing lap inspection surfaces. No redesign, new analytics feature, manual classification editor, new capture format, or speculative detection for unsupported simulators.

## Baseline before this change

- `packages/analysis-core/src/racing/laps/pit-cycle.ts` detects pit cycles but encodes them as `outlap`, `inlap`, and `pit lap` invalid reasons. `isPitCycleLap` reads `invalidReason`.
- `packages/telemetry-core/src/processor/lap-policy.ts`, `server/lap-detection/detector.ts`, and `server/games/kunos/lap-detector.ts` combine pit-cycle policy with validity. LMU's policy also has a first-completed-lap outlap fallback; this is not sufficient classification evidence.
- `assessLapRecording` checks packet count, distance, timing consistency, and start/end closure; ACC has a special starting-lap rejection. Legitimate non-pace paths can fail closure, so separating a field alone will not make these recordings valid.
- `server/db/schema.ts` and `shared/racing/sessions/types.ts::LapMeta` expose validity/reason but no independent category. Raw capture filename, byte offset, and frame count already support telemetry retrieval.
- `packages/analysis-core/src/racing/laps/stint-stats.ts` can discard the lowest lap number as a presumed out lap. Other consumers use validity, pit reasons, or neither to choose pace baselines.
- Portable processing is already owned by `@raceiq/telemetry-core` and `@raceiq/telemetry-processor`. Add shared behavior there rather than another server-only detector.

## Proposed contract

The authoritative cross-layer definitions are in the [shared contract](valid-non-pace-laps-contract.md#lap-metadata-and-pace-eligibility): nullable classification, independent validity, category precedence, pure/SQL eligibility, legacy compatibility, and explicit inspection. Native evidence and quality rules below remain authoritative for detection.

## Evidence and detection rules

- **Pit cycles:** reuse native pit transitions and existing Forza boundary evidence, preserving provisional/finalized lifecycle semantics. Remove classification based solely on first completed lap. Record category separately from genuine native-invalid or incomplete reasons.
- **Grid start:** require positive race-start context tied to the current session/start, plus lap/boundary evidence. Grid position, race position, near-zero session time, distance offset, or Lap 1 alone is insufficient. A known race session and a confirmed start transition can qualify; rolling starts must not be mislabeled grid starts.
- **#222 specifically:** obtain the original F1 capture or a faithful protocol-level fixture. It reports Lap 1, `CurrentRaceTime=0.342`, `RacePosition=3`, `f1.gridPosition=3`, first distance 222.45 m, and `sessionType='unknown'`. Inspect accumulator timing and available start/session packets; preserve positive start evidence even when the first emitted packet lacks session type. If decoding/projection omits a necessary native start signal, expose that signal at its game-owned boundary. Do not solve this by treating all unknown-session Lap 1 recordings as starts. The supplied scalar values alone are an ambiguous negative test, not sufficient positive evidence. Actual #222 behavior must be demonstrated before shipping; missing capture/start evidence is a named verification prerequisite, not permission to narrow acceptance.
- **Caution:** latch an applicable caution/yellow observation anywhere within the completed lap; a later green flag must not erase it. Distinguish global safety-car/full-course states from a yellow applicable to the player; either may exclude the affected player's lap, but a local flag must not be advertised as a global caution. Exclude non-yellow flag states and formation/start states unless they independently satisfy a named category.
- **Temporal boundaries:** associate evidence with session identity, source frame/time, and completed-lap interval. Reset on restart, rewind, session change, and parser reset. Do not transfer the new lap's first caution observation to the previous lap. Missing/stale/defaulted source state is unknown, not an observed clear flag; inspect current accumulator freshness before defining per-game handling.
- **Validity:** remove pit-category-only invalidation, not quality checks. Retain insufficient packets/distance, timing mismatch, incomplete recording, and genuine native invalidation. For evidence-backed grid/pit paths, adapt only the closure/completeness assumptions that are inappropriate to that path; do not bypass all quality checks. Review ACC starting-lap rejection against actual completeness rather than blanket conversion to valid.

Source investigation found that `test/artifacts/sessions/f1-2025-2026-04-22T11-42-43-029Z.bin.gz` reproduces #222's reported values but contains no start-event packets and retains unknown session context. It is not positive proof of `grid_start`. Its first released window also differs from current detection; strict automatic matching must report `ambiguous_match` and preserve all saved laps, despite four later exact matches. The ACC recording `acc-2026-04-23T16-42-16-158Z.bin.gz` provides a source-supported normal-upgrade fixture with exact historical frame-range matches: two valid pace laps, one native-invalid pace lap, and one incomplete pit lap. These source diagnostics do not replace the required E2E evidence.

### Source support to verify in phase 1

| Game | Existing pit evidence | Caution/start investigation |
|---|---|---|
| F1 2025 | `f1.pitLaneTimerActive` | `vehicleFIAFlags` and `safetyCarStatus` are decoded and projected. Verify protocol enums, applicability, accumulator freshness, session/start evidence, and compact indexing. |
| ACC | `acc.pitStatus` | No sufficient caution source established by scoped review; inspect supported native acquisition before declaring unsupported. |
| AC Evo | `acc.pitStatus` | Parser exposes `flagStatus`; verify native yellow meaning, scope, enum values, and compact projection. |
| iRacing | `iracing.onPitRoad` | Audit native session-flag availability through source frames/normalization; scoped review did not establish a usable projection. |
| LMU | `lmu.inPits` | Audit native scoring race-control/session-phase fields and projection; do not use first-completed-lap fallback. |
| Forza Motorsport | Existing race-off/timing-gap/fuel/tire transition evidence | No reliable caution source established; do not invent one from slow speed. |

This table is an investigation boundary, not a claim that unverified protocols lack flags. Implement supported native caution sources within this feature; document genuine source limitations.

## Workstreams and sequencing

### 1. Classification and detector behavior

- Resolve protocol evidence and #222 fixture prerequisite first. Specify a per-game supported/unsupported matrix with native meanings and freshness.
- Add shared classification and pace policy; migrate pit-cycle classification out of invalid-reason decisions. Preserve existing Forza cross-boundary/provisional updates, Kunos resets, iRacing boundaries, and EOF/incomplete handling.
- Carry classification through portable completion/results and compact/indexed processing inputs. Live, batch, replay, and selected-lap reprocessing must use equivalent evidence; context priming must retain session/start/caution state without replaying the entire capture for every selected lap.
- Remove first-lap heuristics, including LMU's outlap fallback and stint-stat presumed-outlap filtering. Review callsites of their options rather than leaving obsolete knobs.
- Prove positive and negative detector cases before downstream cutover, including overlapping categories and invalid-plus-non-pace laps.

### 2. Persistence, historical data, and transfer

- Update `server/db/schema.ts`; append the next migration to `server/db/migrations.ts`. Never change released migrations or use `db:push` for runtime schema changes.
- Add classification to insert/update/provisional/finalization paths in `lap-mutation-queries.ts`, `session-result-queries.ts`, detector DB contracts/adapters, and processor result DTOs. Native result in/outlap metadata must update category without blanket invalidation.
- Propagate through `server/db/lap-meta.ts::toLapMeta`, all lap/list/summary projections, `LapMeta`, and actual registered API/WebSocket completion payloads. Resolve route ownership from the current checkout rather than assuming a `server/routes/` directory.
- Backfill exact legacy `outlap`, `inlap`, and `pit lap` reasons into categories. Do not automatically turn `isValid` true: historical rows may have suppressed recording-quality failures. Keep their existing validity until the common detector reassesses raw telemetry. Leave other historical categories `null`; never classify from lap number.
- Update `server/session-capture/reprocess.ts` and `server/db/lap-reprocessing-queries.ts` to recompute validity/category together from raw captures. Add an automatic upgrade migration for existing recordings as specified below; manual reprocessing is not the upgrade path. Preserve lap identity and associated favorites, notes, experiments, raw offsets, and telemetry retrieval. Reprocess the #222 capture through the upgrade path to repair its historical classification. Missing raw data leaves legacy state explicit, not fabricated.
- Check selected-lap/session export and import, both compact and full paths. Include category where metadata is transferred; recompute with preserved context where raw data is processed. Old exports remain readable with legacy-null semantics. Keep raw bytes unchanged.
- Extend dashboard classification projection/trigger handling and invalidate affected persistent read models in the same transaction as metadata and migration markers. Rebuild asynchronously through existing workers; drain durable dirty work on restart independently of classification completion. Refresh query caches after commit and on reconnect. See the [transaction boundary](valid-non-pace-laps-contract.md#recording-lifecycle-and-transaction-boundary).

#### Automatic migration for users upgrading

- After the schema migration, automatically discover existing recorded sessions and enqueue a versioned classification backfill. No user action, reimport, or recording recreation is required. Persist processing-version and per-recording completion/failure state separately from category: `null` alone cannot distinguish pending work from unavailable evidence.
- Run after DB readiness with bounded background work so a large recording library does not block startup or live capture. Process each recording once per classification version through the shared parser/detector, retaining session/start/caution context. Do not decode the whole recording separately for every lap.
- Update existing laps in place. Match computed laps against existing recording/frame ranges and session boundaries, not lap number alone. If a match is ambiguous, preserve the original and report the failure; never delete/recreate laps to make matching succeed. Preserve IDs, favorites, notes, experiment associations, ownership, raw files, and telemetry indexes. This migration changes classification and justified validity/reason metadata, not historical lap timing or unrelated analysis results.
- Reassess actual quality before restoring validity on category-only invalid laps. Preserve genuine native-invalid, incomplete, and malformed recording outcomes. Do not clear unrelated user decisions or experiment exclusions.
- Commit metadata updates, successful version markers, and durable aggregate dirty flags/source revisions atomically per recording. Resume unfinished recordings after restart; completed classification passes are skipped, but committed dirty aggregates still rebuild. A crash or decode/match failure must not leave a recording partially migrated or incorrectly marked complete. Coordinate import/manual reprocessing, startup historical repair, shared capture ownership, and source/result revisions so stale work cannot overwrite newer results or read unfinished captures.
- Missing/corrupt raw files or absent native signals must not abort other recordings. Persist and expose the specific outcome; preserve reliable legacy category backfill and existing validity. Retry interrupted work automatically, but never spin on unchanged failed/limited input. Feature-owned retry durably requeues repaired input through the automatic worker; it must not invoke destructive manual reprocessing to resolve matching.
- Surface progress and unresolved recordings through the contract's feature-owned status/list/retry operations, existing global WebSocket transport, non-modal dock, and inline maintenance UI, with translated copy. While work is pending, indicate that historical pace results may still change. Restore authoritative state and query caches on reconnect; never rely on notification delivery for durability.
- Accounting is complete when every pre-upgrade recording has a successful current-version pass or a visible terminal source/evidence limitation, and affected aggregates have caught up. Limitations are `attention`, not successful classification. The #222 recording must become excluded from default pace automatically when its source provides sufficient start evidence.

### 3. Pace consumers and inspection UI

- Apply eligibility before best-lap/sector/rank/limit calculations in `server/db/lap-read-queries.ts`, `session-queries.ts`, `tune-queries.ts`, dashboard queries/read models, recap, and `server/driver-profile/trend.ts`.
- Migrate `review-selection.ts`, `stint-stats.ts`, `server/experiments/auto-exclude.ts`, strategy pace estimates, automatic AI/review benchmark selection, and comparison default/reference selection. Keep recorded/driven totals and all-lap counts distinct from pace-only statistics; do not filter classified telemetry out of inventory totals.
- Update `RecordedLaps.tsx` best lap/sectors, `LapTimeChart.tsx`, lap selectors/hooks, session summaries, and comparison defaults. Add translated category labels in every supported locale, using existing badge/filter components. Keep classification separate from invalid badges and experiment exclusions.
- Sessions-table timeline integration is a planned extension, not covered by the completed maintenance-flow checks: combine recorded-lap classification with retained native race events according to the [timeline contract](session-classification-timeline-contract.md), [UI plan](session-classification-timeline-ui-plan.md), and [backend plan](session-classification-timeline-backend-plan.md). TL-01–08 specialize the timeline portion of AC-01/04/09; implementation and actual TL-E01–08 evidence remain required.
- Keep non-pace rows discoverable in normal history/inspection; normal pace selectors default to pace candidates. When no eligible lap exists, show the existing suitable empty state rather than silently choosing a non-pace fallback. Explicitly selected non-pace IDs remain inspectable/comparable with clear notice.
- Search remaining pace-related `isValid`, `invalidReason`, `isPitCycleLap`, and first-lap assumptions within affected consumers. Remove obsolete classification-reason helpers and migrate all callers; no parallel legacy policy. Genuine quality-reason presentation remains.
- Update maintained lap/detection documentation and add one customer-facing Unreleased changelog entry after behavior is verified.

## Verification and acceptance

Use the authoritative [AC-01–AC-09 acceptance matrix and E2E-01–E2E-07 scenarios](valid-non-pace-laps-contract.md#acceptance-criteria-and-e2e-evidence-map). It defines controlled fixtures, setup/action/observable outcomes, boundary handling, actual entry points, harness extensions, commands, and execution ownership. Both implementation plans map their own criteria to that matrix.

| Requirement | Stable acceptance IDs | Required E2E |
| --- | --- | --- |
| Independent validity and all named categories | AC-01 | E2E-01/02 |
| #222 repair, native caution/start evidence, temporal boundaries | AC-02 | E2E-01/02 |
| Pure/SQL/default-consumer pace exclusion and preserved inventory | AC-03 | E2E-01/07 |
| API/category exposure, explicit inspection, transfer and reprocessing | AC-04 | E2E-01/07 |
| Automatic historical upgrade, identity preservation, completed-pass skipping | AC-05 | E2E-01/03/05 |
| Recording atomicity and postcommit aggregate recovery | AC-06 | E2E-03 |
| Missing/corrupt/unsupported/ambiguous input and repair | AC-07 | E2E-04 |
| Active captures, concurrent processing, shared sources, bounded work | AC-08 | E2E-05 |
| Real status/retry/reconnect/cache integration and accessible UI | AC-09 | E2E-03/06/07 |

Extend the existing release-database upgrade E2E suite and seeded Playwright project, not a mock-only replacement. The integration owner runs all required scenarios after implementation and records command, fixture/baseline, outcome, and evidence by acceptance ID. Relevant focused suites and `bun run typecheck` supplement E2E, not replace it. Completion requires passing evidence for every criterion and edge case; missing #222 source evidence, unavailable environments, skipped tests, and unexecuted scenarios remain explicit blockers.

Implementation verification: automatic-upgrade regression gates pass against pinned v0.19.2 data: 12 real boot/crash/concurrency scenarios and the actual HTTP/WebSocket browser maintenance flow, plus root typecheck/lint and targeted native, SQL, and dashboard regressions. See [executed evidence and remaining full-feature acceptance](valid-non-pace-laps-contract.md#executed-automatic-upgrade-evidence). Positive #222 start repair remains blocked by absent native start evidence and its mismatched first historical window; the complete broader feature matrix is not claimed as passed.
