# Isolate Bun/Rust parsing and packet processing

Status: proposed

Plan: [Matched pipeline-stage benchmark](../plans/pipeline-stage-benchmark.md).

## Context

The original Bun microbenchmark separates parsing from pre-parsed packet processing with null I/O adapters. Whole-capture Rust imports additionally time decompression/framing; production UDP recording adds pacing, queue pressure, persistence and shutdown. Neither reproduces those boundaries.

## Decision

Add a dedicated paired stage runner using identical decoded fixture records. Time production full-presentation parsing separately from pre-parsed packet processing. Prepare state outside timers, bound processing chunks equally, and run optimized Rust. Exclude I/O and IPC from timing. Keep existing benchmarks intact.

## Consequences

This answers stage processing capacity rather than recording or disk-import performance. Bun LiveTelemetryPipeline includes normalization/orchestration and null-adapter callback work; Rust Detector reference ingress includes detector/event work. Report that architectural difference rather than implying identical full pipelines. Compact detector-facing parsing is a different workload and is not silently substituted for full-presentation parsing. Fixture prefixes and synthetic chunk flushes are disclosed, and differing accepted packet counts prevent unqualified speedup claims.

Memory runs measure separate code-only parse/processing allocation windows in fresh processes after fixture loading or pre-parsed input preparation. Include state construction and stage work, but exclude transport, loaded fixture inputs and report serialization. Rust uses feature-gated release allocator accounting for peak additional live requested bytes; normal production and throughput binaries remain uninstrumented. Bun uses post-GC live-heap baselines and bounded frame/chunk boundary collections, explicitly a sampled estimate that misses temporary allocations between samples. Runtime probes showed ordinary Bun heap counters stale between collections, so they cannot support a transient peak claim. Report methods separately; replace RSS schema/labels instead of subtracting whole-process RSS and calling it allocation memory. This sacrifices whole-process footprint reporting to answer the requested stage-memory scope. A diagnostic full-versus-compact parse probe remains separate from the full-presentation workload.

Use state-only end-of-stage retained growth as the headline memory comparison. Release transient parse outputs before retention measurement while keeping parser/detector/pipeline state alive. Separate Rust allocation peaks from Bun sampled post-GC maxima: they cannot establish a like-for-like transient memory comparison. Retained figures still use different allocator/runtime accounting and processing scopes; report those limits without speedup or memory-ratio claims.

Completed benchmark chunks must not accumulate detector/pipeline state. Release finished chunk state before processing the next chunk, keeping only final chunk state at the retained-memory boundary. Keep fresh trial state and existing preparation/construction timing exclusions. This measures bounded working state rather than artificial retention of every finished chunk; version the memory method because historical figures used a different lifecycle.
