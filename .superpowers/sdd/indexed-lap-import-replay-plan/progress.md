# SDD ledger — plan: local://indexed-lap-import-replay-plan.md

## Re-evaluation against requested base

Base: `Snazzie/memory-leak-when-running-f1-25-time-trial-sessio` at `3c6a267f`.

| Plan area | Existing base state | Revised scope |
|---|---|---|
| Equality tests/counters | AC Evo batch, BIN/GZ, semantic, F1 recording, and batching regressions exist; no full import oracle or materialization counters found | Add missing deep equality/oracle tests and instrumentation; preserve existing tests |
| LapIndexPacket/hooks | `ServerGameAdapter` still exposes only full `tryParse`; no `LapIndexPacket` or index hooks found | Implement contract and all canonical adapters |
| Import metadata pass | `importSessionFrames` still calls `tryParse` then `processPacket`; reconciliation remains full | Replace only canonical BIN frame import path with index projection/pipeline; retain reconciliation full decode for provenance hash |
| Source index/replay warm-up | Base has streaming replay and bounded memory, but still scans prefix with full `tryParse`; loader has decompressed capture cache but no ordered capture index/offset lookup | Add cached frame index and state-only prefix priming; keep current streaming, limits, errors, and fallbacks |
| Analyse | Semantic route still calls `getLapById`, then performs a second semantic replay load; no `getLapMetaById` split | Implement metadata/full-load split and reuse loaded packets/source |
| Compare | All four handlers already use `loadComparisonLaps` → `getLapsByIds([id1,id2])`, with optional parallel session decodes | Do not duplicate batching; add required route regression coverage and preserve existing behavior. Base comparison still independently calls semantic replay twice; adapt to reuse loaded packets if compatible |
| Benchmarks | Existing replay benchmark covers one AC Evo path; no required import/late-F1/same-session/cross-session acceptance instrumentation found | Extend existing harnesses only with plan cases and output preflight hashes |

### Revised execution order

1. Tests and counters first, including tests for already-landed batching behavior.
2. Typed index contract and adapter hooks.
3. Import index pipeline.
4. Cached source index and state-only replay warm-up, integrating current streaming implementation.
5. Analyse metadata reuse and only missing Compare semantic reuse.
6. Benchmark extensions and full verification.

Ruling: Treat existing memory-leak/replay commits as prerequisite implementation, not work to replace — they already solve bounded buffering and partial batching; replacing them would risk regressions and duplicate logic. Cost if wrong: hidden incompatibility between the new index path and existing streaming behavior.

## Implementation result

Completed: LapIndexPacket projection contract; adapter hooks for FM/F1/ACC/AC Evo/iRacing; true F1 state-only priming; canonical import routing through index packets and `processLapIndexPacket`; decompressed capture frame index; indexed buffered replay warm-up; metadata-only `getLapMetaById`; Analyse semantic replay reuse; Compare batching regression coverage; deep AC Evo and F1 packet parity tests.

Verified: `bun run typecheck`; focused replay/source/batching/semantic/Analyse suites (18 tests pass, 81 assertions); F1 contract/indexed replay suites (5 pass, 19 assertions); route/DB batching suites (4 pass, 16 assertions); replay I/O benchmark completed with output preflight.

Remaining known gaps: no full canonical import oracle test file; no production parser materialization counters/benchmark extensions; batched streaming replay still uses iterator rather than shared cached frame index; non-F1 adapter index hooks use parity-safe full-parse projection fallback. Full shard suite not run.
