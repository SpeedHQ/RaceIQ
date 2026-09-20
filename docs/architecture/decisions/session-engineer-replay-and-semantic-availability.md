# Session Engineer Replay and Semantic Availability

- Status: Accepted
- Date: 2026-03-31

## Context

RaceIQ needs a development debugger that replays persisted sessions through current semantic projection, CrewChief triggers, opponent pace, spotter, runtime selection, rendering, and voice-line recipes. Lap selection must not change stateful evaluation. Registered games must remain loadable even when production voice support is unavailable.

## Decision

Use one full-session replay path. `runLiveEngineerSessionReplay` evaluates packets in persisted order with fresh projector, trigger catalog, availability gate, and voice engine instances. Client lap filters are presentation-only. Production projector/catalog/engine code is reused; unsupported-game projection is enabled only by explicit debugger options and never changes release gates.

Every system reports implementation status separately from runtime lifecycle. Required values must be projected, `state === ok`, fresh, shape-valid, and array-aligned (maximum 64 entries). Missing, stale, unknown-freshness, invalid, not-applicable, resolver-error, wrong-shape, and misaligned dependencies fail closed. Ready loss resets state. Recovery baselines current values and emits no historical transition; next valid observation may emit. Occupancy is unknown, never clear. Pace continuity is invalidated by missing required evidence.

Replay returns stable frame/annotation IDs, source sequence, raw timestamps only when captured, monotonic timeline milliseconds, lap spans, dependency evidence, transitions, rendered text, and segment IDs. ACC and AC Evo use nominal 100 Hz order and label source clock as unavailable. UDP/iRacing session time is retained where trustworthy.

## Persisted source matrix

| Game | Persisted limitations | Debugger behavior |
| --- | --- | --- |
| fm-2023 | Player-only Car Dash fields; no class/index, session state, validity, competitors, occupancy, or CrewChief adapter. | Timeline/map remain useful; CrewChief, pace, and spotter unavailable. |
| f1-2025 | UDP state can rebuild retained packets, but sparse prefix, canonical player links, competitor validity/class, coordinates, and spotter branch may be absent. | Only fully mapped ready systems run; no speculative mappings. |
| acc | ACCP shared-memory capture excludes Broadcast UDP identity/opponent data; parser wall clock is not capture time. | Persisted pace/spotter unavailable; nominal 100 Hz replay. |
| ac-evo | ACEP player fields only; no trustworthy opponent feed or stable session/occupancy; inherited ACC broadcast mappings are excluded; placeholders are not fresh values. | Player-only ready systems run; pace/spotter/session systems unavailable; nominal 100 Hz replay. |
| iracing | v3 IRIQ retains SDK deltas and SessionInfo/YAML; v2 lacks YAML roster; IBT has initial snapshot only; world coordinates are not stable. | Native spotter requires captured `CarLeftRight`; YAML/opponent systems fail closed when absent; pace uses track-location evidence only. |

## Consequences

No per-lap server evaluation, synthetic semantics, default zeros, broad game capability, partial execution, duplicate Spotter producer, release-flag widening, or raw-path/native-packet exposure. Adapter, capture, or semantic changes must update this matrix and focused availability fixtures in the same change.
