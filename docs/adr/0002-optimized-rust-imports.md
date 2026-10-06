# Separate detector data from presentation telemetry in Rust imports

Status: proposed

Plan: [Optimize Rust telemetry imports](../plans/optimized-rust-imports.md).

## Problem

Release-worker profiling attributes F1 import costs to allocating and destroying dynamic JSON telemetry trees, LMU costs to repeated allocating catalog scans, and Kunos costs to deep copying packet/lap trees. Native binary decoding is not the main F1 cost.

## Decision

Use typed detector-facing data and compact retained samples where production imports do not need presentation telemetry. Preserve full live telemetry construction for its actual consumers. Resolve static metadata through indexed lookup with unchanged ambiguity rules and cache identity until inputs change. Borrow existing packets and move owned packets instead of cloning whole JSON trees; preserve boundary append packets and exact source recipes.

## Rationale and alternatives

This removes demonstrated work without changing accepted source cadence or public results. Compiler tuning, parallelism, and swapping JSON map implementations leave redundant work in place. Dropping fields from live output or discarding source samples changes contracts and is rejected. A benchmark-only fast path would misrepresent production performance and is rejected.

## Consequences

Detector/import dispatch gains an explicit compact-data contract; full telemetry remains necessary for live/replay presentation. Metadata indexes preserve resolver tier precedence and ambiguity. Verification compares ordered events, offsets, recipes, validity and identities, not only lap counts. Release-worker measurements and complete six-fixture before/after result hashes passed; canonical F1 typed/full equivalence and production replay/import contracts also passed. Existing Kunos boundary sample cadence is preserved with scalar samples rather than duplicated JSON trees. Measurements and verification commands are documented in the linked plan and recorder benchmark README; cross-engine timings do not imply identical persistence work or lap-result schemas.

Further optimization follows measured remaining production hotspots under the same complete-result invariants. Memory comparisons use matching isolated-process RSS boundaries and show absolute and relative differences; historical engine-specific RSS estimates are not treated as equivalent measurements. Separate memory runs avoid distorting throughput trials.

Extend the typed detector contract to Kunos and iRacing. Dynamic JSON belongs at presentation/event boundaries, not in steady-state detection. Retain compact typed samples through iRacing's delayed authoritative timing and materialize exact full Kunos append packets only at actual lap boundaries. Full-packet adapters reuse the same policy transitions. Decoder/import ownership should borrow or reuse source storage and avoid duplicated event/lap trees where output contracts permit. This addresses profiled dominant map/allocation work; preserving incidental full-packet dependence indefinitely would leave that work in place.
