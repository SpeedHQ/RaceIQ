# Issue #463 Progress

## Status

**All five correction phases implemented; behavioral acceptance verified. Release remains blocked by the existing backend TypeScript `TS2589` failure.** See the [correction plan](docs/plans/lossless-per-lap-capture-correction.md) and [proposed ADR](docs/adr/0011-package-owned-indexed-capture-splitting.md). ADR acceptance is not implied.

## Completed implementation

1. **Package algorithm and framing:** exact exclusive encoded `endOffset`; strict source consumption and truncation rejection; package-owned window normalization/checkpoint preparation; sequential owned/context writing; independent conservation verification; cancellation and original worker failure codes. Historical recovery readers retain explicit tolerant framing.
2. **Publication and consumers:** fenced staging/rename/transaction publication; atomic invalidation after source/window changes; imported bootstrap persistence; canonical/native dump routing; direct artifact replay/export/provenance. ZIP initialization and completion records remain non-owned; cold F1/iRacing imports preserve telemetry and saved timing/validity. Post-commit notification failure cannot delete published files.
3. **Maintenance:** reference-aware nested/shared bundle protection; queued-source compression protection; unpublished migration attempt fencing and post-lock requeue; explicit queued-job cancellation on full deletion; active attempt protection. Capture cleanup clears session/lap/job readiness together, restores references after pre-delete failure, and accounts for partial irreversible deletion.
4. **Progress and readiness:** committed job/attempt/sequence snapshots, real frame counters, coalesced terminal notifications, session and lap refreshes, reconnect invalidation, usable null-layout legacy exports, and accessible disabled-export explanations.
5. **Acceptance and documentation:** real six-game plain/gzip native-byte and consumer-JSON replay smoke, cold detector-sized artifact-only workload, desktop/mobile visual inspection, full backend integration, compiler/package gates, updated architecture and customer release notes.

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
| Complete backend integration | 2,767 passed; 4 skipped; 0 failed, across 199 files | `backend-integration-final.log` |
| Focused maintenance/startup isolation | 41 passed; 0 failed | `maintenance-final.log` |
| Six games, plain/gzip: native bytes and independent consumer telemetry | Passed | `runtime-smoke.log` |
| Fifty detector-sized windows, monolith unavailable, bounded artifact records and sequential telemetry hashes | Passed | `runtime-smoke.log` |
| Capture-formats / capture-splitting / server / client typechecks | Passed | `capture-format-types.log`, `capture-splitting-types.log`, `server-types.log`, `client-types.log` |
| Package-local cancellation | Passed | `capture-splitting-unit.log` |
| Desktop/mobile progress, failure, export readiness, accessibility, no overflow | Passed DOM checks and inspected screenshots | `ui-live-dom.json`, `ui-desktop.png`, `ui-mobile.png` |
| Burst coalescing, replacement job, reload, reconnect, reprocessing invalidation | Passed | `ui-reconnect.json` |
| Backend typecheck | Failed: existing `TS2589` | `backend-types.log` |

### Performance scope

The workload contains **50 copies of one real completed FM persisted detector window**, not an actual 50-lap race. Each window contains 4,704 native frames. Both paths replayed 235,200 packets; artifact telemetry matched sequential baseline hashes with the monolith renamed unavailable. Each artifact contained only its 4,704 owned frames.

Application source cache was cleared before each read; OS caches were not cleared. Final observed latency: monolith 6,412 ms, artifacts 1,433 ms. This is one qualified measurement, not a performance threshold. Reported memory values are before/after RSS/heap deltas, not peaks. Logical selected-file-size totals are not measured physical I/O. Full measurements and workload details remain in `runtime-smoke.log`.

## Release blocker

`bun run --cwd apps/backend typecheck` still emits `TS2589: Type instantiation is excessively deep and possibly infinite.` Current output has no source location; the earlier location was `apps/backend/src/routes/session-routes.ts:31`. No other compiler errors remain in the recorded gates. The failed check is not counted as passed; release is not approved.

## Workspace state

- Existing approved checkpoint updated at `.omp/checkpoints/lossless-per-lap-captures.md`.
- No commits created. Existing user changes preserved.
- Temporary verification scaffolding and owned UI services are removed/stopped after evidence capture.
