# Reusable lap processor package ownership

ADR: [Decision record](../adr/0010-reusable-lap-processor.md)

## Approved expanded scope

This approved plan supersedes the narrower capture-format relocation above. Extract shared sparse-capture parsing/indexing, lap/sector timing, and concrete detectors into backend-free reusable package ownership: `@raceiq/telemetry-core` owns portable algorithms/contracts; `@raceiq/telemetry-processor` owns batch orchestration and explicit game-parser routing. RaceIQ live/import/replay and standalone Bun batch consumers reuse one implementation. Game parsers remain game-owned; backend, filesystem, DB, HTTP, AI, native acquisition, and cloud service policy remain host-owned. The dependency direction must remain acyclic: processor may depend on telemetry-core and game parser packages; those packages and backend-core must not depend on processor.

## Phases

1. **Contracts, routing, codecs, sectors, metadata, timing.** Define backend-free parser/processing contracts preserving game parser signatures, opaque per-game state, binding, compact projections, context priming, segment resets, sparse checkpoint reconstruction, and `frame-time.ts` behavior. Route once per lifecycle by explicit `gameId` for ACC, AC Evo, FM, F1, iRacing, and LMU. Expose in-memory native dump decoders without moving file opening, decompression boundaries, bounds, streaming, chunking, sinks, or storage. Move existing sector computation unchanged, including sample guard, native layouts/nulls, LMU cumulative splits, F1 precedence, ACC timing, late-fragment rejection, distance fallback/retry, and current geometry resolution precedence. Package runtime-safe authoritative sector/track metadata and support host geometry override; preserve ordinal fallback behavior and identity-scoped dynamic iRacing/LMU mappings. Supply explicit clock inputs where Kunos parsers currently use `Date.now`; preserve recorded UTC separately from simulator time.
2. **Detectors and RaceIQ integration.** Keep portable ordinal, Kunos, and iRacing detector engines, policies, boundaries, and sector computation in `@raceiq/telemetry-core`; migrate every server/game consumer to that lower-level package. `@raceiq/telemetry-processor` composes those algorithms with game-owned parser routing for batch callers. Separate processor-local session/lap keys from DB IDs; results carry game/source, lap/time, sectors/null, validity/reason/classification, byte offset/frame count. Keep live pipeline acquisition, normalization, recorder, offsets, notifications, policy and host followups. Preserve async/effect ordering, state-commit points, callback/error behavior, FM single-flight provisional snapshots and retention rules, iRacing deferred authoritative timing, LMU fallback/outlap rules, Kunos thresholds, bounded histories and capture bookkeeping. Import/replay retain persistence, rollback, ownership/version identity, lazy range loading, sparse seek/priming and cache.
3. **Batch API and verification.** Export complete-payload processing by `gameId`, shared parser/context/detector path, explicit EOF finalization, computed results before persistence, no fake DB adapters or live wait. Stream frames/use compact samples where sufficient; no assumption of one valid lap per upload.

## Invariants and acceptance

No cloud service, upload format, sidecar/index, standalone recorder, new lap-time policy, global mutable processor state, filesystem/runtime bootstrap, or custom sector resolver requirement for ordinary payloads. Host owns I/O and persistence. Preserve packet references, buffers, compact projections, hot loops, async sites, and lazy replay; no extra packet clone, per-frame event objects, second decode/normalization pass, or full-session decode for one selected lap.

Capture six-game packet/frame/offset/timestamp digests and lap tuples (sectors/null, classifications, session boundaries, offsets/counts) before edits. Preserve existing PR #435 fixes and user edits, including `apps/backend/test/lap-analysis/lap-export-import-roundtrip.test.ts`. Existing uninitialized-notifier failures are ground truth; do not rerun solely to confirm or suppress. Require all six fixtures, including LMU; skips are not parity.

Exercise import, compact index, sparse/chunked source-loader, selected-lap export/import and replay; provisional transitions, boundary error/commit ordering, context/segment reset, EOF, and independent-instance isolation. Compare portable sector resolution against RaceIQ for catalog/geometry cases and override precedence; prove generated-data freshness. Build/run independent Bun consumer with runtime import guard excluding server/backend/filesystem/runtime loaders/DB/HTTP/AI/acquisition; process fresh extracted-lap bytes with gameId and packaged metadata only, comparing all result fields and native/distance sectors plus missing/unknown metadata.

After each completed phase, run changed-surface checks; after implementation run workspace typechecks and `test:unit`, `test:integration`, `test:e2e:recordings` once. Benchmark matched before/after same-machine Bun/fixtures/settings: live throughput/CPU/allocation, full import/index duration/peak memory, early/late replay latency/priming/memory, sparse decode/record throughput/output size. No measurable regression beyond noise; fix regressions before cutover. Document full output in evidence, not checkpoint. This plan and proposed ADR link reciprocally.

ADR: [Decision record](../adr/0010-reusable-lap-processor.md)

## PR #435 review fixes

- Use GPT 6 Luna workers for both fixes. Preserve extraction/runtime invariants above.
- Adapt copied benchmark harness framing imports to the base checkout's available capture-format export, backend-core export, or legacy server module. Current checkout imports remain unchanged.
- Restore `@raceiq/backend-core` alongside `@raceiq/capture-formats` in Forza's dependencies and lockfile while root/runtime/test consumers still require it.
- Verify copied harness behavior against modern pre-extraction and legacy base layouts, and verify Forza package resolution/typecheck plus lockfile consistency. Existing notifier initialization failures are outside these two findings.

## Test-preservation review corrections

- Restore complete rejection-result assertions in relocated lap-quality scenarios; retain all existing scenarios and fixture coverage.
- Preserve caller-provided iRacing feature flags in the suite runner rather than forcing the adapter enabled. Leave other sessions' staged changes untouched.
- Replace parameter properties in portable engine constructors with explicit readonly fields and remove unused host-detector remnants, without changing lifecycle behavior.
- Keep existing benchmark compatibility and Forza dependency fixes. Verify processor tests, rejection mutation detection, runner flag propagation, workspace/scripts typechecks, shard assignment, and changelog checks. No commit or push is requested.