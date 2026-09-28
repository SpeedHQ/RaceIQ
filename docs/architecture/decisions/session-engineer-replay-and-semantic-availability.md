# Session Engineer Replay and Semantic Availability

- Status: Accepted
- Date: 2026-03-31

## Context

RaceIQ needs a development debugger that replays persisted sessions through current semantic projection, CrewChief triggers, opponent pace, spotter, runtime selection, rendering, and voice-line recipes. Lap selection must not change stateful evaluation. Registered games must remain loadable even when production voice support is unavailable.

## Decision

Use one full-session replay path. `runLiveEngineerSessionReplay` evaluates packets in persisted order with fresh projector, trigger catalog, availability gate, and voice engine instances. Client lap filters are presentation-only. Production projector/catalog/engine code is reused; unsupported-game projection is enabled only by explicit debugger options and never changes release gates.

Every system reports implementation status separately from runtime lifecycle. Required values must be projected, `state === ok`, fresh, shape-valid, and array-aligned (maximum 64 entries). Missing, stale, unknown-freshness, invalid, not-applicable, resolver-error, wrong-shape, and misaligned dependencies fail closed. Ready loss resets state. Recovery baselines current values and emits no historical transition; next valid observation may emit. Occupancy is unknown, never clear. Pace continuity is invalidated by missing required evidence.

Replay returns stable frame/annotation IDs, source sequence, raw timestamps only when captured, monotonic timeline milliseconds, lap spans, dependency evidence, transitions, rendered text, and segment IDs. ACC captures with a valid ACCB clock for every player frame use captured Unix-ms receive timestamps and relative elapsed replay time. Legacy or mixed-clock ACC captures and AC Evo use nominal 100 Hz replay; parser wall clock is never presented as a captured clock. UDP/iRacing session time is retained where trustworthy.

ACC capture evidence is typed as `opponentSourceCapture` (`captured`, `unavailable`, or `malformed`, with valid record count). Frame-level `opponentSource` is independent: an instrumented recording can contain unavailable, stale, or malformed intervals. Replay retains each value's resolver state and freshness and evaluates historical availability against that frame's values, never the resolver's reused current-frame buffer. A malformed interval does not permanently disable a later complete source recovery.

Completed-lap and opponent-pace speech may form one chained voice line when session, timeline epoch, and completed player lap number match. Lap number is the correlation key because the trigger and pace decision can be selected on different source sequences. The chained recipe emits the lap-time clips once, inserts a 300 ms phrase-boundary pause, then emits the pace continuation without a second `lap.lead.your-lap-was`; standalone lap-time and pace lines keep their complete recipes.

Engineer Replay reconstructs the resulting playback schedule from voice-line annotations and the packaged audio manifest. Its audio lane is a moving, session-bounded 10-second window. Each catalog asset is an independent duration-scaled block with its decoded waveform; the 250 ms playback lead and explicit phrase pause are separate, duration-scaled blocks. Clips are never collapsed into one visual group. The replay lane is diagnostic projection only: it does not alter persisted annotations, runtime selection, browser queue order, or production playback timing.

## Persisted source matrix

| Game | Persisted limitations | Debugger behavior |
| --- | --- | --- |
| fm-2023 | Player-only Car Dash fields; no complete class/index, session-state, validity, competitor, or occupancy evidence. | Timeline/map and mapped player-only CrewChief systems remain useful; opponent pace and spotter are unavailable. |
| f1-2025 | UDP state can rebuild retained packets, but sparse prefix, canonical player links, competitor validity/class, coordinates, and spotter branch may be absent. | Only fully mapped ready systems run; no speculative mappings. |
| acc | ACCB v1 retains raw Broadcast datagrams/lifecycle and per-frame receive clocks alongside unchanged ACCP pages. Old ACCP/ACCTEST files have no Broadcast evidence; mixed-clock captures cannot claim a complete captured clock. | Diagnostic reconstruction and source parity are fixture-tested; pace/spotter require complete fresh source evidence. Accepted persisted-replay support remains unavailable pending native ACC capture/audio acceptance. Legacy recordings retain player telemetry and nominal 100 Hz replay. |
| ac-evo | ACEP retains player fields and feature-specific race/timing evidence, but no complete opponent feed or native occupancy; inherited ACC Broadcast mappings are excluded and placeholders are not fresh values. | Only mapped ready player systems run; pace/spotter unavailable; nominal 100 Hz replay. |
| iracing | v3 IRIQ retains SDK deltas and SessionInfo/YAML; v2 lacks YAML roster; IBT has initial snapshot only; world coordinates are not stable. | Native spotter requires captured `CarLeftRight`; YAML/opponent systems fail closed when absent; pace uses track-location evidence only. |

## Consequences

No per-lap server evaluation, synthetic semantics, default zeros, broad game capability, partial execution, duplicate Spotter producer, release-flag widening, or raw-path/native-packet exposure. Adapter, capture, or semantic changes must update this matrix and focused availability fixtures in the same change.
