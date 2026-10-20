# LMU competitor and supplementary telemetry contract

[Backend plan](lmu-competitor-data-backend-plan.md) · [UI plan](lmu-competitor-data-ui-plan.md) · [Proposed ADR](../adr/0014-lmu-competitor-data.md)

## Status and evidence

Shared boundary for [issue #478](https://github.com/SpeedHQ/RaceIQ/issues/478), audited against TinyPedal on 2026-10-20. Phase 1 is implemented with controlled native/HTTP, recording, import/export and browser evidence recorded in the linked plans. This is not proof of behavior in a running Windows LMU session; `E2E-LMU-REAL-PLAYER` remains an acceptance blocker. Phase 2 is not implemented. Native one-to-one [semantic rules](../reference/semantics.md) and existing [`ResolvedValue<T>` / timestamps / provenance](../../shared/telemetry/resolver/contracts.ts) remain authoritative. Do not copy TinyPedal implementation.

Immutable references:

- Issue pin: [`2360154…`](https://github.com/TinyPedal/TinyPedal/tree/2360154df19cd0dcd34b6fd39c7453cfb7ac8530).
- Audited current TinyPedal HEAD: [`fe0eafdc…` shared-memory adapter](https://github.com/TinyPedal/TinyPedal/blob/fe0eafdc02dfbd30ca562e6d9a0ca0e71016f340/tinypedal/adapter/lmu_sharedmemory.py), [reader](https://github.com/TinyPedal/TinyPedal/blob/fe0eafdc02dfbd30ca562e6d9a0ca0e71016f340/tinypedal/adapter/lmu_reader.py), [connector](https://github.com/TinyPedal/TinyPedal/blob/fe0eafdc02dfbd30ca562e6d9a0ca0e71016f340/tinypedal/adapter/lmu_connector.py).
- [LMU structures `6a8dd831…`](https://github.com/TinyPedal/pyLMUSharedMemory/blob/6a8dd8311d76291d602e020f059b8baae3d518a5/lmu_data.py): schema/comment evidence, not a guarantee every multiplayer field is populated.
- [REST adapter `c21a8639…`](https://github.com/TinyPedal/TinyPedal/blob/c21a863912ca67fb426d72c84368c63763e0307c/tinypedal/adapter/lmu_restapi.py), [REST task lifecycle](https://github.com/TinyPedal/TinyPedal/blob/c21a863912ca67fb426d72c84368c63763e0307c/tinypedal/adapter/_restapi.py), [weather interpretation](https://github.com/TinyPedal/TinyPedal/blob/c21a863912ca67fb426d72c84368c63763e0307c/tinypedal/process/weather.py). Endpoint declarations/gates are unchanged from the issue pin in this audit; latest REST-file change corrects default forecast data. Defaults are not observations.
- [Opponent fuel correction `514b20be…`](https://github.com/TinyPedal/TinyPedal/commit/514b20be5eb011819e79327eea077e58a975ded5.patch): removes `mFuel / mFuelCapacity` fallback because it reports a constant 0.5 in multiplayer; use scoring fraction with its fuel-or-battery limitation, not fabricated fuel. Audited pinned/current `fuel_fraction()` both use scoring byte / 255.

## Delivery phases

### Phase 1 — Player telemetry gaps

Deliver player data end to end before opponent work: expose existing energy with corrected units/semantics; project supported separate engine/motor channels, steering-shaft torque, detailed weather/wetness, player timing/gaps and already-read controls/pit state; integrate verified player/session REST; fix player extension/history/export retention and lifecycle invalidation. Resolve source-supported penalties/flags/services and document unsupported channels with evidence. Existing player data remains usable when REST is absent or a source is unavailable.

Use the existing canonical capture path for Phase 1; preserve existing raw opponent bytes already present in v2 without adding competitor collections or duplicating them. Phase 1 does not require a companion BIN, multi-car normalization, opponent UI, or partition migration. It must preserve new player/REST observations with source timestamps/states through supported recording/replay/history/export/import. Any required player preservation format change must stand alone without a dependency on Phase 2.

#### Phase 1 implementation boundary

The implemented native inventory is generated from
[`LMUExtendedData`](../../shared/telemetry/lmu.ts),
the [audited ABI offsets](../../packages/capture-formats/src/lmu/layout.ts)
and [catalog metadata](../../packages/tooling-catalog/src/catalog/extension-metadata.ts).
The REST inventory, exact types/units and per-semantic stale thresholds are
authoritative in [`LMU_REST_CHANNELS`](../../shared/telemetry/lmu-rest-channels.ts);
the shared [context codec](../../shared/telemetry/lmu-context.ts) validates
applicability, state/value consistency, semantic IDs and precision-safe JSON.
`status: "active" | "unavailable"` explicitly invalidates lost player context.
Capture sequence is a decimal string in process and on the wire; monotonic
timestamp nanoseconds and source update sequences use `bigint` in process and
validated decimal strings on the wire. Native frame time and REST acquisition
time remain separate clock domains.

The immutable native schema documents battery charge as a fraction, state of
charge as **percent**, virtual energy as a **fraction**, and regeneration in
**kW**. Engine temperatures are Celsius; the audited reader separately labels
motor temperatures Celsius. Engine torque is not the sum of engine and motor
torques. Best/last/current sector-2 reports retain their native cumulative
sectors 1–2 meaning and seconds. Motor state 0 means unavailable; no motor
physics are projected for that state.

Player race control includes outstanding penalty count, completed/scheduled pit
stops, ignition/starter, overheating, primary flag, full-course yellow state,
local sector flags, finish/control/count-lap indicators and pit/garage state.
The schema exposes a penalty **count**, not penalty type, service or duration;
its steward-results member is a filesystem path, not an observed penalty
record. Unsupported detailed penalty/service channels remain unavailable.
Primary flag is limited to the source's green/blue codes, and local sector
ordering remains unverified; neither is promoted to a generic flag model.

Read-only REST requests use the official LMU HTTP port
[`6397`](https://lemansultimate.com/how-to-setup-broadcast-overlay/) on loopback,
with configurable `LMU_REST_BASE_URL`, 500 ms default timeout, a 1 MiB response
limit, 1 s vehicle-condition/estimate cadence and 60 s setup/session/forecast
cadence. Unchanged successes update acquisition time only; failures retain
original successful acquisition and observation ages with explicit error state.
Capacity, localized refill selection and pit/repair estimate units are still
unverified and are deliberately unavailable. Raw condition scaling is not
claimed as a damage/wear percentage.

Source-frame v3 retains the entire v2 native-memory block plus the typed context.
Its sparse records delta-encode native blocks and retain changing observations,
states and original timestamp precision in the primary stream. Legacy v1/v2
remain readable; absent legacy observations cannot be reconstructed. No
competitor collection, companion BIN, partition migration or opponent UI is
implemented. Controlled pipeline and selected-lap round-trip evidence does not
replace `E2E-LMU-REAL-PLAYER`; the Windows LMU acceptance gate remains unverified
until run against an actual game/version/mode.


### Phase 2 — Multiplayer opponents and companion BIN

After Phase 1 passes its own integration gates, add opponent identity/scoring and verified multiplayer channels, grid projection/UI, incarnation-aware joins, all-consumed-region coherence checks, and the versioned primary/companion source partition. Include companion lifecycle, export/import and reference-safe cleanup. Runtime multiplayer coverage and reduced primary-file duplication are Phase 2 claims only.

Backend and UI work can run in parallel within each phase after that phase's shared catalog/wire definitions are finalized by the integration owner. No Phase 2 prerequisite may delay an independently verifiable Phase 1 player delivery. Preserve acceptance IDs below; each phase is complete only against its assigned criteria and E2E evidence.

## Native acquisition, identity and scope

LMU shared memory supplies native scoring and supported vehicle telemetry; UDP is not needed to acquire LMU competitors or existing energy. Preserve concurrent ordinary UDP/native acquisition without cross-game attribution. REST enrichment is independent asynchronous I/O, never a native-reader dependency.

Join scoring and telemetry independently by native `mID`, not scoring/telemetry array position. An `mID` can be reused after a multiplayer departure: persistent identity is `(session generation, vehicleId, incarnation)`. Increment incarnation on departure/rejoin or incompatible identity replacement. Duplicate/ambiguous IDs yield explicit invalid/unavailable data, never index fallback. Use scoring `mIsPlayer` for designation; no first-slot assumption. With no player marker, `playerVehicleId` is null and supported scoring remains usable without inventing player physics. A manual player override is not added by this feature; if existing selection changes, invalidate the old player context.

| Source-supported schema coverage | Contract handling |
|---|---|
| `mID`, driver/vehicle/class, `mIsPlayer`, place, laps, sector, lap distance and world position | Preserve native identity and meaning; class position requires an explicit class grouping/ordering derivation if absent natively |
| Best/last/current sector timing, best/last lap timing, lap start, time into lap, estimated lap | Keep distinct fields, native time units and observation time; do not collapse all timings into one lap-time value |
| Pit designation/state, finish/control/scoring indicators, native timing/gap fields | Preserve source limitations: `mInPits` is documented as not always accurate for remote vehicles; `mServerScored` is mode-dependent. Distinguish source reports from inferred pit events |
| Scoring `mFuelFraction` | Byte / 255 gives a fraction, but schema says fuel OR battery. Do not label it measured fuel liters or battery charge without verified applicability |
| Per-vehicle telemetry structure (engine, wheel, fuel, hybrid fields) | Schema presence is not multiplayer availability. No opponent physics/energy capability until verified for that field and mode; never borrow player values or accept known placeholders as measurements |
| Player `batteryChargeFraction`, `stateOfCharge`, `virtualEnergy`, `regenKw` | Expose independently with source-backed units; virtual energy fraction is not battery charge, fuel volume, or REST capacity |

Keep the issue's full source audit for penalties, pit services, flags, detailed weather, FFB, motor state/RPM/torque/temperatures. Existing `inPits`, `pitState`, `trackLimitsSteps`, `trackGripLevel`, and `cloudCoverage` are not new acquisitions. Generic weather classification does not replace native weather. Unsupported channels need explicit evidence/unavailable mappings.

## Typed data and live boundary

Reuse `ResolvedValue<T>`, `ResolutionState`, `FreshnessState`, `TelemetryTimestamp` and `ResolutionProvenance`; do not create a competing `Available<T>` schema that merges resolution and freshness. All unavailable values use null with explicit state; valid zero remains zero. Schema/catalog definitions retain units, mapping status and limitations.

Proposed wire addition is an optional typed `lmu` context on existing `LiveTelemetryFrameMessageV1` (normal production channel, not dev telemetry). Keep existing v1 scalar fields unchanged; update shared validators and client consumers together. Absence means no LMU context, not an empty valid grid. The wire uses these shapes with imported `ResolvedValue<T>` and `TelemetryTimestamp`:

```ts
interface LmuFrameKey {
  sessionKey: string; // includes process/session generation
  captureSequence: string; // decimal unsigned integer; shared with companion in Phase 2
  frameTime: TelemetryTimestamp; // preserve native precision in BIN encoding
}
interface LmuContext {
  schemaVersion: 1;
  key: LmuFrameKey;
  playerVehicleId: number | null;
  competitors?: readonly LmuCompetitor[]; // absent in Phase 1; complete known grid in Phase 2
  supplemental: readonly LmuSupplementalObservation[];
}
interface LmuCompetitor {
  vehicleId: number;
  incarnation: number;
  isPlayer: boolean;
  channels: Readonly<Record<string, ResolvedValue<unknown>>>;
}
interface LmuSupplementalObservation {
  semanticId: string;
  endpoint: string;
  method: "GET";
  sessionKey: string;
  vehicleId: number | null;
  applicability: "player-vehicle" | "session";
  acquiredAt: TelemetryTimestamp;
  responseVersion: string | null; // null if endpoint supplies none
  observation: ResolvedValue<unknown>;
}
```

These are shared in-process shapes; JSON transport must encode `bigint` timestamp nanoseconds and `sourceObservation.updateSequence` as decimal strings and validate/decode them explicitly, not send raw JavaScript `bigint` or silently round to milliseconds. Unknown native timestamp precision is an implementation gate; verify the coherent key against current capture contracts before assigning an encoding.

Channel keys MUST come from the LMU semantic catalog, not arbitrary JSON keys. Catalog defines exact scalar/array/object type and canonical unit for each key. Validator rejects non-finite values, malformed IDs/sequence, unknown schema/semantic IDs, and type/state mismatches. Snapshot omission removes a departed vehicle; stale membership remains explicitly marked rather than reported as a fresh grid. Gap channel definitions specify target vehicle/class/leader, time vs lap/distance units and derivation inputs/version; missing inputs mean unavailable. Preserve best/last/current sector and lap distinctions in separate semantic IDs.

REST acquisition time is not source measurement time. `observation.provenance.observedAt`, source observation, state and freshness retain that distinction; an estimate or cached garage snapshot never becomes fresh physics. Full supplemental validation and source-specific applicability rules are required before exposing each semantic. No new public HTTP endpoint is required. Historical/replay responses carry the same typed LMU context where applicable; update any existing response validators with their consumers.

## Supplementary REST inventory

These are TinyPedal-observed contracts, not independently confirmed LMU API guarantees. All use configured local HTTP host/port and GET; verify response types, units, version and application state in Windows LMU before enabling a semantic. Do not add write/control operations.

| Endpoint | Source fields and meaning | Reference cadence/gate |
|---|---|---|
| `/rest/sessions/weather` | `PRACTICE`, `QUALIFY`, `RACE`; START/NODE_25/NODE_50/NODE_75/FINISH: `WNV_SKY.currentValue` code, `WNV_TEMPERATURE.currentValue` °C, `WNV_RAIN_CHANCE.currentValue` percent → fraction. Preserve native node labels; TinyPedal projects nodes to 0,.2,.4,.6,.8, which must not be mistaken for native timestamps | One-shot when weather information enabled; forecast, not observed rain |
| `/rest/sessions` | `SESSSET_race_timescale.currentValue`, `SESSSET_private_qual.currentValue` | One-shot session information |
| `/rest/garage/getPlayerGarageData` | `VM_STEER_LOCK.stringValue` parsed angle; response setup content exported by TinyPedal. Full setup schema/unit interpretation still requires verification | One-shot garage/setup; invalidate on changed setup/applicability |
| `/rest/garage/UIScreen/RepairAndRefuel` | `wearables.body.aero`, `wearables.brakes`, `wearables.suspension`; `pitMenu.pitMenu`; `fuelInfo.maxVirtualEnergy`. Separate wear/damage, selected refill settings and capacity; do not treat as current opponent physics | Repeated player vehicle data, at least 200ms in reference |
| `/rest/strategy/pitstop-estimate` | `total` pit-stop estimate; `damage` repair estimate; verify time unit before semantic publication | Repeated player vehicle data, at least 1s in reference |

Reference refill parsing interprets virtual-energy setting as percent and fuel display as liters or gallons (3.7854118 liters per US gallon). Preserve source unit and explicit conversion; verify localization and payload before accepting displayed strings. Do not conflate capacity, current remaining fraction, requested refill, or predicted stop time. Until native/schema or downstream conversion evidence confirms a numeric field's physical unit, keep it unpublished/unavailable, not guessed.

TinyPedal's `virtual_energy_capacity()` labels raw REST `maxVirtualEnergy` as joules, but the REST adapter performs no unit conversion. This is reference interpretation, not independently verified unit evidence; verify it against LMU before publishing an absolute energy semantic.

Reference REST tasks run concurrently when realtime is active, cancel/reset when inactive, and use bounded timeout/retry/backoff. It can retain bare old values on repeated HTTP failure and suppress unchanged-response updates by byte hash; RaceIQ MUST NOT copy those semantics as fresh telemetry. In RaceIQ: initial failure → error/unavailable; later failure → error plus retained last observation age (never refresh successful acquisition time); malformed/missing field → invalid/missing; unchanged successful response may refresh acquisition time but not fabricate a source update. Configure per-semantic stale thresholds and bounded timeouts/cadences in the source inventory before implementation. Realtime/session/vehicle changes invalidate incompatible state; late responses are discarded by generation. REST never stalls native frames.

## Phase 2 storage boundary — companion BIN, timing and lifecycle

Companion partition/index/recovery and opponent-region coherence requirements in this section belong to Phase 2 only. Player source-time preservation and lifecycle invalidation apply in Phase 1 through LC6/LC8; Phase 1 does not need two-stream alignment or opponent recording support.

One competitor companion BIN per session, not per vehicle. Stable frame time aligns player and competitor records; also assign one capture sequence at coherent snapshot acquisition and carry the identical key into both outputs. Keep native scoring `mCurrentET`, telemetry `mElapsedTime`/`mDeltaTime`, source observation time and capture time separately. TinyPedal's synchronization on scoring elapsed time does not establish all physics/REST measurements were made simultaneously. REST and slower scoring updates retain their own observation time/freshness even when associated with a capture key. No nearest-time interpolation or relabeling of repeated data as newly measured.

Current [`encodeLMUSourceFrame`](../../packages/capture-formats/src/lmu/source-frame.ts) v2 copies the complete `LMU_Data` block, already including competitors. Merely adding a companion would duplicate data and leave player-file bloat unchanged. Define a versioned partition of new source recordings: player/session records in primary BIN, competitor records in companion, with required unclassified native extensions retained exactly once in an explicitly owned stream. Preserve reconstructed source/replay parity across both files; keep existing full-memory v2 recordings readable. Do not delete source bytes or reduce preservation to a few projected fields to meet a size target. Per-frame payload conservation and primary-file exclusion of competitor records are acceptance requirements; numeric compression savings require measurement.

Extend current reader coherence checks to every newly consumed opponent region; today telemetry equality checks cover only the player's record. A shared capture key must come from one verified coherent snapshot, not two independent reads assigned equal wall-clock times. Rewind/process/session resets create a new generation; frozen/resumed sources, player slot/selection changes, garage return and ID reuse invalidate incompatible caches and fuel/energy deltas. No-player/scoring-only recording support must be explicit, not fabricated player frames.

Session index owns companion schema version, file identity/integrity, frame-key ranges and publication state. Publish only verified references. Interrupted publication/restart must preserve the last committed readable state, mark incomplete competitor data explicitly, and never advertise complete parity. Missing/corrupt companion preserves independently readable player data with competitor unavailable. Selected-lap exports include required companion range and identity/bootstrap context; import restores both streams. Deleting one lap cannot remove a companion referenced by other laps; final session cleanup removes unreferenced companion artifacts. Existing retention policy and issue #471 still apply.

## Observable acceptance criteria and phase gates

- **LC1 — Phase 2:** Opponent ID joins survive reorder, duplicate/unknown IDs, departures/reuse, spectator/no-player and player-slot transitions without cross-attribution.
- **LC2 — Phase 2:** Opponent scoring/timing/class/pit/gap semantics preserve source limitations and explicit derivations; multiplayer placeholders never become measured opponent physics.
- **LC3 — Phase 1; extend in Phase 2:** Player energy quantities and units remain separate; valid zero, absent, stale and invalid values are distinguishable. Phase 2 adds restricted-opponent-placeholder cases without weakening Phase 1 behavior.
- **LC4 — Phase 1:** Verified player/session REST inventory reaches production client/pipeline with typed provenance, applicability, units, acquisition time and freshness; errors/delays never stall native frames.
- **LC5 — Phase 2:** Versioned primary/companion partition avoids competitor duplication in primary BIN, conserves supported source bytes/states, and replays/exports/imports by coherent capture key with original source times. Legacy omissions remain unavailable.
- **LC6 — Both phases:** Phase 1 player/session/vehicle/lifecycle transitions invalidate incompatible state/deltas and reject old async results. Phase 2 extends this to opponent ID reuse/incarnations and companion state.
- **LC7 — Both phases:** Each phase preserves UDP/native coexistence and other games; catalog, capability/recording docs and release notes describe only that phase's verified behavior.
- **LC8 — Phase 1:** Changing supported player extensions and REST values/states/times survive production recording, offline replay, history, selected-lap export and reimport using the Phase 1 capture path. Legacy v2/CSV omissions remain explicit; no companion BIN is required.
- **LC9 — Phase 1:** Source-backed inventory resolves player engine/motor state/RPM/torque/temperatures, steering feedback, detailed weather/wetness, timing/gaps, controls/pit state, penalties/flags/services. Supported missing fields reach normal live output with correct semantics; unsupported fields have unavailable mappings and evidence. Existing sector-time/energy catalog unit mistakes are corrected, not re-pinned.

## Required E2E evidence

Extend existing native-source/replay/integration harness with controlled shared-memory bytes and an actual controlled HTTP server. Exercise production reader/source, client, normalizer, pipeline, WebSocket validators, storage and UI; mocks cannot replace these integrations. Backend/UI may proceed independently within a phase against its finalized boundary, but actual integration is that phase's completion gate.

### Phase 1 scenarios — required before opponent implementation

| Scenario | Setup/action → observable expected outcome | Criteria |
|---|---|---|
| E2E-LMU-PLAYER-CHANNELS | Feed distinct player engine/motor/FFB/weather/wetness/timing/control/pit values and unsupported states through production native source → supported semantics/units reach live UI without combining physical concepts; unsupported values explicitly unavailable | LC9 |
| E2E-LMU-ENERGY | Feed distinct player energy quantities, zero/depletion/refill and missing/stale/invalid readings → separate units/states and no fraction-to-joule relabeling | LC3 |
| E2E-LMU-REST | Each verified player/session endpoint via actual client, including delayed/error/malformed/missing/unchanged responses → native output continues; source metadata/age/state and applicability remain correct | LC4 |
| E2E-LMU-PLAYER-LIFECYCLE | Rewind, garage, pause/freeze/resume, player slot/vehicle change, disconnect/restart; late REST completion → correct player context and reset deltas, no old-session overwrite or guessed player | LC6 |
| E2E-LMU-PLAYER-RETENTION | Record changing player native/extension/REST values with unequal source updates, then production replay/history/selected-lap export/reimport without a companion → values/states/original observation times match; legacy v2/CSV missing values unavailable | LC3, LC8 |
| E2E-LMU-UDP-COEXIST | Native supervisor and configured UDP traffic together → no blocking/cross-game attribution; other-game browser/locale smoke remains correct | LC7 |
| E2E-LMU-REAL-PLAYER | Windows LMU player session with actual native and verified REST sources, actual state changes and REST loss → confirm player channel inventory/units, retention and graceful native-only behavior; no opponent claim needed | LC3, LC4, LC6, LC7, LC8, LC9 |

### Phase 2 scenarios — opponent and companion acceptance

| Scenario | Setup/action → observable expected outcome | Criteria |
|---|---|---|
| E2E-LMU-IDENTITY | Reorder arrays; join/leave/reuse IDs; duplicate IDs; no player marker; slot swap → stable incarnation-aware identity and correct supported scoring; ambiguous/missing physics unavailable | LC1, LC2, LC6 |
| E2E-LMU-OPPONENT-ENERGY | Multiplayer restricted placeholders and fuel-or-battery fraction → accurate source limitation, no inferred fuel liters or player-to-opponent borrowing | LC2, LC3 |
| E2E-LMU-LIFECYCLE | Phase 1 transitions plus opponent ID reuse, joins/leaves and companion recovery → no stale opponent attribution or corruption of player/REST context | LC1, LC6 |
| E2E-LMU-RETENTION | Record native/competitor/REST data with sparse unequal updates and repeated times → inspect partition and production replay/export/import/history → source conservation, no competitor duplication in primary, exact capture association and original observation ages | LC5, LC8 |
| E2E-LMU-COMPANION-FAILURE | Interrupt publication/restart; omit/corrupt companion; selected-lap export/reimport; delete one then final lap/session → no false complete state, readable player data, correct range/bootstrap and reference-safe cleanup | LC5, LC6 |
| E2E-LMU-COHERENCE | Change opponent memory between copies → reject torn snapshot; repeated scoring with new physics/REST update → correct capture association without false source freshness | LC1, LC4, LC5 |
| E2E-LMU-REAL-OPPONENTS | Windows LMU multiplayer with actual state/slot changes and REST loss → verify opponent field availability/limitations, identity, timing and companion parity; preserve Phase 1 player behavior | LC1–LC9 |

Repeat Phase 1 scenarios in Phase 2 when relevant inputs change; reuse unchanged successful results only while their scope remains valid. Record exact fixture/source/game versions, commands and outcomes per phase. Controlled scenarios do not replace that phase's real simulator smoke. Unavailable endpoints/environments and unrun scenarios remain blockers, not passed evidence. This is a planning revision; no implementation or E2E execution is claimed.

## Ownership

Backend integration owner owns shared schema/catalog, validators, source inventory, companion format/index and generation rules. UI consumes typed data without inventing measurements. Contract changes update both linked plans before dependent implementation proceeds. Coordinate shared preservation strategy with #477; its ACC shared-memory/UDP transport design is not LMU's native/REST design.
