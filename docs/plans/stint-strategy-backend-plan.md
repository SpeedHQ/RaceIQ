# Durable stint strategy — backend implementation plan

Status: implemented and verified. Boundary, DTOs, retention, formulas, compatibility, errors, and E2E scenarios are authoritative in the [shared contract](stint-strategy-contract.md). Parallel counterpart: [UI plan](stint-strategy-ui-plan.md).

## Goal and ownership

Persist explainable per-stint fuel/tire averages and pit-estimate history; use compatible persisted evidence in later stints without decoding old raw laps. Backend owns ingestion, deterministic aggregation, storage, typed HTTP, and live publication. Integration owner owns shared DTO changes and final combined E2E execution. UI can proceed independently against contract-conforming fixtures once shared DTOs are published; it need not wait for backend storage.

Owned existing surfaces:
- `server/live-strategy/pit-tracker.ts` and `tracker-math.ts`.
- `server/telemetry/live-pipeline.ts`, `pipeline-ports.ts`, production/test adapters, and `server/runtime/websocket-manager.ts` as required for durable writes and notifications.
- `server/db/schema.ts`, `migrations.ts`, responsibility-scoped strategy query module (new), and session lifecycle queries/reprocessing integrations.
- `apps/backend/src/routes/session-routes.ts` and route composition if a focused route module is preferable.
- `apps/backend/test/live-strategy/pit-tracker.test.ts`, `pit-cycle.test.ts`, and focused new aggregation/storage/integration tests.
- Fixture ingestion/restart controls for the focused Playwright strategy scenarios.

Shared prerequisite: integration owner defines/export DTOs through existing shared package conventions; run LSP references before changing exported contracts. Preserve semantic and adapter policy authorities linked in the contract. Read Effect guides before any Effect implementation. Do not change simulator acquisition or implement a parallel race-event system.

The shared record-identity clarification requires estimate snapshots to freeze game/track/car/PI/compounds. Validate pending writes against the current session context and reject stale identities after correction or deletion. B5/B7/B9 and E4/E7/E8 cover this boundary.

## Acceptance mapping

| Backend ID | Observable acceptance | Contract / E2E |
|---|---|---|
| B1 | SQLite persists idempotent lap contributions, summaries, and server-authored estimate records; migration upgrades an existing database without altering historical migrations | C1,C2,C6,C7; E1,E2,E6,E8 |
| B2 | Independent fuel/wheel/pace numerators and counts match hand calculations; boundaries, unavailable data, and service intervals have explicit reasons | C2,C6; E2,E5 |
| B3 | Exact-compatible bounded history query returns weighted rates and source references without raw telemetry reads; fuel/tire history permissions and takeover rules are respected independently | C4,C5,C6; E3,E4,E6 |
| B4 | Typed HTTP and post-commit WebSocket publication implement shared ordering, pagination, clear, auth, and errors; no client-authoritative estimate POST | C1,C5,C7; E1,E7,E8 |
| B5 | Crash/reconnect, replay/rebuild, deletion, identity correction, stale async results, and storage failure preserve lifecycle invariants | C6,C7; E5–E8 |
| B6 | Production ingestion/storage/API is exercised jointly with actual live/session browser surfaces; focused regressions and final typecheck pass | C8; E1–E9 |

Review-correction acceptance: **B7** implements C6a's typed compatibility, metric-specific eligibility, and context-change boundaries (E4/E5); **B8** implements C7a's durable epoch/sequence ordering, cursor generations, and serialized clear versus queued writes/restart (E7); **B9** implements C7b's transactional namespace revisions and active-tracker refresh, rejecting stale baseline reads after source-session deletion/correction/rebuild (E7/E8). B6's joint verification also covers B7–B9.

## Implementation tasks

1. **Shared boundary first.** Publish shared DTOs and validation under existing racing/live/session exports; agree source units and driver-key extraction with current adapters. Keep unresolved native identity explicitly unavailable. Confirm which persisted session/participant context is already available; use the contract's explicit local-player bucket only for the local source, not name matching.
2. **Append migration and query layer.** Add the three record tables, unique source/lap keys, compatibility lookup indexes, foreign-key deletion, and clear watermark. Store metric sums/counts and provenance, not only rounded averages. Query/filter compatibility before the latest-20 bound. Do not use `db:push`. Add atomic contribution/summary/estimate persistence and versioned staged rebuild activation.
   - Persist the contract's epoch registry, source admission high-water marks, clear generations, and `(gameId, driverKey)` history revisions as supporting metadata. Admission assigns stable source sequence before async writes; clear serializes against admission and rejects queued writes at/below its watermark. Reprocessing retains epoch mappings and never appends immutable estimate observations. Use the shared source-order tuple for pagination, not native milliseconds.
3. **One aggregation path.** Build a small deterministic stint accumulator in the strategy subsystem using existing pit-cycle evidence and canonical semantic availability. Feed reliable completed-lap evidence and link it to saved lap identity. Remove dependence on per-frame lap-number rollover as the authority for persisted metrics; preserve live mid-lap projection as a separate concern. Apply metric-specific validity, boundaries, and unit rules exactly as shared contract defines. Reuse this accumulator during source-backed reprocessing rather than implement separate historical math.
   - Persist and expose `CompatibilityContext`; resolve semantic versions and stable adapter setup keys without fabricated identities. Apply the shared unknown-value and per-metric rules before bounding history; split/rebaseline when compatibility-defining context changes. Conditions remain explanatory, not an undocumented eligibility filter.
4. **Persist through lifecycle.** Integrate startup/session start/lap save/stint boundary/shutdown and crash recovery. Keep DB work outside per-frame synchronous estimation; ordered writes use stable source identities and publish revisions only after commit. Guard async responses by session/driver/epoch/generation. Persist summaries incrementally so crashes lose at most uncommitted evidence, not the whole session. Complete finalization without inventing terminal service events.
5. **Replace historical seeding.** Remove `getLaps`/`getLapById` historical raw-decode seeding from `PitTracker`; load only compatible summaries. Keep historical baseline separate from current-stint histories; apply per-metric 2/3-lap takeover. Preserve current rolling/projection behavior where supported, reset tire curves only on incompatible tire state, and respect adapter seeding permissions. Update all source/provenance consumers rather than add a second fallback path.
6. **Expose reads and clear.** Implement the shared HTTP operations with validated game/session/driver boundaries and existing access protections. Add paginated stable ordering, clear-watermark semantics, and post-commit revision notifications. Integrate deletion, identity correction, and reprocessing cache invalidation so historical baselines cannot retain deleted or relabeled evidence.
   - Increment old/new game/driver history namespace revisions in the evidence mutation transaction, then emit `strategy-history-updated`. Baseline reads must be snapshot-consistent with that revision. Dirty affected active trackers across sessions, reject cached/late baselines below the committed revision, and reload while preserving current samples; use provisional current rates or the contract's pending reason until refreshed. Keep estimate-clear notifications separate because clearing the ledger does not alter reusable evidence.
   - Emit the shared `strategy-estimates-cleared` event after every successful clear, including empty ledgers, without changing reusable-history revisions. E7 proves cursor reset in both mounted clients.
7. **Joint integration verification.** Supply deterministic source fixtures and process controls; execute B1–B9 against the implemented UI using shared E1–E9, including C6a/C7a/C7b. Update applicable backend documentation and coordinate one user-facing changelog entry after behavior is verified.

## Edge-case handling and proof

Definitions and expected results live in the shared contract; do not fork them here.
- Missing fuel, missing one wheel, valid zero, nonfinite/out-of-range values, fractional fuel units, pit-snapshot-only wear → independent eligibility/null reasons and correct units. Verify E2/E5; B2.
- First/partial lap, invalid lap, pit entry/exit, refill, tire replacement, drive-through → preserve evidence, exclude crossing intervals, split only with labeled boundary evidence; no fresh-tire claim from drive-through. Verify E2/E5; B2/B5.
- Other identity/layout/PI/compound/unit/semantic version/ownership, disabled history policies, and known/unknown setup keys → enforce the shared metric-specific rules before selection; expose typed context, disclose unknowns, and keep conditions explanatory. Verify E4; B3/B7.
- Historical 1-lap and 10-lap stints → sum/count weighting; exact threshold takeover at two fuel/three tire laps. Verify E3/E6 plus deterministic tests; B3.
- Duplicate events, replay twice, crash, time rewind, delayed old-session seed, interrupted rebuild → stable keys, epoch guards, atomic replacement, interrupted active stint. Verify E5/E6/E8; B1/B5.
- Clear while writes are queued, including an empty ledger; paging across epochs/drivers; new epoch at zero milliseconds; restart/replay after clear → serialized admission boundary, durable epoch order, filter-bound cursor generations, no resurrection and no suppression of genuinely new observations. Verify E7; B4/B5/B8.
- Delete/correct/rebuild A while B is using its evidence; delay B's old baseline read → increment affected namespace revisions atomically, invalidate B's active tracker and both browsers, refresh without reconnect, preserve current samples/immutable estimates, and reject stale revisions. Verify E7/E8; B5/B9.
- Storage failure → telemetry remains operational with explicit persistence error, no false commit notification or uncommitted live rates, and idempotent recovery. Retain failed source admissions/contributions in FIFO order; terminal unsaved laps cannot block session rotation. Cancel deleted-source admissions without poisoning later sessions. Verify E8 and the focused storage-failure scenarios; B4/B5/B8.

## Verification execution plan

Reuse existing Bun live-strategy tests and extend with consumer-visible aggregation/transition regressions. Run existing focused tracker/pit-cycle tests plus new aggregation/storage tests using an isolated DATA_DIR and the repository's integration configuration as appropriate. Exercise actual runtime entry point with deterministic source packets; HTTP-only mocks or direct accumulator tests do not satisfy B6.

Use the focused `playwright/tests/seeded/strategy/` application suite. Native FM, F1 and ACC fixtures exercise the production parser and ingestion path; runner-owned subprocess helpers provide isolated storage, restart, and SQLite write-failure controls without adding production test endpoints. Run from `playwright/`:

```sh
bunx playwright test --config=stint-strategy.config.ts --project=seeded-e2e --workers=1
```

## Implementation and verification results

B1–B9 are implemented. Migration v82 preserves existing sessions/laps without fabricating old stint evidence. Live contributions, weighted compatible history, immutable estimates, durable source ordering, clear generations, staged rebuild activation, and post-commit notifications use the production ingestion and SQLite paths.

| Verification | Observed result | Evidence |
|---|---|---|
| Native E1–E9 and E7a/E8a–d | 13 unique scenarios have passing evidence. The full run passed 11/13; both failures were corrected and superseded by a 3/3 affected rerun, including ACC. The permanent SIGKILL/cold-history scenario then passed 1/1. Unaffected FM/F1 and multi-client results were reused. | [Full run](../../playwright/test-results/strategy-full-integration.log), [corrected rerun](../../playwright/test-results/strategy-followup-integration.log), [crash rerun](../../playwright/test-results/strategy-crash-integration.log) |
| Focused backend regressions | 87 tests, 299 assertions passed across seven files. After final Kunos error handling changed, its affected three-file subset passed again: 40 tests, 165 assertions. | [Full regressions](../../playwright/test-results/strategy-regressions.log), [affected Kunos subset](../../playwright/test-results/strategy-kunos-regressions.log) |
| Required root gate | `bun run typecheck`: 33/33 tasks successful on final production inputs. | [Typecheck output](../../playwright/test-results/strategy-final-typecheck.log) |
| Playwright fixture types and targeted lint | `bun check --project playwright/tsconfig.json`: 187 files without type errors; changed client/backend/fixture paths passed Oxlint. | Executed after their final relevant edits |
| Upgrade and rollback | v81→v82 retained the existing session and valid 60-second lap; no historical stints fabricated. Injected rebuild failure returned 500 while retaining prior summaries/history; recovery rebuilt exactly three laps. | [Upgrade](../../playwright/test-results/strategy-migration-upgrade.json), [rollback/recovery](../../playwright/test-results/strategy-rebuild-rollback.json) |
| Authentication | All four strategy operations returned 401 without a session after protection was enabled in an isolated runtime. | [Auth smoke](../../playwright/test-results/strategy-auth.json) |
| Raw-independent history | Removed the prior source's physical capture, restarted, and retained its fuel baseline and evidence through the production API. | [Raw-removal smoke](../../playwright/test-results/strategy-no-raw-baseline.json) |
| Abrupt crash | SIGKILL retained two committed laps and immutable history, excluded the partial tail, marked the active stint interrupted, and did not invent a session. | [Crash smoke](../../playwright/test-results/strategy-crash-recovery.json) |
| Release notes | Changelog validation passed 11 tests. | `bun test packages/tooling-release/test/changelog.test.ts --timeout 60000` |

The corrected integration rerun was:

```sh
cd playwright
bunx playwright test --config=stint-strategy.config.ts storage-failure.spec.ts fuel-units.spec.ts --grep 'deleting a source with failed admission|Kunos lap-write failure|E2 native ACC' --project=seeded-e2e --workers=1 --output=test-results/stint-strategy-followup
bunx playwright test --config=stint-strategy.config.ts stint-strategy.spec.ts --grep 'E1/E2' --project=seeded-e2e --workers=1 --output=test-results/stint-strategy-crash
```

The full focused regression command was:

```sh
bun test apps/backend/test/live-strategy/stint-strategy.test.ts apps/backend/test/live-strategy/pit-tracker.test.ts apps/backend/test/live-strategy/pit-cycle.test.ts apps/backend/test/session-capture/source-loader-stream.test.ts apps/backend/test/session-capture/kunos-sparse-recorder.test.ts apps/backend/test/lap-analysis/lap-detector-ac.test.ts apps/backend/test/telemetry/pipeline-live-issues.test.ts --timeout 60000
```

All fault injection and process termination used runner-owned disposable data/processes. No production test endpoints, dynamic imports, checkpoint files, or commits were added.
