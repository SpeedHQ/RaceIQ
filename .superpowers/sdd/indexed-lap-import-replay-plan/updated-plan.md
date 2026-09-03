# Indexed lap import/replay — global optimization plan

Base: `Snazzie/memory-leak-when-running-f1-25-time-trial-sessio` (`3c6a267f`).

## Non-negotiable scope

Optimization applies to every canonical `.bin`/`.bin.gz` game: FM, F1, ACC, AC Evo, and iRacing. Both import metadata scans and lap seeking/prefix warm-up must avoid full `TelemetryPacket` construction. A parity-safe full-parser fallback is not acceptable for any canonical adapter. MoTeC packet-backed sources remain unchanged.

## Work

1. Keep `LapIndexPacket` detector projection and `ServerGameAdapter` hooks.
2. Implement true lightweight state mutation/index projections for FM, ACC, AC Evo, and iRacing, reusing decoder primitives and preserving exact detector fields. F1 already has state-only priming; retain it.
3. Ensure canonical import calls only index parsing plus `processLapIndexPacket`; full packets remain limited to requested replay ranges and existing reconciliation provenance pass.
4. Ensure buffered and batched seek paths use cached frame indexes and state-only priming for every stateful adapter; stateless adapters jump directly to target ranges.
5. Make counters prove zero full packet materialization during import scans and prefix warm-up for every canonical game; parity oracle covers all available fixtures.
6. Benchmark all five games for full import scan, late-lap seek, same-session pair, and cross-session pair; validate hashes/counts before timing.

## Verification

Run focused parity/import/replay/semantic/Compare tests, typecheck, shard coverage, and existing replay I/O benchmark. Do not claim global improvement until every canonical adapter reports zero full packet materialization in scan/prefix phases.
