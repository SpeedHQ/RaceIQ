# LMU opponent cold-load backend plan

Status: implementation changes are present, but acceptance remains incomplete. E2/E7/E9 require production-path evidence; OP11 raw source analysis now identifies a qualifying complete opponent lap in the October 24 recording. Results and earlier blockers are recorded in the [contract](lmu-opponent-cold-load-contract.md#execution-evidence--2026-10-24).

Shared boundary: [contract](lmu-opponent-cold-load-contract.md). Acceptance OP1–OP11, lifecycle/error definitions, and E1–E11 live there rather than being redefined here. OP10/E10 remains UI-only; OP11/E11 covers backend source-backed lap boundaries. Related frontend work: [UI plan](lmu-opponent-cold-load-ui-plan.md).

## Ownership and prerequisites

Backend integration owner owns the shared contract, `packages/lap-replay/contracts/opponents.ts` and its exports, private persisted index schema, publication references, worker coordination, and final E2E execution. Publish the agreed DTO additions and contract-conforming fixtures first; UI and backend implementation then proceed independently. A real backend is a final integration dependency, not a prerequisite for UI development.

Owned existing surfaces:

- `server/session-capture/direct-recorder.ts`: post-seal/final-manifest handoff only; no added work in frame append/recording paths.
- `server/session-capture/maintenance-runtime.ts` and existing capture finalization/import/startup admission: managed idle work, recovery discovery, shutdown, and recording priority.
- `server/lap-analysis/lmu-opponent-laps.ts`: reusable streaming interval rules and native export path.
- `server/session-capture/source-loader.ts`, `lmu-companion.ts`: source identity/integrity and selected-source access.
- `packages/lap-replay/server/opponent-routes.ts`: metadata-only catalog and selected-block comparison/replay reads.
- Existing opponent removal, source relocation/rewrite, cleanup, persistence, and storage accounting modules reached by source-reference changes.
- Existing LMU integration/recording/browser suites named in the contract; recording architecture/maintenance documentation and `CHANGELOG.md` after implementation verification.
- `apps/backend/scripts/data/seed-db-runner.ts` and its launch callers: fresh seeded-capture preparation, existing-seed reconciliation, final-layout ordering, and worker completion before seed-process teardown.
- `shared/racing/sessions/types.ts`, session/lap metadata projections, `packages/sessions-page/server/session-routes.ts`, and affected heavy-content read boundaries: authoritative queued/processing status and stale-client opening guards. Backend owner owns these shared metadata DTO additions.

Place new index reader/writer/schema/worker code under existing backend lap-analysis/session-capture ownership, following current worker conventions. Confirm exact finalization and maintenance callers before editing. Use LSP references for changed exports. Before Effect changes, run `effect-solutions list` and relevant topic guidance; verify installed Effect version and the repository's maintenance invariants.

## Implementation tasks

### B1 — Shared types and private storage design (OP1–OP6)

Publish contracted `indexState` and error codes without changing existing comparison/replay payloads. Define versioned private schema, source dependency identity, atomic publication reference, digest/size limits, and block locators before implementation. Reuse existing lossless value/context encoding and storage patterns. Preserve exact large timestamps and distinguish absent/empty/missing/stale values.

Use the contract's [private index boundary](lmu-opponent-cold-load-contract.md#private-index-boundary-version-1): identity-keyed observation blocks and shared context blocks avoid reading unrelated opponent channels. Verify fragmented observations and context reconstruction through E2/E3; block limits must not truncate supported samples.

Persist catalog summaries plus comparable-channel facts for each player lap so catalog reads do not call `getLapById` or decode player packets. Preserve current sorting, grouping, opponent IDs, and paired-channel semantics. Persist ordered, independently readable shared observation blocks with enough boundary/context data for exact interval reconstruction. Bound retained build state and avoid entire-session decoded arrays, export buffers, and whole-grid-per-opponent duplication.

### B2 — Finalization and launch-seed admission (OP4, OP5, OP7)

Find the existing successful seal/manifest/reference commit points for direct capture and import. Queue eligible physical source publications after those points; never build in recorder append paths or synchronously await build from finalization. Several database session generations sharing a recording must produce one job/publication.

Use existing backend lifecycle, storage reservation, maintenance lock, write permit, and tracked-worker ownership. Admit at most one build and only while no recording is active/draining. Yield at bounded block boundaries if recording starts; retain safe unpublished staging or restart later. Recording startup must never await a session scan or worker completion. Check startup/shutdown ordering so recording finalization during shutdown does not enqueue work into a disposed runtime; startup discovery handles deferred work.

Discover finalized unindexed sources, interrupted jobs, and incompatible index versions through startup/idle reconciliation. HTTP routes only read state and never enqueue repair/backfill. Imports use the same finalized-source path, not a second indexer.

Awaited reconciliation uses the contract's explicit ready/pending outcome; deferred admission must not be logged as completed opponent preparation. Eligible preparation failure remains an explicit failure. E8 verifies both outcomes through the launch entry point.

Launch-time lap seeding must call the same index preparation after native capture finalization and any requested final-layout conversion. Extend `apps/backend/scripts/data/seed-db-runner.ts` for both fresh imports and the existing-seed early return at `seedRowCount()`: already-present lap rows must not bypass missing/interrupted/incompatible index reconciliation. Reuse valid matching publications without a full rebuild or lap reimport. Await eligible seeded preparation before reporting opponent readiness and before the seed runner's maintenance teardown/process exit; do not enqueue into a disposable runtime and lose the job. Persist/discover pending work if recording prevents admission; never perform indexing during recording or block recorder startup. Record seed/import/build durations separately. Verify the actual launch caller as well as standalone seed execution.

### B3 — Streaming preparation and publication (OP1–OP5)

Validate native integrity once per unchanged sealed publication during preparation. Stream through existing decoding and interval rules, write bounded observation blocks, and finalize catalog/locators. Build player comparable-channel facts during preparation, not catalog requests. Avoid extra native restoration where existing trustworthy decoded observations can provide exact output; never remove source validation to optimize backfill.

Write unique staging artifacts; validate schema, ranges, block hashes, interval reconstruction, and source identity. Recheck source ownership, revision, file identities, retention, and recording admission before atomic publication. Keep CPU/I/O outside database write permits. Publish no partial ready index. Record build duration, peak RSS, bytes, and bounded in-flight overlap for verification without adding unrelated telemetry infrastructure.

### B4 — Request-path cutover (OP1–OP4)

Replace request-time session indexing and its 30-second cache dependency with persisted publication lookup. Catalog reads metadata and validates dependency identities only; it does not hash the whole native companion after restart. Comparison/replay validate requested revision, read selected blocks plus required boundary/context, and reuse existing selected-player-lap loading/alignment/projection.

Implement readiness/error precedence exactly as contracted. Preserve empty-ready catalogs, missing/removed/corrupt native states, strict game/ownership validation, comparison bounds, timing-only behavior, and unchanged response representations. Bound any optional selected-block cache; restart must remain fast without it. Remove obsolete request-side scan code once all callers migrate; retain native reconstruction only for consumers such as byte-exact export that require it.

### B5 — Integrity, recovery, and ownership (OP3–OP5)

Invalidate on changed/replaced/missing native dependencies, changed player publication facts, index version mismatch, and derived corruption. Detect same-size rewrites and replaced files using existing identity fields including ctime where needed, not source revision alone. Corrupt selected blocks fail explicitly; repaired sources are background-validated before republishing. Failed writes and interrupted staging never become authoritative.

Coordinate opponent removal against pending workers and publications so removed data cannot reappear. Include derived artifacts in deletion/privacy cleanup and storage accounting. Preserve reference-safe partial lap deletion and native byte-exact export/import. Relocation and source rewrites invalidate or republish source-bound locators under existing fences. Shutdown awaits owned I/O/worker cleanup before releasing leases or closing database connections.

### B6 — Session/lap queued and processing gates (OP8, OP9)

Project the contracted non-null `processing` metadata onto session/lap lists from existing capture/job/publication facts without decoding native frames or fetching each opponent catalog. Include post-finalization, launch-seed, import, and rebuild queues, not only actively running jobs. Aggregate shared-source dependencies correctly while keeping unrelated rows usable. Preserve active live-recording behavior and player-only access when opponent retention is not required. Add readiness checks before affected heavy reads; preserve metadata/status access and existing error precedence. Backend authority, not spinner state, prevents a stale client from loading incomplete content. Use existing invalidation/query facilities; no new job-start API.

Include `getLapSummariesByTrack()` and the existing `TrackLap` all-laps response in the same bulk projection. E9 additionally verifies an older ready track lap outside the latest-200 global list and an affected pending neighbor; no per-row lookup or optimistic fallback is permitted.

Project processing onto existing chat-linked lap summaries through one distinct-ID bulk lookup per chat response, preserving missing/deleted reference behavior. E9 covers historical linked laps outside the global list limit.

## Acceptance and edge handling

Backend acceptance references OP1–OP9 and OP11, with E1–E9 and E11 in the contract. OP10/E10 remains UI-only. Cover recording restarts mid-build, finalization during shutdown, shared generations, no-opponent recordings, malformed or incompatible blocks, source races, repair, removal, low-disk/write failure, launch-seed reconciliation, opening gates, and ambiguous lap boundaries. Do not silently serve the old session-scan implementation for any state.

### B7 — Source-backed lap completeness (OP11)

Update `server/lap-analysis/lmu-opponent-laps.ts` to require native track-distance traversal for complete coverage. Counter increments alone cannot establish a full lap. Keep intervals with ambiguous/missing boundaries partial, retain their observed samples for replay, and preserve genuine gaps. Genuine sequence gaps do not negate full geometric coverage and remain absent; no interpolation. Include track length from decoded native scoring info only when available; do not guess a circuit length or fabricate observations. Bump `LMU_OPPONENT_INDEX_ALGORITHM_VERSION` so existing publications rebuild under corrected coverage rules.

Acceptance: OP11. Extend E3 boundaries and execute E11 against the October 24 raw recording through production decoding/indexing and route output. Confirm vehicle 16 lap 8 remains complete while vehicle 50's partial and short counter-wrap intervals do not become complete.

## Verification and completion dependency

Execute E1–E10 through actual ingress/import/launch seeding, finalized files, durable publication, production Hono routes, UI decoder, and real browser surfaces. E10 adds no endpoint or storage change; verify the existing partial-coverage recording through production comparison/replay. Extend existing opponent route, export/import, recorder safety/removal, seed idempotency, sessions-page navigation, and comparison browser scenarios. Add focused deterministic tests for uncertain index boundaries and publication races; compiler/unit success alone is insufficient.

E1/E5/E6 prove OP4/OP5 and scheduling/recovery; E2 proves OP1/OP2 plus real OP3/OP6 integration; E3 proves OP3; E4 proves OP3/OP4; E7 proves OP6 with UI owner. Gate interleavings with controlled barriers rather than sleeps. Use isolated data directories and actual files; mocks cannot substitute for the integration under test.

E8 proves OP7 and its OP1–OP6 integration: run fresh launch seeding, restart and select an opponent, repeat with a valid publication, then repeat with missing/interrupted/incompatible derived output and existing seed rows. Assert unchanged native lap identities/source bytes, correct publication reuse/rebuild, no work lost on seed-process exit, and deferral if recording starts.

E9 proves OP8/OP9 plus OP4–OP7 integration: hold real jobs queued/running, verify metadata state and heavy-read rejection, fail/repair them, and exercise actual session/lap UI and direct links. Assert shared-source aggregation, unaffected rows, no native status scan, and no false readiness while recording defers the queue.

Run real-recording performance verification alone, with separate restarted processes per measured path. Record source identity, first-click preparation time separately from ready-load time, bytes/blocks read, native frame/player decode counters, response bytes, CPU/RSS, and matched own-lap timing. Include OS-cache caveat. Run affected backend/replay/LMU compiler gates and relevant existing tests after integration. Update docs/release notes only for implemented verified behavior. Record every E1–E11 outcome and unmet target; completion requires all criteria and mapped edge paths passing, not merely a ready UI fixture.
