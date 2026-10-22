# LMU telemetry — two-phase backend plan

[Shared contract and audited source inventory](lmu-competitor-data-contract.md) · [UI plan](lmu-competitor-data-ui-plan.md) · [Proposed ADR](../adr/0014-lmu-competitor-data.md)

## Delivery order and ownership

Implement [#478](https://github.com/SpeedHQ/RaceIQ/issues/478) in two independently verifiable phases: **Phase 1 closes player telemetry gaps; Phase 2 adds multiplayer opponents and the companion BIN.** No opponent extraction, grid UI or companion migration is a prerequisite for player delivery. All original issue requirements remain in scope across the two phases.

The backend integration owner owns shared schema/catalog, source inventory, live validators and generation rules; Phase 2 additionally owns companion format/index. Shared field definitions and source limitations live in the contract. Finalize each phase's shared catalog/wire decisions before its UI/backend implementers consume them; then implement UI/backend in parallel. Do not claim unresolved source availability or units as agreed facts. Coordinate preservation with #477 and retention policy with #471. No new simulator, manual player override, speculative measurements or LMU UDP fallback.

Baseline: `Snazzie/replay` at `7faddf9c4`; follow the implemented [replay package contract](../../advisor-plans/lap-replay-contract.md) and [server ownership](../../advisor-plans/lap-replay-backend-plan.md). Semantic replay/Insights routes and DTOs now belong to `packages/lap-replay/{server,contracts}`, not client hooks or app resource handlers. Capture/DB/storage maintenance remains backend-owned; the app retains route registration and authenticated host composition. Historical Phase 1 verification below is not fresh verification after this branch update.

Implementation authorized with controlled fixtures on 2026-10-22; the user explicitly schedules a fresh Windows LMU recording after implementation for final acceptance. This overrides historical Windows-before-coding prerequisites below, without claiming those scenarios passed. Preserve player regressions while implementing Phase 2.

## Phase 1 — Player telemetry gaps

### Scope and owned surfaces

`packages/game-lmu/src/{memory-reader,normalizer,source,recorder}.ts`, shared player telemetry/catalog/resolver/live types, LMU normal-live allowlist, independent runtime REST/lifecycle, existing capture/codec/replay/history/export/import paths. Verify package ownership before editing. Keep current full-memory v2 capture readable and preserve already-recorded opponent bytes without projecting or duplicating them. Player/REST preservation fixes may extend existing formats where necessary but must not require the Phase 2 companion design.

### Tasks

1. Verify the player source inventory against immutable references and actual LMU version/mode. Establish units, validity/sentinels and freshness; correct energy and sector-time catalog mistakes. Finalize player semantic IDs/types and optional LMU supplemental context using existing resolver contracts and precision-safe JSON encoding. Omit `competitors` in Phase 1.
2. First expose existing `batteryChargeFraction`, `stateOfCharge`, `virtualEnergy`, `regenKw` correctly through normal live output; preserve distinct meanings and valid zero. Then add supported separate engine/motor state, RPM, torque and temperatures, steering-shaft torque, detailed weather/wetness, player timing/gaps, and appropriate already-read control/pit-state exposure. Do not replace native semantics with combined power/torque, generic weather or placeholder zeros.
3. Resolve player penalties, flags and services from source-backed inventory: implement supported channels; document unavailable mappings with evidence for unsupported ones. Do not defer the audit to Phase 2.
4. Implement verified player/session REST endpoints independently of native polling: garage/setup/steering lock, forecasts/session settings, aero/brake/suspension condition, energy capacity/refill and pit/repair estimates. Apply contract provenance/applicability/version/time metadata and bounded cadence/timeout. Missing/malformed/failed/unchanged responses preserve accurate state/age and cannot stall native telemetry; verify physical units before publishing.
5. Handle player/session/vehicle rewind, garage return, slot changes, pause/freeze/resume, disconnect/restart and late REST completion. Reset incompatible fuel/energy deltas and reject old-generation responses. Missing player cannot imply slot zero or fabricated physics.
6. Fix player extension/REST retention through existing production capture, offline replay, historical lookup, selected-lap export and reimport. Preserve changing values, source times, provenance and states; legacy missing values stay unavailable. No competitor companion required for Phase 1 acceptance.
7. Update player catalog/projection/capability/recording docs and release notes; verify actual UI/backend integration and non-LMU behavior before starting Phase 2.

### Acceptance criteria

- **B-LMU-2 → LC3:** Existing player energy values/units appear in normal live output, remain distinct and preserve valid zero; missing/stale/invalid values explicit.
- **B-LMU-3 → LC4:** Verified player/session REST reaches actual production client/pipeline with typed provenance, applicability, units and age; failures/delays/malformed/missing/unchanged results cannot fabricate freshness or block native frames.
- **B-LMU-4 → LC9:** Player source inventory resolves engine/motor/FFB/weather/wetness/timing/control/pit/penalty/flag/service gaps. Supported fields reach normal output; unsupported fields have evidence and unavailable mappings; catalog units are corrected.
- **B-LMU-6-P1 → LC6:** Player lifecycle transitions reset incompatible context/deltas and reject stale-generation REST; no wrong-car attribution or guessed player.
- **B-LMU-7-P1 → LC7:** Player docs/release notes reflect verified scope; UDP/native coexistence and other games remain unchanged.
- **B-LMU-8 → LC8:** Changing player extensions and REST values/states/original observation times survive capture, replay, history, selected-lap export/reimport without a companion; old v2/CSV missing fields remain unavailable.

### Edges, handling and E2E gate

Use shared-contract scenarios through production boundaries, not mock-only tests.

| Edge / handling | Acceptance | Required scenario |
|---|---|---|
| Missing/zero/stale/invalid energy → preserve meaning and explicit states | B-LMU-2 | E2E-LMU-ENERGY |
| Separate motor/engine/FFB/native weather/timings vs unsupported channels → source-backed mapping, no physical-concept substitution | B-LMU-4 | E2E-LMU-PLAYER-CHANNELS |
| Slow/failed/malformed/missing/unchanged REST → bounded independent I/O, explicit state and unchanged source age | B-LMU-3 | E2E-LMU-REST |
| Rewind/garage/slot swap/no player/freeze/resume/disconnect/restart/late response → invalidate incompatible player state | B-LMU-6-P1 | E2E-LMU-PLAYER-LIFECYCLE |
| Unequal source updates and legacy v2/CSV omissions → retain observation times and compatible reads, never guesses | B-LMU-8 | E2E-LMU-PLAYER-RETENTION |
| Concurrent UDP/native and other-game output → attribution and behavior unchanged | B-LMU-7-P1 | E2E-LMU-UDP-COEXIST |
| Actual LMU player source/version/REST behavior → verify channel inventory and native-only failure behavior | All Phase 1 criteria | E2E-LMU-REAL-PLAYER |

Phase 1 completion requires these passing scenarios including real Windows player smoke, applicable package checks and root `bun run typecheck`. Record commands, fixtures, source/game versions and outcomes. A missing environment is a blocker, not permission to claim completion or silently bypass the phase gate.

### Implementation and controlled evidence — 2026-10-20

Phase 1 is integrated against the [shared implementation boundary](lmu-competitor-data-contract.md#phase-1-implementation-boundary). Native values use the audited ABI; independent bounded REST acquisition carries generation-scoped provenance. V3 player context is retained in the existing primary stream, including sparse records and JSON-safe history/dev transport. There is no opponent collection or companion format.

| Criteria / scenario | Executed evidence |
|---|---|
| B-LMU-2, B-LMU-4, B-LMU-6-P1; ENERGY / PLAYER-CHANNELS / PLAYER-LIFECYCLE | `bun test packages/game-lmu/test/phase1.test.ts packages/game-lmu/test/lmu-adapter.test.ts --timeout 60000`: 17 passed, 143 assertions. Covers distinct units, valid zero, invalid energy, ambiguous IDs, slot/vehicle changes, garage/pause/freeze/rewind and queued identity invalidation. |
| B-LMU-3; REST | Controlled real HTTP → native source → production WebSocket smoke passed unchanged, malformed, failed, delayed/expired and recovered responses without blocking native frames. Unchanged recovery remains stale rather than inventing a source update. |
| B-LMU-6-P1, B-LMU-8; PLAYER-LIFECYCLE / PLAYER-RETENTION | `bun test apps/backend/test/session-capture/direct-recording-ingress.test.ts --timeout 120000`: 6 passed, 21,721 assertions, including four real V3 LMU context generations with two held finalizations. Session admission backpressures outside the maintenance lock instead of exceeding the two-retirement budget. |
| B-LMU-8; PLAYER-RETENTION | `bun test apps/backend/test/lap-analysis/lap-export-import-roundtrip.test.ts --test-name-pattern 'LMU changing supplemental' --timeout 120000`: passed selected-lap export, real import and historical replay with changing observations and original nanosecond/update-sequence precision. |
| B-LMU-7-P1; UDP-COEXIST | Recording-enabled production HTTP/WebSocket smoke passed all ten scenarios with 218 valid frames, including a real Forza UDP datagram and subsequent native LMU continuation without cross-game context. Existing direct-capture FM, ACC and iRacing integration cases also passed. |
| Shared gates | Root `bun run typecheck`: 31 tasks passed. Root `bun run lint`: 33 tasks passed without warnings/errors. `bun run telemetry:catalog:check`: deterministic, 809 variables / 2,010 source links. `bun scripts/test/check-shards.ts`: all 400 test files assigned exactly once. Release-note suite: 14 passed. |

The controlled application harness used the actual `bootServer`, `LMUTelemetrySource`, loopback HTTP endpoints and UDP listener; temporary scaffolding was removed after validation. Fixture ABI version 1202 is synthetic, not an observed running game version. Local logs, scenario JSON and browser captures are retained under `.omp/evidence/lmu-phase1/` and `.omp/evidence/lmu-phase1-live-smoke.json` (not committed).

**Real-source acceptance remains pending:** `E2E-LMU-REAL-PLAYER` did not run locally. The user authorized Phase 2 coding first; verify actual Windows version/mode, native/REST behavior and a fresh recording after implementation before final acceptance. Unsupported capacity/refill/estimate semantics remain unavailable.

### Phase 1 review correction gate

Follow the [shared review-correction boundary](lmu-competitor-data-contract.md#phase-1-review-corrections): compact synthetic-v4 availability preserves native-v3 acquisition and legacy native reads. PLAYER-RETENTION / LC8 now covers actual DuckDB HTTP import → semantic history → selected-lap export/reimport, including omitted fields, recorded zero, and an event before its first observation. The native-v3 scenario covers variable context lengths, bounded decompressed export size, exact supplemental context/nanoseconds and original historical capture clocks.

Controlled correction evidence passed: 62 source/resolver regressions; focused scoring-alias regressions; native source → parser → pipeline → production WebSocket with frozen scoring and fresh physics; actual HTTP import/history/export/reimport for synthetic v4 and native v3; root typecheck (31 tasks), root lint (33 tasks) and changed-scope follow-up gates; deterministic catalog (809 variables / 2,010 links); 400-test registration; 11 changelog tests. The 1,423-frame native lap exported to 9,063,881 decompressed bytes rather than full-memory expansion. Local logs are under `.omp/evidence/lmu-review/`. Actual Windows LMU acceptance remains unrun.

## Phase 2 — Multiplayer opponents and companion BIN

### Scope and owned surfaces

Extend native decoding/coherence, opponent context, capture formats/indexes, companion lifecycle/recovery, replay/history/export/import/cleanup and UI integration while preserving Phase 1 behavior. Do not reclassify player enrichment as opponent data. Real-source acceptance follows implementation.

### Tasks

1. Verify multiplayer field availability by mode/version. Extract supported opponent scoring/class/position/best-last-current timings/pit/gaps and only runtime-proven opponent physics. Use `mID` with session generation and incarnation; handle duplicates, unknown/reused IDs, no-player/spectator states and joins/leaves without index fallback. Never use player physics or the restricted opponent fuel-ratio fallback.
2. Extend coherent snapshot checks to every newly consumed opponent region before assigning shared capture keys. Preserve native scoring/physics observation times and independent REST acquisition times; repeated/colliding timestamps do not become fabricated new measurements.
3. Define versioned primary/companion partition before writer work: existing full-memory v2 already includes opponents. Exclude competitor payloads from new primary BIN, retain them in one companion per session, conserve required extensions exactly once and retain old v2 read compatibility. A companion-only addition that duplicates existing bytes fails acceptance.
4. Integrate typed grid context and incarnation-aware snapshots with normal live output/UI. Add manifest schema/integrity/ranges/publication state, committed-prefix recovery and explicit incomplete/unavailable states.
5. Implement two-stream production replay/history, selected-lap export/import with ranges/bootstrap, and reference-safe cleanup. Missing/corrupt companion leaves readable player data; partial lap deletion cannot remove shared companion content still referenced elsewhere.
6. Update multiplayer/recording docs and release notes, run actual UI/backend multiplayer integration, rerun Phase 1 checks invalidated by changes and verify no player regression.

### Acceptance criteria

- **B-LMU-1 → LC1/LC2:** Reorder/join/leave/reuse/duplicate/unknown/no-player/slot transitions retain correct opponent attribution and supported scoring. Torn opponent snapshots rejected; restricted physics unavailable.
- **B-LMU-2-P2 → LC2/LC3:** Restricted opponent energy/fuel placeholders do not become measured values or borrow player readings; Phase 1 energy remains correct.
- **B-LMU-5 → LC5/LC8:** Versioned partition removes competitor duplication from primary while conserving supported source bytes/states and original observation times; exact capture association, replay/history/export/import, crash recovery, ranges/bootstrap and cleanup pass E2E. Legacy reads remain correct.
- **B-LMU-6-P2 → LC1/LC6:** Opponent ID reuse/incarnations and companion recovery cannot contaminate player context or other cars.
- **B-LMU-7-P2 → LC7:** Multiplayer docs match verified mode limits; player/non-LMU/UDP behavior remains correct.

### Edges, handling and E2E gate

| Edge / handling | Acceptance | Required scenario |
|---|---|---|
| Reorder/duplicate/reused IDs/no player → incarnation-aware joins and explicit ambiguity | B-LMU-1 | E2E-LMU-IDENTITY |
| Restricted opponent fuel-or-battery/physics → unavailable or source-limited, never fabricated | B-LMU-2-P2 | E2E-LMU-OPPONENT-ENERGY |
| ID reuse/joins/leaves and recovery → invalidate incompatible opponent state, retain player safety | B-LMU-6-P2 | E2E-LMU-LIFECYCLE |
| Sparse/unequal updates/repeated times/old recordings → coherent capture key and conserved source observations | B-LMU-5 | E2E-LMU-RETENTION |
| Torn opponent reads → reject snapshot before publication | B-LMU-1, B-LMU-5 | E2E-LMU-COHERENCE |
| Interrupted publication/corrupt companion/lap export-import/partial deletion → committed references, explicit unavailability and safe ownership | B-LMU-5, B-LMU-6-P2 | E2E-LMU-COMPANION-FAILURE |
| Actual multiplayer source/version behavior → verified channel availability, identity and companion parity | All Phase 2 criteria | E2E-LMU-REAL-OPPONENTS |

Phase 2 completion requires its scenarios, applicable package/root gates, actual opponent UI/backend integration and Phase 1 regression checks invalidated by changed inputs. Reuse unchanged successful evidence only while its scope remains valid. Implementation and controlled verification are recorded below; fresh Windows player/opponent source acceptance remains unrun.

### Phase 2 amendment — removable opponent storage

Authoritative [removal contract](lmu-competitor-data-contract.md#optional-opponent-retention-and-explicit-removal), LC10/LC11 and shared E2E table. Implementation is authorized with controlled fixtures after shared schema finalization; fresh Windows recording validation remains final acceptance, not a prerequisite to coding.

**Owned scope:** `packages/capture-formats` partition/manifest schemas and codecs; LMU source/recorder/player bootstrap; `server/session-capture/{direct-recorder,source-loader,cleanup,session-cleanup,maintenance-runtime,relocate-recordings,session-downsample}.ts` and affected capture/import/export/rebuild consumers; DB source/index publication and history validators; shared request/status types; `apps/backend/src/routes/system/storage-routes.ts`. Preserve existing package boundaries and maintenance runtime. UI owns no filesystem decisions.

1. Finalize region ownership, independent primary decoding and retained/removed metadata against the shared contract. Audit checkpoint/bootstrap/derived storage so no opponent payload survives in primary for new recordings. Review player-slot/no-player transitions and source conservation before writer work.
2. Add session-scoped preview/admission/status to existing storage routes and managed lifecycle. Preview measures unique owned companion files and identifies legacy rewrites; it is read-only. Validate/authenticate every selected ID; serialize and revalidate revisions/references under maintenance admission.
3. Implement durable removed publication, read-lease-safe unlink and restart cleanup. Keep primary bytes and player-only derived analysis unchanged for partitioned data. Invalidate opponent/revision-bound caches, never player semantics. Treat post-commit unlink failures as pending cleanup, not successful reclamation or a rollback.
4. Add streaming legacy v2/v3 rewrite using the same canonical partition codec, parser checkpoints and staged publication conventions; verify player/session parity before switching source/index references. No in-place edits, invented observations, or hidden embedded backups. Unsupported/invalid inputs skip; insufficient space and pre-commit errors preserve originals.
5. Propagate retention metadata and absence semantics through actual history/replay, selected-lap export/import, relocation, downsampling/rebuild and reference-aware cleanup. Prevent rebuild/import from resurrecting removed context. Extend ownership enumeration for companion and pending cleanup files; keep unrelated session references protected.
6. Execute the shared STRIP scenarios through real boot/HTTP, native ingress and archive APIs with isolated storage. Extend existing `apps/backend/test/session-capture/{direct-recording-ingress,source-loader-stream,session-downsample-publication}.test.ts`, `apps/backend/test/routes/storage-routes.test.ts` and `apps/backend/test/lap-analysis/lap-export-import-roundtrip.test.ts` where suitable; add only the minimal production-boot fault-barrier coverage missing from these harnesses. Record outcomes and actual file accounting, then run affected package gates and root `bun run typecheck`. Update recording/capability guidance and release notes only when shipped.

| Acceptance | Required passing E2E evidence |
|---|---|
| **B-LMU-10 → LC10**: new primary checksum/player replay unchanged; legacy player parity; opponent-owned storage physically absent with accurate net reclaimed bytes | STRIP, STRIP-LEGACY |
| **B-LMU-11 → LC10/LC6**: no pre-commit data loss, post-commit resurrection, outside-reference deletion or double accounting; explicit cleanup-pending retries | STRIP-RECOVERY, STRIP-REFERENCES |
| **B-LMU-12 → LC10/LC11/LC5**: real history/export/import expose durable removed state and never fabricate or restore opponent payload | STRIP-ROUNDTRIP, STRIP-UI |

Use full `E2E-LMU-` prefixes from the contract. Each named scenario defines setup, action, expected edge/failure behavior and shared criteria; do not duplicate or weaken them here. UI/backend implement independently after boundary agreement; backend integration owns final joint scenario execution, with UI browser assertions a completion dependency. All three criteria require passing recorded evidence, including relevant Phase 1/Phase 2 regressions and real Windows opponent acceptance; planned, skipped or blocked checks do not pass.

### Phase 2 amendment — opponent lap catalog and comparison

Authoritative [comparison boundary](lmu-competitor-data-contract.md#opponent-lap-selection-and-comparison) defines LC12/LC13, types, identity, capability, errors and E2E behavior. Backend integration publishes shared schemas before independent consumers. Implement now with controlled fixtures; verify actual multiplayer using a new recording afterward.

**Owned scope:** LMU scoring/incarnation capture and companion index; backend source/replay/rebuild/export/import/cleanup consumers; shared comparison schemas and feature `packages/lap-replay/{contracts,server}` catalog/opponent semantic route integration; existing app comparison calculations and `apps/backend/src/routes/laps/{transfer-routes,support}.ts` export extension. Existing semantic replay routes remain feature-owned, not moved back into `resource-routes.ts`. Keep opponent laps distinct from numeric player lap identity; no required-array zero filling.

1. First implement the [contract feasibility assessment](lmu-competitor-data-contract.md#feasibility-assessment--schema-evidence-not-multiplayer-acceptance) as a source inventory verified against the installed header and actual multiplayer build/mode. Audit scoring velocity/orientation offsets missing from the current layout and observation cadence; baseline timing and potential scoring kinematics do not establish remote inputs. Then index real opponent intervals by generation/vehicle/incarnation/capture keys; preserve independent lap boundaries, partial coverage/unknown validity and original clocks. Last/best scalar reports alone never fabricate recorded laps.
2. Implement catalog and opponent semantic interval routes in the replay feature and compose through existing typed lap routing; implement comparison calculation at its existing backend/analysis owner. Enforce game/session/layout access, revision fences and contract error codes. Catalog exposes paired capability/reasons and distinct retention states. Never substitute another driver/lap; preserve existing player semantic replay API/loader behavior and errors.
3. Reuse valid alignment math, not all-required `AlignedLapTrace` arrays. Add capability-aware results and typed opponent semantic replay source to public feature contracts/host integration; preserve original native semantic envelopes/clocks for shared playback preparation. Derive speed explicitly from verified scoring velocity when available, not position differentiation or borrowed telemetry. Cumulative sectors/estimated clocks/repeated observations and gaps follow the feasibility/semantic contract. Continuous delta, line and shared 3D replay remain coverage-gated; full remote driver inputs remain unpromised.
4. Extend companion export range selection to include an explicitly chosen opponent lap's full interval/bootstrap even across player-lap boundaries, and rebuild imported catalog ownership. Strip/index/cache cleanup, missing/corrupt handling, downsampling and source rewrite must invalidate stale references without damaging player data or silently resurrecting opponents. Comparison reads use the existing pinned-revision/maintenance lease rules.
5. Extend existing native ingress and backend comparison/export-import suites; put opponent semantic route integration beside `packages/lap-replay/test/integration/replay-routes.test.ts`. Run shared COMPARE scenarios with client selector tests plus feature-owned Replay/Spectate E2Es, including recorded-pose/coarse-source/gap coverage and current replay C1–C5 regressions. Run relevant package gates and root `bun run typecheck`, record source/header/game versions and actual outcomes. Update capability docs/release notes only when implemented.

| Acceptance | Required passing shared E2E scenarios |
|---|---|
| **B-LMU-13 → LC12/LC1/LC6**: stable real-lap interval identity, honest completion/validity and no attribution across reuse/generation/late response | COMPARE-SELECT, COMPARE-IDENTITY |
| **B-LMU-14 → LC12/LC2**: exact source-backed timing semantics and available trace subsets; restricted/missing/gapped fields never fabricated | COMPARE-COVERAGE |
| **B-LMU-15 → LC12/LC13/LC5/LC10**: full selected interval round-trips; typed semantic playback feeds existing shared workspace; revision/removal invalidation preserves player usability | COMPARE-RETENTION, COMPARE-UI, COMPARE-REPLAY |

Use full `E2E-LMU-` names from the contract; its table specifies each edge solution and production setup/action/assertion. Backend integration owns final joint execution/evidence, with UI picker/browser assertions and real Windows multiplayer availability validation required before acceptance. Existing player comparison, Phase 1 and affected Phase 2 scenarios remain regression gates. Unavailable environments and unrun scenarios are blockers, not passing evidence.

### Phase 2 amendment — default-enabled opponent recording preference

Authoritative [recording preference](lmu-competitor-data-contract.md#recording-preference--enabled-by-default), LC14 and `E2E-LMU-RECORDING-POLICY`. Backend owns `server/runtime/config/settings.ts`, related settings schema/route types and persistence, session admission, partition writer/index and export/import metadata; UI owns the existing Settings control.

1. Add non-null boolean `recordLmuOpponents`, default true for new settings and files missing the key; extend existing GET/partial PUT without resetting unrelated fields. Reuse existing validation/error/persistence semantics. Do not mutate policy before a successful save.
2. Snapshot saved policy at new LMU capture session admission and carry it through lap parts/retirement. False bypasses every opponent disk sink, including raw full-memory encoding/checkpoints, companion, index and derived disk caches; true retains the normal companion. Keep live acquisition and player/session/REST data independent. A mid-session save changes only the next session.
3. Persist not-recorded metadata when false; preserve imported/older retained sessions unchanged. Export/import/rebuild cannot invent omitted observations; re-enabling affects only new sessions. Validate byte ownership so disabling opponents cannot remove player identity/bootstrap or leak raw opponent arrays through the primary.
4. Execute the shared recording-policy E2E through actual Settings HTTP/UI, native ingress and filesystem/history/export/import. Extend existing settings persistence/native recorder suites for default migration, invalid/failed saves, active-session toggles and no opponent storage.

**B-LMU-16 → LC14/LC5/LC7:** default true/backward-compatible settings, effective session policy transitions, zero opponent disk artifacts when opted out, honest history metadata, live/player continuity and unaffected existing imports/other games all require passing recorded production E2E evidence. Preserve Phase 1 and affected Phase 2 gates; use the existing maintenance/runtime lifecycle, not a second settings/recording pipeline.

## Phase 2 implementation and controlled verification — 2026-10-22

Implemented native incarnation-aware scoring (including distinct time/lap gaps
and caveated pit reports), v5 player-only primary/v1 companion retention,
default-enabled session-snapshotted recording policy, staged legacy removal,
cleanup recovery, typed opponent catalog/comparison/replay routes, and full
selected-opponent export/import. Semantic HTTP responses use the lossless
resolved-value codec; bigint observation counters never enter raw JSON.
The native ingress waits for a preopened standby before ownership rotation;
companion failures remain isolated from player persistence.
Opponent HTTP reads also revalidate failed reads against the authoritative
database source path and published revision. A confirmed concurrent source
change returns `SOURCE_CHANGED` (409); unchanged-source I/O failures are not
suppressed. Revision checks also cover unavailable-source snapshot returns.

| Scope and criteria | Executed controlled evidence |
|---|---|
| B-LMU-1/2-P2/5/6-P2/7-P2/16; affected Phase 1 | 117 tests across 12 native/partition/recorder/source-loader/settings/replay suites passed, 24,136 assertions. Includes identity reuse/no-player/coherence, scoring clocks, separate energy, REST failures, player conservation, next-session policy, companion failure/publication ordering, legacy rewrite and cleanup recovery/reference protection. |
| B-LMU-5/8/12/15; RETENTION / STRIP-ROUNDTRIP / COMPARE-RETENTION | `bun test apps/backend/test/lap-analysis/lap-export-import-roundtrip.test.ts --test-name-pattern 'retained LMU|LMU changing' --timeout 120000`: 2 passed, 53 assertions. Ordinary and selected-opponent ZIP imports retain full opponent intervals; changing player supplemental state and original nanoseconds survive. Explicit removed/not-recorded player-only archives import without companions; retained missing-pairing and contradictory player-only/companion archives are rejected. |
| B-LMU-13/14/15; COMPARE boundary | Real native fixture import through HTTP, typed catalog/comparison and semantic playback, selected interval ZIP export/import, stale-reference handling and post-removal player replay are exercised by the linked UI browser evidence. |
| B-LMU-13/14/15; LC10/13 source transitions | After the baseline suite, `bun test packages/lap-replay/test/integration/opponent-routes.test.ts --timeout 120000` passed 11 tests / 64 assertions with concurrent real removal. An in-flight read either completes its valid snapshot or returns 409, never 500; the stale revision returns `SOURCE_CHANGED`, and player semantic replay remains HTTP 200. |
| Shared gates | Root `bun run typecheck` and `bun run lint`: 37 tasks passed each. `bun run telemetry:catalog:check`: 850 variables / 2,053 source links, deterministic. Replay UI/server/contracts boundary check passed. |

Full logs: `.omp/evidence/lmu-finish/{native-integration,archive-roundtrip,quality-gates}.log`.
Fixtures derive controlled scoring geometry from the repository LMU recording;
they are not fresh multiplayer recordings or evidence of remote input availability.
The linked UI plan owns browser outcomes. Final acceptance still requires
`E2E-LMU-REAL-PLAYER` and `E2E-LMU-REAL-OPPONENTS` on Windows, including actual
game/version/mode, remote field population/cadence and recorded racing-line parity.
No unexecuted portion of a contract scenario is marked passed by the counts above.

