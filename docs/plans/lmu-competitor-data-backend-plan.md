# LMU telemetry — two-phase backend plan

[Shared contract and audited source inventory](lmu-competitor-data-contract.md) · [UI plan](lmu-competitor-data-ui-plan.md) · [Proposed ADR](../adr/0014-lmu-competitor-data.md)

## Delivery order and ownership

Implement [#478](https://github.com/SpeedHQ/RaceIQ/issues/478) in two independently verifiable phases: **Phase 1 closes player telemetry gaps; Phase 2 adds multiplayer opponents and the companion BIN.** No opponent extraction, grid UI or companion migration is a prerequisite for player delivery. All original issue requirements remain in scope across the two phases.

The backend integration owner owns shared schema/catalog, source inventory, live validators and generation rules; Phase 2 additionally owns companion format/index. Shared field definitions and source limitations live in the contract. Finalize each phase's shared catalog/wire decisions before its UI/backend implementers consume them; then implement UI/backend in parallel. Do not claim unresolved source availability or units as agreed facts. Coordinate preservation with #477 and retention policy with #471. No new simulator, manual player override, speculative measurements or LMU UDP fallback.

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

**Acceptance remains blocked:** `E2E-LMU-REAL-PLAYER` could not run on this macOS workstation. Verify the actual Windows LMU version/mode, native source availability and REST behavior before declaring Phase 1 accepted or starting Phase 2. Unsupported absolute capacity, localized refill selection and pit/repair estimates remain unavailable, not measured values.


## Phase 2 — Multiplayer opponents and companion BIN

### Scope and owned surfaces

After Phase 1 acceptance, extend multi-vehicle native decoding/normalization and coherence checks, competitor catalog/live context, capture-formats and session indexes, companion lifecycle/recovery, replay/history/export/import/cleanup and opponent UI integration. Preserve Phase 1's player behavior. Do not reclassify Phase 1 player enrichment as opponent data.

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

Phase 2 completion requires its scenarios, applicable package/root gates, actual opponent UI/backend integration and Phase 1 regression checks invalidated by changed inputs. Reuse unchanged successful evidence only while its scope remains valid. Phase 2 remains unimplemented and unverified; Phase 1 implementation and its remaining real-Windows acceptance blocker are recorded above.
