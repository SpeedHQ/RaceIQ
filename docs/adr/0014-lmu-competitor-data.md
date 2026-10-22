---
status: proposed
---
# LMU competitor data and independent enrichment

Plan: [LMU competitor and supplementary telemetry contract](../plans/lmu-competitor-data-contract.md)

## Context

LMU support already reads native shared memory and exposes player-focused data. Competitor scoring, existing energy channels, supplementary REST values, lifecycle invalidation, and historical preservation remain incomplete. Issue #478 requires competitor joins by native `mID` and evidence-based source coverage. It does not require UDP for LMU competitor data; energy is already present in the native extension. Separate ACC issue #477's shared-memory-plus-UDP design must not be conflated with LMU acquisition.

## Proposed decision

Deliver in two phases. **Phase 1** closes player energy/native projection gaps, verified player/session REST, lifecycle and player historical retention using the existing capture path; no competitor collections or companion BIN are required. **Phase 2** starts after Phase 1's acceptance gates and adds multiplayer opponent extraction/UI plus the versioned primary/companion partition described below. Backend/UI can proceed in parallel within each phase against that phase's finalized shared definitions. Existing raw v2 opponent bytes remain preserved during Phase 1; reducing opponent duplication is a Phase 2 outcome, not a Phase 1 claim.

Use LMU shared memory for scoring and runtime-verified per-vehicle channels. Join by `mID` within session generation and vehicle incarnation because multiplayer IDs can be reused. No player-to-opponent physics copying or fuel-ratio fallback. Use existing resolver provenance/freshness/state contracts and an explicit typed live context. Run verified REST enrichment independently, preserving applicability/acquisition time and rejecting old-generation responses. Partition new source captures into player/session primary BIN and one competitor companion BIN per session; existing full-memory v2 already contains opponents, so adding a companion alone would duplicate data. Preserve required source bytes exactly once across versioned streams and retain old v2 readers. Shared coherent capture keys associate records using stable frame time and capture sequence; retain separate scoring/physics/REST observation times rather than claiming simultaneous measurement. Replay/export/import and cleanup follow indexed, verified ownership. UDP remains independent and is not an LMU competitor fallback.

## Rationale and consequences

TinyPedal source audit on 2026-10-20 supplies immutable references and endpoint/field limitations in the linked contract, not live LMU validation. It exposes reusable IDs, remote pit inaccuracies, fuel-or-battery scoring fraction, restricted opponent telemetry and independent scoring timing. Versioned partition prevents primary-file growth from competitor duplication; one companion avoids per-car file proliferation. Source-mode availability, physical units, coherent snapshot verification, format compatibility, publication/recovery and actual Windows/game behavior remain implementation gates. This ADR remains proposed and claims no implemented or runtime-verified behavior.
