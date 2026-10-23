# LMU competitor and supplementary telemetry contract

[Backend plan](lmu-competitor-data-backend-plan.md) · [UI plan](lmu-competitor-data-ui-plan.md) · [Proposed ADR](../adr/0014-lmu-competitor-data.md)

## Status and evidence

Shared boundary for [issue #478](https://github.com/SpeedHQ/RaceIQ/issues/478), audited against TinyPedal on 2026-10-20. Phase 1 and Phase 2 implementation are present, including opponent capture, partitioned retention, removal, recording preference, comparison and shared replay. Controlled evidence is recorded in the linked plans. Neither phase has fresh running-Windows-LMU acceptance: `E2E-LMU-REAL-PLAYER` and `E2E-LMU-REAL-OPPONENTS` remain explicit gates. Native one-to-one [semantic rules](../reference/semantics.md) and existing [`ResolvedValue<T>` / timestamps / provenance](../../shared/telemetry/resolver/contracts.ts) remain authoritative. Do not copy TinyPedal implementation.

Implementation authorized on 2026-10-22. The user explicitly moved real-recording testing to after implementation: develop and verify controlled production integrations now, then use a fresh Windows LMU multiplayer recording for final channel/source and racing-line acceptance. This supersedes historical wording requiring real Windows acceptance before Phase 2 coding; it does not mark any unrun scenario passed or enable unproven remote inputs.

### Current replay baseline

Planning baseline: `Snazzie/replay` at `7faddf9c4` (2026-10-22), incorporated into the current feature branch by fast-forward. Follow the implemented [lap replay contract](../../advisor-plans/lap-replay-contract.md), [UI ownership](../../advisor-plans/lap-replay-ui-plan.md) and [server ownership](../../advisor-plans/lap-replay-backend-plan.md). `@raceiq/lap-replay` owns shared Replay/Spectate UI, semantic replay routes/contracts and package E2Es; the client owns route selection, authenticated RPC and typed host composition. Extend existing selection controls and shared workspace; do not create a separate opponent replay UI, clone panels or revive retired client Spectate paths. Earlier Phase 1 evidence remains a historical record, not fresh verification of this baseline.

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
Snapshot expiry uses acquisition age, not the age of the last value change;
unchanged successful polls keep snapshots available without rewriting provenance.
Capacity, localized refill selection and pit/repair estimate units are still
unverified and are deliberately unavailable. Raw condition scaling is not
claimed as a damage/wear percentage.

Source-frame v3 retains the entire v2 native-memory block plus the typed context.
Its sparse records delta-encode native blocks and retain changing observations,
states and original timestamp precision in the primary stream. Legacy v1/v2
remain readable; absent legacy observations cannot be reconstructed. Phase 1
introduced no competitor collection or companion; the Phase 2 storage boundary
below now governs new recordings. Controlled pipeline and round-trip evidence does not
replace `E2E-LMU-REAL-PLAYER`; the Windows LMU acceptance gate remains unverified
until run against an actual game/version/mode.

### Phase 1 review corrections

New DuckDB imports use a separately versioned **compact synthetic source frame v4**. It retains the v1 compact native payload/header layout and appends a JSON array of known importer channel names; the decoded `LMUSourceFrameV4.syntheticChannels` is a required `readonly string[]`. Metadata is limited to 4,096 UTF-8 bytes, at most one entry per allowlisted channel, and no duplicates or unknown names. Malformed metadata is rejected; compact v4 cannot enter full-memory v2/v3 sparse encoding. The header retains the original capture timestamp.

Availability is per observation: event channels remain absent before their first recorded event. Omitted player extension fields resolve as missing, including byte/boolean channels; a supplied zero or false remains valid. Availability survives primary recording, replay and selected-lap export/import. Native acquisition remains v3 and native v1/v2 reads remain unchanged. Previously imported, unmarked v1 frames cannot safely be distinguished from native v1 and are not retroactively reclassified.

Selected-lap export must sparse-encode native v3 frames even when context lengths change. Required regression evidence checks bounded decompressed export size and production reimport conservation without increasing archive safety limits.

Scoring-backed channels use the scoring snapshot's native elapsed time, independently of the faster physics clock. Repeated scoring timestamps retain their source observation identity; a new scoring timestamp advances the observation even if its value is unchanged. Live and historical resolution compare compatible native clocks without replacing original capture/REST clocks. Invalid, missing or future scoring clocks yield unknown freshness, never fabricated fresh observations. Native freeze/disconnect deadlines use a monotonic clock; wall-clock corrections do not prolong player availability.

REST cleanup must cancel rejected response bodies before discarding timeout/controller ownership. Condition schemas are semantic-specific: aero is one finite nonnegative scalar, while brakes and suspension are exactly four finite nonnegative wheel values. Malformed shapes are invalid; zero remains valid.

### Phase 2 — Multiplayer opponents and companion BIN

After preserving Phase 1's implemented behavior and controlled integration gates, add opponent identity/scoring and verified multiplayer channels, grid projection/UI, incarnation-aware joins, coherence checks and versioned primary/companion partition. Real Windows player/opponent evidence is a final acceptance gate after implementation, not a coding prerequisite.

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

Implemented scoring reports also retain `mTimeBehindNext` / `mTimeBehindLeader`
in seconds separately from their signed lap-deficit fields. Negative/nonfinite
time reports and negative lap deficits are invalid; numeric zero remains valid.
The packed-four-byte [immutable scoring schema](https://github.com/TinyPedal/pyLMUSharedMemory/blob/6a8dd8311d76291d602e020f059b8baae3d518a5/lmu_data.py)
defines the [native offsets](../../packages/capture-formats/src/lmu/layout.ts).
`mInPits` remains a source report with its remote-accuracy caveat; pit-state
codes outside 0–4 are invalid. `mServerScored` is a mode-dependent source flag,
not proof of lap validity. These schema-backed projections do not establish
population or cadence in an actual multiplayer build.


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

REST acquisition time is not source measurement time. `observation.provenance.observedAt`, source observation, state and freshness retain that distinction; an estimate or cached garage snapshot never becomes fresh physics. Full supplemental validation and source-specific applicability rules are required before exposing each semantic. Phase 1 enrichment requires no new public HTTP endpoint; Phase 2 storage/opponent comparison operations are defined below. Historical/replay responses carry the same typed LMU context where applicable; update existing response validators with their consumers.

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

### Agreed partition codec boundary

`@raceiq/capture-formats/lmu/partition` owns `partitionLMUSourceFrame`, `restoreLMUSourceFrame`, `getLMUPartitionSourceLength`, `getLMUPartitionKey` and primary/companion validation. Backend storage consumes these functions; it does not parse private descriptor offsets. Native v5 primary retains original header semantics plus original source version/length, selected player offsets and ordered retained-byte ranges. It owns native session/header regions and the selected player's scoring/telemetry records. All other scoring/telemetry slots, including unused slots and the scoring results stream, belong to the companion. Original v3 context is split at the complete top-level competitor property/separator; primary retains valid player-only JSON and companion retains only the removed raw bytes. Unknown bytes outside the classified opponent regions remain primary-owned.

Companion v1 has distinct magic, strict complementary source ranges, SHA-256 of its exact primary and SHA-256 of the reconstructed original. Restore requires complete nonoverlapping coverage and both integrity checks; no nearest-time association. Retained restore reproduces original v2/v3 bytes exactly, including context whitespace and timestamp precision. Independent primary decoding extracts player buffers/context directly without synthesizing a full-memory opponent grid. Source v1/v2/v3 and synthetic v4 readers remain available.

Both streams use existing session framing and bounded sparse checkpoint chains; partition deltas preserve variable payload lengths with explicit changed-block coverage. Direct recorder/manifests retain original logical native wire lengths for detector/lap coordinates via `getLMUPartitionSourceLength`, not physical primary lengths. Joined loader output must retain those logical coordinates whether it emits restored source or independent compact primary. Per-frame pair identity is content-bound; session manifests additionally own synced byte prefixes, file integrity, key ranges and publication state.

### Optional opponent retention and explicit removal

Approved implementation scope for [#485](https://github.com/SpeedHQ/RaceIQ/issues/485): opponent history is optional storage, not a prerequisite for player replay. Backend integration finalizes shared schemas before parallel consumers. Controlled-fixture implementation is authorized now; real Windows acceptance follows implementation using a new recording.

- Removal is an explicit, irreversible, **whole-session** operation, including every retained lap in that session. One request may select multiple sessions. No per-car/per-lap pruning, automatic age policy or remote-backup deletion is added. Live opponents continue to work; future sessions follow the recording setting below, which defaults to enabled.
- New partitioned recordings keep all opponent-owned payloads, sparse checkpoints, bootstrap and derived opponent history out of primary artifacts. Primary player/session decoding, including player identity, timing, REST and parser initialization, must never require the companion. Shared session facts and original player gap observations remain player/session data; removal is not anonymization of all mentions of other drivers. Every source region must have explicit ownership, including unused slots/unclassified extensions; classify player-required bytes into primary and opponent-only bytes into companion. Never discard unclassified bytes merely to reduce size.
- Retained recordings conserve supported source bytes/states exactly once across both streams under LC5. **Confirmed removal or explicit recording opt-out** intentionally relinquishes opponent preservation. In either case, conservation applies to player/session data, not reconstruction of the original full grid. A stripped or opted-out file cannot silently synthesize opponent zeros or claim full-source parity.
- Persist `opponentRetention: "retained" | "removed" | "not-recorded"` in the versioned manifest and historical/export metadata. For retained data, separately report `opponentAvailability: "complete" | "incomplete" | "missing" | "corrupt"` using existing integrity/range checks. For removed/not-recorded data, availability is null. Legacy metadata absence is not proof of removal; legacy decoders establish embedded availability. History uses the same metadata in real responses/validators; live context remains unchanged.
- Serialize removal with recording/retiring capture, compression, downsampling, splitting/rebuild, relocation and deletion using existing storage maintenance admission. Revalidate source revision and all references after admission. Reject active/retiring work; skip artifacts referenced outside the selected session set, never silently strip another session. Existing exports/readers finish against a pinned revision before unlink, or admission returns busy. Paths come exclusively from validated owned manifests, never request input.
- For partitioned data, atomically publish a durable removed revision before unlinking unreferenced companion files. Do not rewrite primary bytes, lap identities, player source offsets, timestamps or analyses that depend only on player/session data. Invalidate opponent caches/derived results and revision-bound history/export caches. Persist a cleanup-pending artifact list until unlink succeeds; restart retries cleanup without reattaching removed data. A missing/corrupt companion remains missing/corrupt unless explicitly removed by this operation.
- Support existing full-memory native v2/v3 through a streaming, staged rewrite into the agreed partition, followed by removal. Validate player/session observations, clocks, identity and lap/bootstrap ownership against the original before atomic source/index publication; retire old embedded originals only after every reference/read lease is safe. Sparse deltas must not retain opponent bytes in checkpoints. Before publication, any parse, space or I/O failure preserves the old recording. Unknown/unsupported formats are skipped with a reason; compact synthetic v4 and player-only inputs with no opponent payload are not rewritten.
- Export of retained sessions includes the required companion ranges/bootstrap by default. Export after removal emits a player-only bundle with the removal marker and no opponent payload/bootstrap/index/derived cache; import preserves that state. Missing/corrupt retained companions must not be relabeled removed to make an export succeed. Copies exported before removal and external backups are unaffected.

#### Recording preference — enabled by default

Add `recordLmuOpponents: boolean` to the existing persisted settings schema in `server/runtime/config/settings.ts` and corresponding shared/client settings definitions. Default is **true**, including existing settings files where the field is absent. Complete `GET /api/settings` responses contain a non-null boolean; existing partial `PUT /api/settings` accepts the optional boolean, preserving unrelated settings and the existing validation/auth/error behavior. Null, string and numeric substitutes return 400 without changing persisted/runtime state. Example opt-out: `{ "recordLmuOpponents": false }`; omission is not opt-out.

Snapshot the saved value when a new LMU recording session starts and hold it for that session, including lap rotations and pause/resume. Changing the setting mid-session affects the **next recording session**, not the current/retiring session; the UI must explain that timing. Successful save survives restart; failed save leaves the prior persisted/effective policy intact. Session admission owns the snapshot so asynchronous writers cannot mix policies.

When false, continue native acquisition and live opponent presentation, but persist only the primary player/session partition: no opponent companion, opponent lap index, opponent snapshots in primary/sparse checkpoints/bootstrap, or disk-backed opponent-derived comparison caches. Mark history/export metadata `opponentRetention: "not-recorded"` and availability null. Preserve player identification, timing/gaps, REST and shared session facts; this is a storage choice, not complete opponent-name anonymization. Retain raw native opponent data in transient acquisition memory only where needed for coherent live reads, never accidentally through the legacy full-memory writer. Unclassified ownership is a format-design gate, not permission to drop player-required source bytes.

When true, retain the companion and comparison-capable observations according to this contract; never advertise complete availability if the writer fails. Opting out does not remove existing recordings/imports; use explicit removal for those. Re-enabling applies to the next new session and cannot reconstruct missed history. Existing imported retained data stays retained regardless of this live-capture preference. Other games, UDP and recording frequency/age-retention settings remain unchanged.

**E2E-LMU-RECORDING-POLICY → LC14, LC5, LC7, LC10, LC13:** use isolated legacy settings without the new key, production settings HTTP and actual native ingress. Confirm default true in API/UI and real companion output; save false, reload/restart, then record a new session with distinctive opponents → live UI still shows them, primary/player replay unchanged, no opponent payload/index/companion on disk, history and exported/reimported ZIP explicitly not-recorded and picker explains why. Change false→true and true→false during active sessions and lap rotation → current session retains its admission policy, next session uses saved policy; no retroactive removal or restoration. Invalid/null/wrong-type and injected persistence failure preserve prior policy; unrelated/other-game settings and retained imports remain unchanged. Run Settings keyboard/mobile/localized checks and record actual files, API results and visible outcomes. Backend integration owns joint execution; UI owns browser assertions.

#### Removal API

Extend the existing authenticated storage route group in [`storage-routes.ts`](../../apps/backend/src/routes/system/storage-routes.ts); use Hono RPC and the existing managed maintenance runtime, not a second job runner. Shared request/status types belong beside [`downsample.ts`](../../shared/racing/sessions/downsample.ts), owned by backend integration.

| Operation | Request and response |
|---|---|
| `POST /api/storage/session-opponents/preview` | `{ sessionIds: number[] }` → 200 preview below; no mutation |
| `POST /api/storage/session-opponents` | Same request → 202 `{ accepted: true }` only after maintenance admission/reservation; requires explicit UI confirmation |
| `GET /api/storage/session-opponents` | No body → 200 status below |

`sessionIds` is a nonempty array of distinct positive safe integers, at most 1,000; unknown fields, malformed JSON or invalid IDs return 400 `{ code: "INVALID_OPPONENT_REMOVAL_REQUEST", error: string }`. Existing auth/game-access rules apply to every selected session before any mutation. No caller-supplied file paths, pagination or ordering parameters. Results sort by session ID; shared-file groups are processed once. Unknown/deleted IDs are skipped, not implicit selection of other sessions.

```ts
type OpponentRemovalRequest = { sessionIds: number[] };
type OpponentRemovalSkip = {
  sessionIds: number[];
  reason: "not-found" | "not-recorded" | "already-removed" |
    "unsupported-format" | "unowned" | "shared-reference" | "invalid-source";
};
type OpponentRemovalPreview = {
  request: OpponentRemovalRequest;
  candidateSessionIds: number[];
  companionBytes: number; // currently owned removable companion files; unique physical files only
  rewriteSessionIds: number[]; // legacy source rewrite required; savings unknown before validation
  skipped: OpponentRemovalSkip[];
};
type OpponentRemovalStatus = {
  status: "idle" | "running" | "success" | "partial" | "error";
  request: OpponentRemovalRequest | null; // null only before any admitted job
  done: number; total: number; // selected sessions settled / selected sessions
  removedSessionIds: number[]; // durable removed publication, even if cleanup pending
  freedBytes: number; // successfully unlinked bytes less newly created retained artifacts; never estimates
  cleanupPendingSessionIds: number[];
  skipped: OpponentRemovalSkip[];
  failed: { sessionIds: number[]; message: string }[];
  error: string | null;
};
```

Example: preview `{ "sessionIds": [12, 13] }` may return `{ "request": { "sessionIds": [12, 13] }, "candidateSessionIds": [12, 13], "companionBytes": 8388608, "rewriteSessionIds": [13], "skipped": [] }`. The UI must not label `companionBytes` as guaranteed total savings.

Busy maintenance/active capture/stale source revision returns 409 `{ code: "STORAGE_BUSY" | "SOURCE_CHANGED", error: string }` without changing the last admitted status. Unexpected preview/admission I/O returns 500 `{ code: "STORAGE_IO_ERROR", error: string }`. Recheck eligibility at execution; pre-publication per-session failure leaves originals authoritative, reports `failed`, and continues independent sessions. Unlink failure after publication reports cleanup pending, partial/error and actual reclaimed bytes, never rollback to retained or false success. Repeated removal is idempotent: already-removed skips unless pending cleanup needs retry. No durable running-progress promise; manifest state and cleanup intent are durable. Status follows existing in-process terminal-snapshot semantics; poll once per second while running and refresh on focus/mount, invalidate affected session/history/storage queries after settlement.

#### Removal edge handling and shared E2E scenarios

Extend production recording/import/export/backend harnesses and existing Storage Playwright coverage; no mock response may replace these integrations. Backend integration owns execution/evidence; UI owns browser actions/assertions in the same scenarios. Each uses an isolated DATA_DIR/DB and deterministic native bytes with unequal updates, repeated times, player-slot transitions, multiple laps and recognizable opponent values. Read actual files and real history responses, not only status counters.

| Scenario | Setup / action → observable expected outcome | Criteria |
|---|---|---|
| E2E-LMU-STRIP | Record a finalized partitioned session through production ingress; open Storage, select it, preview, cancel once, then confirm → preview/cancel change no files; confirmed removal leaves primary checksums, lap IDs, player/REST values/states/clocks and player analyses unchanged; opponent bytes/files/indexes/derived history absent, explicit removed state after restart, actual disk-byte accounting matches status; live/future sessions unaffected | LC10, LC11 |
| E2E-LMU-STRIP-LEGACY | Import native v2/v3 full-memory and sparse fixtures, including slot changes and boundary/bootstrap records; remove through actual API → validated rewrite eliminates embedded opponent payloads while real player replay/history remains equivalent. Unsupported, malformed and player-only/synthetic input skip with reasons and unchanged originals; inject insufficient space/parse/write failure before publication → original readable, no removed claim | LC10, LC11 |
| E2E-LMU-STRIP-RECOVERY | Stop/restart backend at pre-publication, post-publication/pre-unlink and mid-cleanup barriers; inject unlink failure; retry twice → original retained before commit, explicit removed after commit, no stale cache/resurrection, safe cleanup retry and no double-counted savings. Missing/corrupt retained companion stays distinct until confirmed removal | LC10, LC11 |
| E2E-LMU-STRIP-REFERENCES | Two sessions reference one artifact; select one, then all owners; overlap with active/retiring capture, export read lease and each maintenance operation; change source revision after preview → no outside-session loss, 409/skip where required, eligible retry succeeds only after ownership/leases settle. Partial/final lap deletion, relocation and downsampling preserve removed state and player readability | LC10, LC11, LC6 |
| E2E-LMU-STRIP-ROUNDTRIP | Export selected laps before and after removal; import each into a separate real backend → retained bundle preserves companions; stripped bundle contains no opponent payload/bootstrap/index and preserves removed metadata and player parity; older exported copy remains retained. Missing/corrupt retained export reports existing integrity failure rather than removed | LC10, LC11, LC5 |
| E2E-LMU-STRIP-UI | Real desktop/mobile Storage → select one/multiple sessions, preview legacy rewrite warning/unknown savings, keyboard cancel/confirm, navigate/reload during work, render partial/busy/error/pending-cleanup; historical replay distinguishes removed/missing/corrupt/not-recorded and never blocks player data. Every added message translated across supported locales | LC11, LC7 |

### Opponent lap selection and comparison

Select a recorded opponent lap and compare it with a selected player lap using existing comparison selectors and shared Replay/Spectate workspace. Backend integration owns shared types, lap indexing and comparison semantics; UI owns selection/host integration. Implementation is authorized against the agreed boundary; actual multiplayer evidence remains the final gate for enabling each source capability.


#### Feasibility assessment — schema evidence, not multiplayer acceptance

The pinned [LMU native ABI mapping](https://github.com/TinyPedal/pyLMUSharedMemory/blob/6a8dd8311d76291d602e020f059b8baae3d518a5/lmu_data.py) explicitly maps Studio 397's shipped `SharedMemoryInterface.hpp` / `InternalsPlugin.hpp`. Its `LMUVehicleScoring`, `LMUVehicleTelemetry` and 104-entry telemetry/scoring arrays establish structural feasibility, not guaranteed online channel population. Repository [layout](../../packages/capture-formats/src/lmu/layout.ts) and [reader](../../packages/game-lmu/src/memory-reader.ts) corroborate ABI integration but currently expose/coherence-check player telemetry only. No installed Windows SDK header or real multiplayer capture was available for this assessment.

| Comparison capability | Actual contract fields | Feasibility and planned handling |
|---|---|---|
| Identify driver/car/class and recorded lap | Scoring `mID`, `mDriverName`, `mVehicleName`, `mVehicleClass`, `mTotalLaps`, `mSector`, `mLapStartET`; session `mCurrentET` | Structurally feasible. Index observed transitions by generation/incarnation; mid-lap starts and missed transitions stay partial. Reused IDs/names never merge laps. |
| Lap/sector timing | Scoring `mLastLapTime`, `mLastSector1`, `mLastSector2`, `mCurSector1/2`, best-lap reports, `mCountLapFlag` | Strongest baseline. Capture reports at the correct transition; sector 2 is cumulative sectors 1–2. Best sector values need not belong to the best lap. Count-lap state is not a historical per-lap invalidation ledger; unknown validity stays unknown. |
| Opponent path, pose and coarse speed trace | Scoring `mPos`, `mOri`, `mLocalVel`, `mLapDist`, with scoring `mCurrentET`; same kinematics also occur in telemetry | Structurally feasible without assuming full opponent physics. Explicitly derive speed magnitude from velocity and orientation from native matrix; preserve scoring observation cadence/quality, not player telemetry rate. Local layout currently lacks scoring velocity/orientation offsets: audit/add them before use. Prove population, coordinates, continuity and cadence in multiplayer before enabling these channels. No fixed Hz claim or position-differentiation fallback. |
| Continuous distance-aligned time delta | Observed scoring clock, verified `mLapStartET`, lap distance and source coverage | Conditional derived comparison. `mTimeIntoLap` and `mEstimatedLapTime` are explicitly estimates, not measured elapsed time; never silently use them for a measured delta curve. No curve across missing/noninvertible intervals or from total lap times alone. |
| Throttle/brake/steering, gear/RPM, tire/energy detail | `LMUVehicleTelemetry` includes filtered/unfiltered inputs, `mGear`, `mEngineRPM`, wheels and hybrid channels; these inputs are absent from the scoring structure | ABI has fields, but full remote-car population/accuracy is unproven. Enable per channel/version/mode only after actual online evidence; otherwise unavailable. Do not conclude “all opponent inputs work” from an array declaration or community wrapper accepting an index. |
| Fuel comparison | Scoring `mFuelFraction` means fuel **or battery**; telemetry has `mFuel`/`mFuelCapacity` | Absolute opponent fuel not promised. [Observed multiplayer correction](https://github.com/TinyPedal/TinyPedal/commit/514b20be5eb011819e79327eea077e58a975ded5) removes the ratio because it returns constant 0.5 online. Never infer liters/capacity or silently treat this ambiguous fraction as measured fuel. |

**Conclusion:** selecting recorded opponent laps and comparing timing is contract-feasible. Position/speed/coarse paired replay is structurally feasible through scoring kinematics, subject to runtime verification. Full driving-input comparison cannot currently be promised. The [official DuckDB recording guide](https://guide.lemansultimate.com/hc/en-gb/articles/14524956311695-Telemetry-Recording) documents configurable local recording channels; it does not establish remote-opponent input availability in shared memory. Measure online field presence, restrictions, observation cadence and identity against the actual shipped header/game version in `E2E-LMU-REAL-OPPONENTS`; persist that capability evidence in the source inventory before enabling each semantic. A static range check cannot prove a zero-valued channel is populated.

#### Identity, eligibility and retention

- Start from one saved player lap. Opponent candidates come from that lap's recorded LMU session and exact track/layout; compare one opponent lap at a time. Different cars/classes are allowed and visibly labeled, with no performance normalization. Existing player-to-player comparison remains unchanged; cross-session opponent browsing, AI analysis, opponent-to-opponent comparison and synthetic imported player laps are not required.
- Build a companion-backed lap index from coherent scoring progression and capture keys, scoped by session generation, native vehicle ID and incarnation. An opaque `opponentLapId` identifies one actual recorded lap interval, not a displayed lap number or array slot; source revision is checked separately. Derive stable IDs from preserved identity and interval keys so rebuild/export/import can remap session ownership without confusing laps. Never invent lap samples from rolling best/last-lap scalars, bridge generations/departures or assume the opponent crosses a lap boundary with the player.
- Record lap coverage (`complete` or `partial`) separately from source validity (`valid`, `invalid`, `unknown`). Mid-lap capture, dropped ranges, disconnect and unfinished laps remain partial. Invalid/unknown laps may be selected with a visible warning if they have comparable evidence; never silently choose “best” or hide all invalid laps. A row with neither paired timing nor comparable traces stays visible but disabled with an explicit reason.
- Lap/sector comparison uses actual source-backed reports associated with that opponent lap. Native cumulative sector timing retains its catalog meaning; derive individual durations only from compatible inputs with explicit provenance. Missing timing stays unavailable. Total/sector deltas are player minus opponent, in seconds: positive means the player is slower. A total lap time does not justify a continuous delta trace.
- Trace comparison uses only source-verified channels for that car/mode, valid distance coordinates and supported alignment domains. Preserve original observations/provenance, units, sparse coverage and gaps. Render gaps rather than zero-fill or interpolation across missing intervals. Repeated scoring samples do not become high-frequency physics; distance alignment/resampling is an explicit display derivation, never a new source observation. No inferred throttle/brake/steering/fuel from position or player data. Racing line requires valid positions; continuous time delta requires valid elapsed-time/distance coverage on both sides.
- Removal deletes the opponent lap index and all opponent comparison caches with the companion; persisted selections can remain in URLs but cannot restore data. Missing/corrupt/incomplete retained data stays distinct from intentional removal. Player lap reads/comparison remain usable. Retained selected-lap bundles include opponent intervals overlapping exported player ranges and any explicitly selected opponent lap's full required interval/bootstrap, even when it extends beyond the player's lap; import rebuilds candidate identities against imported session ownership. Stripped bundles never carry those intervals or caches.

#### Typed API and route selection

Add opponent semantic replay/catalog operations in `packages/lap-replay/server` and shared feature types in `packages/lap-replay/contracts`, composed into the existing typed lap route group. The client supplies RPC through `client/src/features/lap-replay-host.tsx`; the feature never imports client/backend composition roots. Comparison calculation may reuse existing backend/analysis-core services without moving storage maintenance into the UI package. Preserve existing semantic replay routes/errors from the authoritative replay contract; use existing auth, `X-Game-Id` validation and Hono RPC for new operations. Resolve the player lap first and enforce access to its session; no client paths or arbitrary cross-session lookup.

| Operation | Request | 200 result |
|---|---|---|
| `GET /api/laps/:id/opponent-laps` | Positive safe-integer player lap ID; no query parameters | `OpponentLapCatalog` below |
| `POST /api/laps/:id/opponent-comparison` | `{ opponentLapId: string, sourceRevision: string, step: 1 }` or `{ opponentLapId: string, sourceRevision: string, step: 0.1, start: number, end: number }` | `OpponentLapComparison` below |
| `GET /api/laps/:id/opponent-laps/:opponentLapId/semantic-telemetry` | Player lap ID, encoded opaque opponent lap ID, required `sourceRevision` query | Original-source semantic envelopes for that opponent interval, with `opponentLapId`/`sourceRevision` instead of numeric `lapId`; otherwise reuse authoritative `SemanticLapTelemetry` fields/serialization and availability |

IDs/revisions are nonempty opaque strings, at most 512 UTF-8 bytes; reject malformed/unknown fields. Detail distances are finite meters with `0 <= start < end`, within both laps' comparable distance domain. Use existing alignment range/budget checks; higher-density display does not imply greater source fidelity. Catalog returns the finite session index without pagination, sorted by driver display name, vehicle ID, incarnation, lap number then opaque ID; UI filters this index locally. Duplicate names remain separate identities.

```ts
interface OpponentLapSummary {
  opponentLapId: string;
  sessionKey: string;
  vehicleId: number;
  incarnation: number;
  driverName: string | null;
  carName: string | null;
  className: string | null;
  lapNumber: number | null;
  coverage: "complete" | "partial";
  validity: "valid" | "invalid" | "unknown";
  lapTime: ResolvedValue<number>; // seconds
  sectors: readonly { semanticId: string; duration: ResolvedValue<number> }[];
  comparableSemanticIds: readonly string[];
  mode: "timing-only" | "telemetry" | "unavailable";
  reasons: readonly string[]; // shared enum, defined below
}
interface OpponentLapCatalog {
  playerLapId: number;
  sourceRevision: string;
  opponentRetention: "retained" | "removed" | "not-recorded";
  opponentAvailability: "complete" | "incomplete" | "missing" | "corrupt" | null;
  laps: readonly OpponentLapSummary[];
}
interface OpponentLapComparison {
  playerLapId: number;
  sourceRevision: string;
  opponent: OpponentLapSummary;
  mode: "timing-only" | "telemetry";
  lapDeltaSeconds: ResolvedValue<number>;
  sectorDeltas: readonly { semanticId: string; deltaSeconds: ResolvedValue<number> }[];
  traces: readonly {
    semanticId: string;
    unit: string; // canonical catalog unit
    distanceMeters: readonly number[];
    player: readonly ResolvedValue<number>[];
    opponent: readonly ResolvedValue<number>[];
  }[];
}
```

Use the existing precision-safe `ResolvedValue` JSON codec/timestamp/provenance rules, not raw bigint JSON. All arrays within one trace have equal length; distance increases strictly. Nonavailable samples contain null with explicit state. `comparableSemanticIds` and `semanticId` use verified catalog entries, not arbitrary names; `reasons` uses shared enum values `partial-lap`, `invalid-lap`, `unknown-validity`, `restricted-channels`, `missing-timing`, `missing-distance`, `missing-position`, `no-comparable-data`. Trace arrays are empty for timing-only; unavailable total/sector deltas may coexist with useful traces. Original player/opponent timings are available from existing player lap data and the opponent summary; delta provenance identifies both inputs and derivation. Comparison response validation rejects fabricated availability or incompatible units.

Representative request: `POST /api/laps/42/opponent-comparison` with `{ "opponentLapId": "opaque-recorded-lap-key", "sourceRevision": "revision-7", "step": 1 }`. For source-supported lap times 101.2 s and 100.8 s with no opponent physics, return timing-only, approximately +0.4 s lap delta, and `traces: []`; do not manufacture a speed/brake chart.

Catalog returns 200 with empty `laps` and explicit retention/availability for removed/not-recorded/missing/corrupt history. Comparison errors use `{ code: string, error: string }`: 400 `INVALID_OPPONENT_COMPARISON` for malformed IDs/body/range or incompatible game/track; existing 401/403 rules for denied access; 404 `LAP_NOT_FOUND` / `OPPONENT_LAP_NOT_FOUND`; 409 `SOURCE_CHANGED` for stale revision; 410 `OPPONENT_DATA_REMOVED` for deliberate removal; 422 `OPPONENT_DATA_UNAVAILABLE` for missing/corrupt/unrecorded data or no comparable evidence; unexpected I/O 500 `STORAGE_IO_ERROR`. Resolve removal/availability before opaque-ID lookup so a stripped selection reports removal, not misleading “lap not found.” Do not fall back to another driver/lap on any error.

Extend existing `GET /api/laps/export-zip` query with optional `opponentLap` and `opponentRevision` strings using the same limits above. Both must be supplied together, with `ids` naming exactly one player lap and `sessionIds` absent; otherwise return 400 `INVALID_OPPONENT_COMPARISON`. Without them preserve existing behavior. With them validate reference/revision and include its full required opponent interval/bootstrap in the existing ZIP format extension, not unrelated player laps. Use the comparison error codes and pinned-revision read rules. Ordinary stripped/not-recorded exports remain player-only with their explicit retention marker.

Keep `/$gameid/compare` and existing player lap A selection. Add reference mode `reference=opponent`, `opponentLap=<opaque ID>`, `opponentRevision=<revision>` to validated compare search; player `lapB`/`carB` are absent in this mode. Existing player mode keeps current search behavior. Back/forward/reload restores the exact reference or an explicit stale/unavailable state. Changing player lap/session/track clears incompatible opponent selection and ignores late old-reference responses. Query/cache keys include game, player lap, opponent identity, source revision and range; removal/rewrite invalidates them. Never reinterpret an opponent ID as a numeric saved player lap ID.

#### Shared comparison E2E scenarios

Extend production native recording/index/history/API harnesses, `packages/lap-replay/test/e2e/{analyse,compare}` for shared Replay/Spectate behavior and `playwright/tests/seeded/compare` for client-owned selection/chart composition. Do not restore relocated Spectate specs to the central suite. Backend integration owns deterministic fixtures, real app boot and joint evidence; UI owns browser assertions. Use isolated DB/storage and controlled native frames, not mocked catalog/comparison responses. Preserve existing replay acceptance C1–C5 from the linked package contract.

| Scenario | Setup / action → observable expected outcome | Criteria |
|---|---|---|
| E2E-LMU-COMPARE-SELECT | Record multiple opponents/laps, duplicate driver names, different classes and unequal player/opponent lap boundaries; open Compare from a player lap, switch reference to Opponents, filter driver/class and choose a non-default lap → exact identity/lap shown, correct timing/sector deltas, selection survives reload/back; cancel/reselect leaves player lap unchanged | LC12, LC13 |
| E2E-LMU-COMPARE-COVERAGE | Record timing-only, source-verified trace, valid zero, restricted-channel, sparse/gapped, partial/invalid/unknown and no-evidence laps → candidate badges/reasons correct; useful warned laps selectable, no-evidence disabled and direct API rejects; only supported channels/line/delta render, gaps remain gaps, no interpolation masquerades as physics. Cumulative sector inputs derive correct individual durations; absent inputs stay unavailable | LC12, LC13, LC2 |
| E2E-LMU-COMPARE-IDENTITY | Join/leave/reuse IDs, reorder, rewind, driver replacement, slot swap, mid-lap capture and repeated lap labels; change player/session/track during pending fetch → no merged laps or stale results, correct incarnation/ranges; stale revision and foreign-session opaque ID fail explicitly, no auto-substitution | LC12, LC13, LC1, LC6 |
| E2E-LMU-COMPARE-RETENTION | Choose opponent lap extending beyond player lap, export/reimport selected comparison with full opponent interval; verify same timings/available traces. Strip opponent history while comparison is cached/open, then reload/rebuild/export/import → index/caches/traces removed, explicit removed state and player intact. Missing/corrupt companion produces distinct failure, not removed. Retained imports without full opponent interval expose partial coverage, never complete | LC12, LC13, LC5, LC10 |
| E2E-LMU-COMPARE-UI | Real app/API on desktop/mobile and supported locale checks: search driver, filter class, keyboard choose lap, confirm/cancel, empty/loading/error/retry, timing-only and trace views → accessible focus/announcements, readable selection/coverage, no horizontal page overflow. Existing player-to-player and other-game Compare cases remain unchanged | LC13, LC7 |
| E2E-LMU-COMPARE-REPLAY | Record distinct scoring kinematics/observation times with no populated remote input channels; select opponent B through existing controls and open the shared Spectate workspace → actual recorded A/B poses and source clocks stay attributable, gaps/repeated times do not fabricate frames, missing inputs/AI/Insights remain explicitly unsupported; switch back to single Replay/player pair → playback, focus, panel order/width/persistence and keyboard behavior preserved | LC12, LC13, LC7 |

Extend `E2E-LMU-REAL-OPPONENTS` with selecting actual multiplayer opponent laps and confirming timing/trace availability against a fresh recording after implementation. Controlled fixtures establish deterministic behavior, not multiplayer population. Every criterion requires recorded passing production-integration evidence for final acceptance; unrun real-recording checks remain explicit.

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
- **LC10 — Phase 2:** Explicit session-wide opponent removal physically reclaims owned opponent storage without changing player/session semantics or affecting external references. New primary bytes stay unchanged; legacy v2/v3 rewrites preserve player/session parity. Removal is durable, idempotent, crash-safe and accurately accounted; stripped exports/imports cannot restore removed opponents.
- **LC11 — Phase 2:** Actual Storage UI supports preview, cancel, irreversible confirmation, bulk session selection and observable progress/results using the real API. History/export/import distinguish intentional removal from missing/corrupt/not-recorded opponents; player views remain usable and labels translated.
- **LC12 — Phase 2:** Actual recorded opponent laps are independently indexed and selectable by stable incarnation-aware interval identity. Player-versus-selected-opponent comparison preserves timing semantics, eligibility/coverage and only verified telemetry; no fabricated laps, fields, alignment or cross-attribution.
- **LC13 — Phase 2:** Existing comparison selection UI is extended for opponent driver/car/class/lap choice, coverage/validity preview and explicit comparison action; shared Replay/Spectate panels/controllers are reused without a parallel UI. Exact selection/availability survive navigation, export/import and retention changes; integrated desktop/mobile/localized/keyboard flows and existing player replay/comparison remain correct.
- **LC14 — Phase 2:** Persisted opponent-recording preference defaults to enabled for new/existing installs. Explicit opt-out applies to the next recording session, preserves live opponents/player recordings and writes no opponent payload/index/cache; history/export/import mark not-recorded. Session-boundary transitions, invalid/failed saves, restart and re-enable behave as specified.

## Required E2E evidence

Extend existing native-source/replay/integration harness with controlled shared-memory bytes and an actual controlled HTTP server. Exercise production reader/source, client, normalizer, pipeline, WebSocket validators, storage and UI; mocks cannot replace these integrations. Backend/UI may proceed independently within a phase against its finalized boundary, but actual integration is that phase's completion gate.

### Phase 1 regression scenarios — preserve during opponent implementation

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
| E2E-LMU-STRIP / STRIP-LEGACY / STRIP-RECOVERY / STRIP-REFERENCES / STRIP-ROUNDTRIP / STRIP-UI | Execute the detailed removal scenarios above through production APIs, storage and UI, recording commands, fault barriers, byte measurements and visible outcomes | LC10, LC11; related LC5, LC6, LC7 |
| E2E-LMU-COMPARE-SELECT / COMPARE-COVERAGE / COMPARE-IDENTITY / COMPARE-RETENTION / COMPARE-UI | Execute the detailed comparison scenarios above through production native recording, index, comparison APIs and existing selection/shared replay UI | LC12, LC13; related LC1, LC2, LC5, LC6, LC7, LC10 |
| E2E-LMU-RECORDING-POLICY | Execute the default-enabled/opt-out/session-boundary/settings-persistence scenario above through real Settings API/UI, native recording and export/import | LC14; related LC5, LC7, LC10, LC13 |
| E2E-LMU-COMPARE-REPLAY | Execute the shared-workspace recorded-pose/controller scenario above against the actual app/backend | LC12, LC13, LC7 |

Repeat Phase 1 scenarios in Phase 2 when relevant inputs change; reuse unchanged successful results only while their scope remains valid. Record exact fixture/source/game versions, commands and outcomes per phase. Controlled scenarios do not replace that phase's real simulator smoke. Unavailable endpoints/environments and unrun scenarios remain blockers, not passed evidence. The linked implementation plans record the executed controlled scope separately from final real-source acceptance.

## Ownership

Backend integration owner owns shared schema/catalog, validators, source inventory, companion format/index and generation rules. UI consumes typed data without inventing measurements. Contract changes update both linked plans before dependent implementation proceeds. Coordinate shared preservation strategy with #477; its ACC shared-memory/UDP transport design is not LMU's native/REST design.

## Recording-backed individual opponent sessions — 2026-10-22

User authorizes individual opponent session records and comparison using the supplied Windows multiplayer recording. This extends the earlier single-opponent selection scope without manufacturing numeric player sessions or duplicating captures. Reuse [UI plan](lmu-competitor-data-ui-plan.md) and [backend plan](lmu-competitor-data-backend-plan.md).

### Agreed boundary

Extend authenticated `GET /api/laps/:id/opponent-laps` with required `sessions: readonly OpponentSessionSummary[]`; preserve `laps`, retention, revision, validation and errors above. Each virtual record has `{ opponentSessionId: string, sessionKey: string, vehicleId: number, incarnation: number, driverName: string | null, carName: string | null, className: string | null, lapIds: readonly string[] }`. IDs are opaque deterministic hashes of source session generation, native vehicle ID and incarnation. `lapIds` reference exactly that record's entries in `laps`, in lap-number/opaque-ID order. Sessions sort by driver name, vehicle ID, incarnation, session key and ID. Duplicate names never merge; player is excluded. Empty/removed/not-recorded/unavailable catalogs return empty sessions. No new database rows, file copies, schema migration or mutation endpoints.

On desktop/mobile Sessions, expanding an LMU player session exposes individually labeled recorded opponent session records and each record's laps. Select an existing player lap from that session, then compare any eligible opponent lap through existing `/lmu/compare` search (`lapA`, `track`, `carA`, `reference=opponent`, `opponentLap`, `opponentRevision`). Keep partial/unknown/invalid warnings and disabled reasons; never choose a hidden best lap or use a rolling timing scalar as an invented lap. Non-LMU sessions do not fetch opponent catalogs. Access uses typed existing Hono RPC supplied through the sessions feature host.

Recorded evidence: source `packages/game-lmu/test/fixtures/laps/lmu-2026-10-22T21-59-41-929Z-f9c5a07c-aa24-42bb-a574-50784313fe93.bin` (local ignored original), 30,957 v3 native frames, 15 opponent identities, with native controls and scoring/motion populated. Derive a bounded committed sparse/gzip fixture from exact source frames; preserve source clocks, sequence gaps, identity and invalid states, record source/frame provenance. Never commit multi-GB originals, rewrite sequence continuity or enable unverified fuel/energy semantics. Existing supported comparison semantics remain unchanged.

### Acceptance and shared E2E scenarios

| ID | Observable acceptance | Real-system scenario |
| --- | --- | --- |
| OS1 | Compact fixture retains actual opponents, identity, changing source-backed motion/timing and original timestamps; decoded frame conservation verified. | OS-E1: derive from native dump, verify decoded hashes/provenance, import bounded fixture through real HTTP into isolated application data. |
| OS2 | Catalog outputs distinct stable records per generation/vehicle/incarnation, exact lap membership and no player or duplicate-name merge. | OS-E2: production HTTP import/catalog of real fixture; assert named opponents and lap membership, repeat IDs; existing controlled identity/departure fixtures cover generation/reuse/duplicate names. |
| OS3 | Desktop/mobile Sessions exposes individual opponent records, player-lap selection and eligible opponent-lap comparison with correct identity and revision. | OS-E3: existing seeded Playwright harness imports real fixture, expands session, chooses driver/lap, opens existing Compare, verifies matching selected identity, source-backed comparison/replay and reload. |
| OS4 | Partial/unknown/unavailable and removed/not-recorded data remain honest; no cross-driver/player attribution; ordinary player/non-LMU flows preserved. | OS-E4: real sampled fixture remains partial where sequences have gaps; controlled existing retention/stale-source/no-comparable tests and browser removal scenario preserve errors and player replay. |

Boundary handling: sampled gaps stay partial (OS1/OS4); mid-lap/end/disappearance never become complete (OS2/OS4); duplicate names/reused IDs/generation changes stay separate records (OS2); missing/corrupt/removed sources preserve player data and existing explicit reasons (OS4); no saved player lap means no comparison and no fabricated anchor (OS3/OS4); stale revisions retain existing conflict/reload behavior (OS3/OS4). Integration owner executes shared OS-E1–E4 after parallel implementation and records actual outcomes, not planned passes.

Real-fixture refinement (OS3/OS4, OS-E3/OS-E4): recorded scoring update counters can restart while the same identity's session clock and capture sequence advance. A counter is not a global replay ordinal. Preserve its provenance; publish a separate replay ordinal with a discontinuity at counter resets and missing capture ranges. Identical source observation keys deduplicate; repeated counter numbers with later original observation times are distinct observations. Backward/incomparable observation time at a counter reset remains invalid rather than joining unrelated data. E2E must request actual opponent semantic telemetry and verify shared replay loads without a source-sequence error, not only timing comparison.

### Executed individual-record verification

| Criteria / scenario | Executed proof | Outcome |
| --- | --- | --- |
| OS1 / OS-E1 | `bun packages/game-lmu/test/support/derive-opponents-fixture.ts`, followed by production HTTP imports in the existing seeded browser suite | Source SHA-256 matched; 330-frame stable tail and 51-frame full grid decoded identically after sparse encoding. Fixtures are 3,648,326 and 1,922,505 bytes; original dump unchanged. |
| OS2 / OS-E2 | `OS-E2 preserves all 15 recorded opponents as individual session records` | Real HTTP catalog and desktop Sessions rendered vehicle IDs 16, 17, 18, 20, 22, 24, 30, 32, 34, 35, 37, 47, 50, 51, 53 separately, with exact lap membership; player 54 excluded. |
| OS3/OS4 / OS-E3 | Desktop/mobile `OS-E3` real-recording cases | Imported player lap 3 and recorded opponent lap 9 compared through actual UI/API; exact source position/speed/capture timestamp, revision/URL reload and ready shared replay scene verified. Partial/unknown warnings remained visible; counter resets no longer rejected replay. |
| OS4 / OS-E4 | Existing controlled desktop/mobile browser cases plus `bun test packages/game-lmu/test/e2e/backend/integration/opponent-routes.test.ts --timeout 120000` | Original full keyboard/replay/export/reimport/stale-reference/removal workflows preserved. Final focused backend run: 16 passed, including duplicate-name generation/incarnation isolation, counter resets, repeated scoring observations, missing native captures, removed empty catalogs and preserved player replay. |

Full opponent browser file completed with **6 passed** (setup plus five scenarios), zero retries. After the final pending-capture-gap correction, reran the three recording-backed scenarios and setup with **4 passed**. Current equivalent command from `playwright/`: `E2E_SERVER_MODE=dev PW_SERVER_SET=seeded bunx playwright test ../packages/game-lmu/test/e2e/browser/compare/lmu-opponents.spec.ts --project=seeded-imports --grep OS-E --workers=1 --retries=0`, using isolated ports/data directories. These historical executions predate the ownership move; paths above reflect current locations. The original ordinary test ownership guard passed all 436 files exactly once.

Scoped Sessions UI/server, replay server, backend application and Playwright TypeScript checks passed. Sessions unit suite: 15 passed; changelog: 11 passed. Direct installed oxlint invocation, both feature boundary checks and all 16 locale key inventories passed. Native source samples remain evidence for this recording, not blanket multiplayer fuel/energy or continuous-coverage acceptance.

Limits: browser verification used the real development app, not a compiled release or repository-wide suite. Full client typecheck's last observed result is unrelated `TS6133` for unused `directory` in `server/session-capture/direct-recorder.ts:52`; that file was intentionally unchanged. Standard workspace lint launchers hit Bun `.bin` metadata errors, so the installed oxlint JavaScript entry was executed directly. No checks were weakened or errors filtered to obtain browser passes.

## Package-owned LMU tests, complete seed and live-ingress proof

The user requested all LMU-specific tests and fixtures in `packages/game-lmu`.
This is an ownership change, not a new UI/backend API boundary. Existing
comparison and retention contracts above remain authoritative.

The user approved a nested test workspace, `@raceiq/game-lmu-tests`, at
`packages/game-lmu/test`, with `unit/` and `e2e/` trees. Runtime SDK remains
`@raceiq/game-lmu`, with unchanged strict `game` boundary rules and no dependency
on its test workspace. Tests declare their app/client/feature dependencies.
Canonical test-support operations/types point directly to authoritative modules
in each package's `exports`; no UI/backend endpoint or payload changes.
SDK-owned public providers live in `src/test-support`; child fixtures remain
under `test/fixtures`. This is a clean ownership cutover, not a runtime shim.

| ID | Observable acceptance and edge handling | End-to-end verification |
| --- | --- | --- |
| PKG1 | LMU-only suites and standalone cases live under `packages/game-lmu/test/{unit,e2e}/`; generic multi-game suites and shared test support retain their original owners. No old-path shims or duplicate test copies. | Discover the relocated unit/integration/recording/browser suites through their real launchers; exercise both relocated cases and the remaining generic cases. |
| PKG2 | LMU recording fixtures and derivation support are package-owned. Moves preserve bytes, clocks, sequences and unknown/partial states. Raw originals stay ignored; each committed recording part is strictly below 100,000,000 bytes. | Same-volume rename preserves inode/device/size; reassembly plus streamed gzip verification matches the full original hash, byte count and 30,957-frame header. |
| PKG3 | Every ordinary test is assigned once; caches include relocated fixtures and external support. Moved backend integrations keep application initialization; browser suites retain CommonJS fixture loading and the single-worker `seeded-imports` project. | Ownership guard, package launchers, scoped TypeScript checks and actual isolated browser execution; no mock production fallback. |
| PKG4 | Default LMU seed imports all 11 parts once, streams native frames, retains player/opponent partitioning for native v2/v3 and preserves compact v1/explicit legacy storage. Repeated seed remains a no-op. Partial data never becomes a valid or fabricated lap; auxiliary-only captures need not already have per-lap publication metadata. | Real seed CLI in disposable directories; full recording import and repeat-run row equality; physical primary/companion inspection; real HTTP opponent catalog. Explicit legacy and compact fixtures exercise the alternate storage paths. |
| PKG5 | Unchanged real native input enters the live parser and `processPacket`, not merely import indexing. Physical primary excludes opponents, companion restores every native byte/timestamp and all 15 non-player identities. Hardware acquisition is not inferred from file replay. | `e2e/backend/session-capture/opponent-recording-policy.test.ts` replays 51 exact recorded grid frames through production parser, live pipeline, recorder and joined source loader. |
| PKG6 | Nested workspace owns cross-layer dependencies; strict SDK and test-workspace boundary checks pass without ignores. Existing SDK test commands select child owner once. Default test roots stay `<workspace>/test`; explicit `raceiq.testRoot: "."` selects child root, while parent `raceiq.testOwner: false` prevents duplicate ownership. Roots and manifest entries cannot escape their workspace/test tree. | PKG-E6: run actual SDK unit/integration/recording commands and ownership guard; run both boundary filters and Turbo dry-run. Existing owner-runner E2E covers flat/nested CLI dispatch, real SQLite preload, separate temporary data and preserved inherited-data sentinel. Shard regressions reject root/manifest traversal. |
| PKG7 | Actual unit cases use `unit/`; existing integration cases use `e2e/backend/`, recording E2Es use `e2e/recordings/`, browser specs use `e2e/browser/`. Existing suite classifications, application preload and browser CommonJS scope remain unchanged. Fixtures and source hashes remain unchanged. | PKG-E7: actual Bun launchers plus existing serialized browser project discover relocated cases, read fixtures from child `fixtures/`, and exercise production parser/storage/API/UI. Source/test/browser type checks supplement these runs. |

Executed before nested-workspace restructuring (fixture bytes and seed paths unchanged):

- Ownership guard: all 454 ordinary files assigned exactly once.
- Unit package launcher: 9 passed across 6 files.
- Integration package launcher: 113 passed; one test cannot create its required
  Windows file symlink (`EPERM`). The symlink safety assertion remains intact;
  no skip or weaker replacement was added.
- Native recording E2E: 12 scenarios passed under repository Bun 1.4.3, then the
  targeted historical-migration scenario passed all five assertions and cleanup
  after finalizing GC-owned native handles. Bun 1.4.4 failed the pinned
  historical release's frozen-lockfile install, so that upgrade proof uses the
  repository-declared 1.4.3 runtime.
- Actual isolated development UI: 10 passed, zero retries (startup setup plus
  nine relocated LMU scenarios), including recorded desktop/mobile comparison,
  all 15 opponent records, recording preference persistence, opponent removal,
  car filtering and track-outline placement.
- Game source/test, Playwright, backend and tooling-data TypeScript scopes passed.
- Full seed: 30,957 packets, 15 source generations, 17 invalid/incomplete laps;
  repeat invocation left session/lap rows unchanged. Normal startup removed
  one empty generation, leaving 14 capture-backed sessions. Real
  `GET /api/laps/1/opponent-laps` returned HTTP 200 and all 15 opponent IDs,
  excluding player 54.
- CLI storage branches: native direct and explicit legacy modes each restored
  all 51 original grid frames with matching decoded hashes; physical direct
  primary frames were schema v5 with no opponents and a complete separate
  companion. Compact v1 seed restored 4,309 packets and three laps, one valid.

An obsolete private-method interception test and a duplicated backfill case
were removed instead of re-pinning implementation details. Live recording,
retention failure, source conservation and backfill behavior retain direct
consumer-visible assertions.

### Nested workspace execution

PKG-E6/PKG-E7 now exercise the approved child workspace and final paths.
The workspace-root edge includes a real dependency `node_modules/**/test/*.test.ts`:
ownership discovery failed before excluding dependency tests, then passed with
only the child-owned case assigned. Flat/nested CLI fixtures also write real
SQLite data, preserve inherited-data sentinels and remove their temporary data.
Configured-root and manifest traversal remain rejected.

| Verification | Observed result |
| --- | --- |
| Ordinary ownership | 454 files assigned exactly once; suite classifications preserved. |
| Existing SDK unit launcher | 9 passed across 6 files. |
| Existing SDK integration launcher | 113 passed across 28 files, including real 51-frame live-ingress primary/companion conservation. One preserved file-symlink safety case fails at Windows `symlinkSync` with `EPERM`, before its safety assertions. |
| Child recording E2E launcher, repository Bun 1.4.3 | 13 passed across all 5 files, including historical release migration and managed shutdown cleanup. |
| Serialized production UI/backend browser project | 10 passed, zero retries, 3.7 minutes. Recorded desktop/mobile comparison, all 15 opponents, controlled keyboard/German-language workflows, removal, preference, cars and tracks all exercised. Current controlled and real-recording screenshots inspected. |
| Owner discovery/CLI regressions | 15 passed across 2 files, including flat/nested isolation, dependency exclusion and traversal rejection. |
| Retained generic archive owner | 20 passed; mixed-game import/export behavior remains with its original owner. |
| Strict SDK and child Turbo boundaries | 55 files in 2 packages; no findings or boundary ignores. |
| Scoped types and lint | SDK source 249 files; child tests 718; browser 232; backend 1,015; tooling-data 343; control plane 55. All checked scopes passed; changed-source oxlint passed. |
| Frozen workspace installation | Repository Bun 1.4.3 checked 1,128 installs across 1,436 packages with no changes. |
| Turbo routing dry-runs | Default selection schedules the child unit task once; explicit SDK selection schedules its forwarding unit task once. Non-test options-first dispatch retains SDK typechecking; no dependency cycle. |

The Windows symlink assertion was not skipped or weakened. Full green
integration evidence for that case requires file-symlink permission unavailable
in this environment. No OS permission or policy setting was changed.
PKG2/PKG4 full-source integrity, streaming seed, idempotency and storage-branch
evidence above remains applicable: nested workspace setup did not change fixture
bytes, fixture locations, seed registration or seed implementation.

### Windows opponent-removal fixture follow-up

At user request, removed the file-symlink fixture and its assertions from
`opponent-removal.test.ts`; the earlier symlink limitation above is historical.
The case still verifies shared player bytes survive while referenced, cleanup
remains pending, and removing the final reference permits deletion and idempotent
recovery with an empty pending list. Production symlink guards are unchanged;
this case no longer covers companion symlinks.

Unelevated Windows verification with Bun 1.4.4:
`bun scripts/test/run-suite.ts integration --package @raceiq/game-lmu-tests`
passed all 114 tests across 28 files, with 2,676 assertions and zero failures.

Commit-gate follow-up restored the required iRacing diagnostic inputs and removed
an unused direct-recorder field. Native SQLite test teardown now explicitly
retries Windows `EBUSY` with a bounded delay because Bun 1.4.4 did not honor the
`fs.rm` retry options on this path. Errors still propagate after the retry limit;
all 374 backend unit tests passed with 1,236 assertions.

