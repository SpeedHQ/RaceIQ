---
status: proposed
---
# LMU competitor data and independent enrichment


## Context

LMU support already reads native shared memory and exposes player-focused data. Competitor scoring, existing energy channels, supplementary REST values, lifecycle invalidation, and historical preservation remain incomplete. Issue #478 requires competitor joins by native `mID` and evidence-based source coverage. It does not require UDP for LMU competitor data; energy is already present in the native extension. Separate ACC issue #477's shared-memory-plus-UDP design must not be conflated with LMU acquisition.

## Proposed decision

Deliver in two phases: player gaps first, then opponent extraction/UI and versioned primary/companion partition. On 2026-10-22 the user authorized Phase 2 implementation with controlled fixtures and moved fresh Windows LMU recording tests after implementation. Real-source evidence remains mandatory for final acceptance, not a coding prerequisite. Backend/UI proceed independently against finalized shared definitions. Preserve existing Phase 1 player behavior and legacy reads.

Use LMU shared memory for scoring and runtime-verified per-vehicle channels. Join by `mID` within session generation and vehicle incarnation because multiplayer IDs can be reused. No player-to-opponent physics copying or fuel-ratio fallback. Use existing resolver provenance/freshness/state contracts and an explicit typed live context. Run verified REST enrichment independently, preserving applicability/acquisition time and rejecting old-generation responses. Partition new source captures into player/session primary BIN and one competitor companion BIN per session; existing full-memory v2 already contains opponents, so adding a companion alone would duplicate data. Preserve required source bytes exactly once across versioned streams and retain old v2 readers. Shared coherent capture keys associate records using stable frame time and capture sequence; retain separate scoring/physics/REST observation times rather than claiming simultaneous measurement. Replay/export/import and cleanup follow indexed, verified ownership. UDP remains independent and is not an LMU competitor fallback.

Phase 2 makes opponent retention optional: manual whole-session removal deletes new companions without rewriting primary player bytes; existing native v2/v3 requires a staged validated player-preserving rewrite. Persist removed separately from missing/corrupt, publish before safe unlink, recover pending cleanup, protect shared/read references and report actual reclaimed bytes. Add persisted `recordLmuOpponents`, **default true**, including older settings missing the field. Explicit false snapshots at the next recording session, keeps live opponents/player recording and writes no opponent payload/index/cache; mark history/export/import not-recorded. Existing retained recordings/imports remain unchanged. Conservation excludes intentionally omitted opponent data only after explicit opt-out/removal. No automatic deletion or per-car pruning.

Reuse the existing comparison selection UI and shared `@raceiq/lap-replay` workspace from `Snazzie/replay` baseline `7faddf9c4`; no parallel picker/replay redesign. Let users retain player lap A and choose a recorded opponent identity/incarnation/lap as reference B. Extend typed source/host contracts instead of impersonating numeric player laps. The native contract makes timing comparison feasible and includes scoring position/velocity/orientation for potentially coarse paired replay; full remote throttle/brake/steering is not established by ABI field presence. Enable each channel only after version/mode verification. Preserve coverage/validity/capabilities, explicit stale/removed/not-recorded states and full selected-interval export; removal drops opponent indexes/caches. Shared contract and separate plans own API details, source evidence and joint E2E gates; no AI or cross-session opponent browsing.

Baseline ownership and preserved runtime behavior follow the implemented [replay contract](../../packages/lap-replay/contracts/README.md). Native-field feasibility and Windows multiplayer acceptance remain separate from this proposed decision.

## Rationale and consequences

TinyPedal source audit on 2026-10-20 supplies immutable references and endpoint/field limitations in the linked contract, not live LMU validation. It exposes reusable IDs, remote pit inaccuracies, fuel-or-battery scoring fraction, restricted opponent telemetry and independent scoring timing. Versioned partition prevents primary-file growth from competitor duplication; one companion avoids per-car file proliferation. Source-mode availability, physical units, coherent snapshot verification, format compatibility, publication/recovery and actual Windows/game behavior remain implementation gates. This ADR remains proposed and claims no implemented or runtime-verified behavior.
