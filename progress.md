# Issue #463 Progress

## Status

**All five correction phases implemented; final backend integration and workspace compiler gates pass. The recorded backend `TS2589` blocker is cleared.** See the [correction plan](docs/plans/lossless-per-lap-capture-correction.md) and [proposed ADR](docs/adr/0011-package-owned-indexed-capture-splitting.md). ADR acceptance is not implied; performance evidence retains the qualifications below.

The subsequent [indexed session lap archive](docs/plans/indexed-session-lap-archive.md) is implemented and behaviorally verified; its separate evidence and qualifications are below.

## Completed implementation

1. **Package algorithm and framing:** exact exclusive encoded `endOffset`; strict source consumption and truncation rejection; package-owned window normalization/checkpoint preparation; sequential owned/context writing; independent conservation verification; cancellation and original worker failure codes. Historical recovery readers retain explicit tolerant framing.
2. **Publication and consumers:** fenced staging/rename/transaction publication; atomic invalidation after source/window changes; imported bootstrap persistence; canonical/native dump routing; direct artifact replay/export/provenance. ZIP initialization and completion records remain non-owned; cold F1/iRacing imports preserve telemetry and saved timing/validity. Post-commit notification failure cannot delete published files.
3. **Maintenance:** reference-aware nested/shared bundle protection; queued-source compression protection; unpublished migration attempt fencing and post-lock requeue; explicit queued-job cancellation on full deletion; active attempt protection. Capture cleanup clears session/lap/job readiness together, restores references after pre-delete failure, and accounts for partial irreversible deletion.
4. **Progress and readiness:** committed job/attempt/sequence snapshots, real frame counters, coalesced terminal notifications, session and lap refreshes, reconnect invalidation, usable null-layout legacy exports, and accessible disabled-export explanations.
5. **Acceptance and documentation:** real six-game plain/gzip native-byte and consumer-JSON replay smoke, cold detector-sized artifact-only workload, desktop/mobile visual inspection, full backend integration, compiler/package gates, updated architecture and customer release notes.

Final integration bounds session-list RPC response inference with the existing `SessionMeta[]` contract, restores parser bootstraps and segment resets in cold and batched replay, and migrates bundle-consumer fixtures to supported sparse captures. Real iRacing ZIP round-trip smoke verifies identical cold/batched telemetry, saved timing/validity, and artifact-only replay with the imported monolith unavailable.

## Preserved constraints

- Monolithic recordings remain retained. No source retirement or storage-space savings claimed.
- No live per-lap rotation, replacement detector, second splitter, parser framework, checkpoint sidecar, per-frame worker RPC, compatibility shim, or UI redesign.
- Ownership derives from persisted detector offsets/counts, never lap labels.
- Native bytes, ordering, timestamps, and timestamp absence remain preserved. Boundary/completion context does not duplicate ownership.
- Manifest v3 `sourceByteLength` remains physical source size, including gzip; record/chunk source offsets remain decompressed encoded-stream offsets.
- Null-layout legacy fallback remains; invalid non-null published layouts fail explicitly.

## Verification

Evidence directory: `.omp/evidence/lossless-per-lap-captures/`.

| Gate/scenario | Result | Evidence |
| --- | --- | --- |
| Complete backend integration | 2,829 passed; 4 skipped; 0 failed, across 205 files | `backend-integration-resolution-accepted.log` |
| Focused maintenance/startup isolation | 41 passed; 0 failed | `maintenance-final.log` |
| Six games, plain/gzip: native bytes and independent consumer telemetry | Passed | `runtime-smoke.log` |
| Fifty detector-sized windows, monolith unavailable, bounded artifact records and sequential telemetry hashes | Passed | `runtime-smoke.log` |
| Capture-formats / capture-splitting / server / client typechecks | Passed | `capture-format-types.log`, `capture-splitting-types.log`, `server-types.log`, `client-types.log` |
| Package-local cancellation | Passed | `capture-splitting-unit.log` |
| Desktop/mobile progress, failure, export readiness, accessibility, no overflow | Passed DOM checks and inspected screenshots | `ui-live-dom.json`, `ui-desktop.png`, `ui-mobile.png` |
| Burst coalescing, replacement job, reload, reconnect, reprocessing invalidation | Passed | `ui-reconnect.json` |
| Backend and complete workspace typecheck, including client RPC and Storybook | Passed with current Bun compiler | `workspace-types-resolution-accepted.log` |
| Session-list HTTP response, game filtering, identity, readiness, and query validation | Passed | `session-route-runtime-resolution.log` |
| Real iRacing ZIP import, cold/batched replay, saved metadata, and monolith-unavailable artifact replay | Passed | `iracing-archive-runtime-resolution.log` |
| Release-note artifact rules | 11 passed; 0 failed | `changelog-resolution.log` |

### Performance scope

The workload contains **50 copies of one real completed FM persisted detector window**, not an actual 50-lap race. Each window contains 4,704 native frames. Both paths replayed 235,200 packets; artifact telemetry matched sequential baseline hashes with the monolith renamed unavailable. Each artifact contained only its 4,704 owned frames.

Application source cache was cleared before each read; OS caches were not cleared. Final observed latency: monolith 6,412 ms, artifacts 1,433 ms. This is one qualified measurement, not a performance threshold. Reported memory values are before/after RSS/heap deltas, not peaks. Logical selected-file-size totals are not measured physical I/O. Full measurements and workload details remain in `runtime-smoke.log`.

## Final integration

The historical `TS2589` compiler failure remains recorded in `backend-types.log`, not counted as a success. After explicitly binding the session-list JSON response to its existing public contract, `bun run --cwd apps/backend typecheck` and the complete `bun run typecheck` gate pass with the current Bun compiler. Final integration also exposed and corrected cold iRacing replay dropping parser-bootstrap records and three consumer scenarios still using removed full-frame capture storage.

## Workspace state

- Historical checkpoint remains at `.omp/checkpoints/lossless-per-lap-captures.md`; this task's current completion and evidence are recorded here.
- No commits created. Existing user changes preserved.
- Temporary verification scaffolding and owned UI services are removed/stopped after evidence capture.

## Indexed session lap archive

New splits publish manifest v4 and one indexed independent-member gzip file under DB layout 2. Layout 1/v3 directory bundles and null-layout legacy reads retain their original meanings. Migration 78 stores the archive separately from the JSON path. Direct replay, Analyse, recorded replay, external ZIP export/import, provenance, replacement-aware caches, readiness, reprocessing, cleanup, relocation and shared byte accounting use selected artifact sources. The retained monolith is never a silent fallback for an invalid published layout. [ADR 0012](docs/adr/0012-indexed-session-lap-archive.md) remains proposed.

Evidence: `.omp/evidence/indexed-session-lap-archive/`.

- Package unit tests: **8 passed, 0 failed** (`package.log`).
- Complete backend integration: **2,839 passed, 4 skipped, 0 failed**, 205 files (`integration.log`, `integration-errors.log`). Skips cover external LM Studio, native shutdown, GitHub release-body integration and the known corrupt ACC fixture; a valid ACC recording was used for archive proof.
- Refreshed complete `bun run typecheck` and `bun run lint`: passed (`typecheck*.log`, `lint*.log`). Release-note checks: 11 passed (`changelog*.log`).
- Six real recorded-telemetry workloads, plain/gzip inputs: **12 cases passed**, with 27 saved detector windows across selected sessions (`proof.log`, `proof-errors.log`, `measurements.json`). iRacing uses the existing compact real IBT-derived Daytona fixture, not the default synthetic Road America fixture. Invalid and start/end fragment windows are preserved; these counts are not claims of completed or valid laps. No windows were repeated to simulate a 50-lap session.
- Native bytes, order, timestamps/absence and exact-once ownership match the source across lap and auxiliary records. Synthesized initialization and permitted non-owned boundary context are accounted separately. Every saved lap's consumer telemetry and timing/validity match with the monolith hidden. ACC/Evo fixtures without acquisition UTC exclude only replay-wall-clock `TimestampMS` from consumer equality; native timestamp absence remains exact. Additional real-frame samples with explicitly synthetic mixed/zero/missing acquisition times passed for all six games.
- Standalone package children read exactly the selected compressed member and decompress zero other members. Deliberately corrupting all other payloads leaves the selected member readable. The sparse large-offset probe reads 49 actual bytes at offset 4,294,967,296 (`large-offset.log`); it proves range isolation, not validity of the intentionally inaccessible preceding ranges.
- Actual production-route UI readiness and Export action passed with an F1 monolith hidden. The exported ZIP contains the selected capture and manifest; its body is 2,589,168 bytes. A cold backend restart, real WebSocket closure/reconnect and page reload preserve readiness and successful export (`ui.json`). Both authorized headless screenshot attempts timed out: **visual capture remains unavailable**, not passed. The response-buffer inspection helper also returned zero bytes incorrectly; independent page fetch verified the actual ZIP payload.

### Matched storage

Bun 1.4.3, macOS arm64, Apple M5. Sizes include representation metadata and all lap/auxiliary payloads; retained sources are separate. Directory baselines materialize identical capture payloads with directory-style JSON metadata, not a second run of the historical v3 splitter. MiB means 1,048,576 bytes.

| Game | Saved windows (valid) | Plain directory MiB | Indexed gzip MiB | Individual gzip directory MiB | Indexed allocated MiB | Individual gzip allocated MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| FM 2023 | 3 (2) | 3.500 | 2.424 | 2.424 | 2.430 | 2.434 |
| F1 25 | 5 (4) | 145.272 | 13.069 | 13.039 | 13.246 | 13.055 |
| ACC | 4 (2) | 23.467 | 8.348 | 8.348 | 8.352 | 8.355 |
| AC Evo | 4 (0) | 29.427 | 11.762 | 11.761 | 11.766 | 11.770 |
| iRacing | 4 (1) | 5.905 | 2.647 | 2.646 | 2.648 | 2.660 |
| LMU | 7 (1) | 228.783 | 48.137 | 48.137 | 49.008 | 48.145 |

Combined logical size is 90,583,644 bytes versus 457,550,161 plain-directory bytes: **80.20% smaller**. Against already-gzipped directories, the archive is **33,469 bytes larger**, not smaller. The separately retained monoliths total **457,380,515 bytes**, none reclaimed.

Physical allocation totals are 91,697,152 indexed bytes, 457,633,792 plain-directory bytes and 90,615,808 individually gzipped bytes. Untouched archive allocation was captured before corruption/probes. F1 and LMU showed allocation above block-rounded logical size; single-stream copies allocated close to logical size, while same-size truncation did not reclaim that allocation. This is an observed filesystem/write-pattern cost, not a claimed saving.

The F1 gzip payload is 30,786 bytes larger than the matched streaming-gzip baseline. A selected-payload probe reproduced the archive member's size with the same per-record awaited gzip writes; a single-buffer write compressed slightly smaller. The native capture bytes were identical. Other games' payload differences are 0–422 bytes. Aggregation itself does not provide compression savings over existing gzip.

### Latency, writing and memory

Consumer medians use the same production parser API, fresh parser state, one warmup and three measured trials per representation in an isolated backend child. OS caches were not flushed. Archive split time includes scanning, compression/writing and semantic verification. Baseline write time only materializes already-matched captures and streaming gzip, excluding splitting and semantic verification; it is **not** a comparison with historical splitter throughput.

| Game | Plain replay median ms | Indexed replay median ms | Individual gzip replay median ms | Archive scan/write/verify ms | Baseline materialization ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| FM 2023 | 2.9 | 6.3 | 5.3 | 290 | 39 |
| F1 25 | 40.3 | 47.8 | 44.0 | 2,587 | 233 |
| ACC | 17.3 | 20.3 | 17.3 | 643 | 147 |
| AC Evo | 11.4 | 16.9 | 14.6 | 702 | 189 |
| iRacing | 6.6 | 9.0 | 8.9 | 206 | 59 |
| LMU | 100.9 | 110.7 | 101.3 | 7,918 | 816 |

The indexed path is slower than plain reads and usually slower than individual gzip in this sample. Native CRC32 replaced an avoidable JavaScript checksum loop during investigation. Remaining measurements include bounded reads, decompression/checksum/index validation and existing parser work; no unapproved performance threshold or OS-cold claim is made.

Separate fresh processes measure each representation's peak RSS for one selected production-parser replay plus telemetry hashing (`memory-comparison.json`). Startup and telemetry materialization are included; these are single-run process peaks, not reader-only allocation deltas. All three representations produce matching telemetry hashes.

| Game | Plain peak RSS MiB | Indexed peak RSS MiB | Individual gzip peak RSS MiB |
| --- | ---: | ---: | ---: |
| FM 2023 | 213 | 193 | 214 |
| F1 25 | 613 | 742 | 784 |
| ACC | 395 | 392 | 410 |
| AC Evo | 338 | 320 | 332 |
| iRacing | 207 | 203 | 206 |
| LMU | 396 | 386 | 455 |

F1's indexed full-consumer peak is higher than plain and lower than individual gzip; no universal memory reduction is claimed. Independent standalone package children, without backend imports or telemetry materialization, peak at approximately 37–88 MiB while reading only the selected member. Their application-cold selected reads take 6.4–31.8 ms; the OS cache remains uncontrolled. The latency-comparison child's aggregate peak across all trials is separately scoped in `measurements.json` and is not attributed to one representation.

Temporary scripts, private fixture credentials, downloaded ZIP and disposable proof data are removed after verification; owned browser/server services are stopped. No commits or source retirement occurred.
