# Session capture

## Purpose

Owns RaceIQ raw-session persistence: length-prefixed frame recording, gzip storage, capture identity, import replay, session reprocessing, and orphan-file maintenance.

## Structure

- `@raceiq/capture-formats/session/framing` defines capture framing, sparse records, and gzip helpers; the package recorder APIs append frames and patch the final frame count. Server modules use these package exports for persistence, identity, and replay.
- `import-capture.ts` detects canonical uploads and feeds them to `import-pipeline.ts`, which captures imported database identities and rolls failed imports back.
- `reprocess.ts` streams canonical `.bin`/`.bin.gz` frames (including sparse records) through the current lap detector, resets it at segment boundaries, and preserves lap-owned metadata where possible. MoTeC `.motec.zip` archives still require decoded channel arrays.
- `reconcile.ts` replays pending sparse RaceIQ captures and MoTeC archives in bounded, ascending pages after HTTP startup. Database migration v67 marks pre-upgrade sessions pending, but legacy full-frame captures are excluded from playback and reprocessing.
- `identity.ts` hashes decompressed capture content so raw and gzip storage represent the same input.
- `compressor.ts`, `cleanup.ts`, and `session-downsample.ts` coordinate post-capture maintenance. The Effect-owned scheduler orders compression, optional downsampling, deletion, and file cleanup; see the [scheduled recording maintenance guide](../../docs/contributing/scheduled-recording-maintenance.md).

## Boundaries and invariants

- Capture bytes are an optional 12-byte metadata frame (`0xffffffff`, payload length `4`, frame count), followed by ordered `[uint32 LE length][payload]` records. Recovery readers can stop at truncated tails; reprocessing uses strict framing and rejects malformed or truncated captures before changing saved laps.
- Gzip changes storage encoding only. Identity hashes, parsing, and reprocessing operate on decompressed bytes.
- Compression streams through a temporary gzip file and publishes it only after successful completion. The database path changes before the raw source is removed; failures preserve the source.
- Compression, capture cleanup, downsampling, reprocessing, and session/lap favourite updates share the maintenance lock. A cleanup/downsample plan rechecks references and favorites before changing a file; orphan cleanup acquires the same lock per file.
- Automatic deletion and downsampling are off by default. When enabled together, deletion age must be strictly greater than downsample age. Downsampling protects favorite-shared files, excludes unsupported formats and unreliable timebases, and records an established target cap to avoid repeating equal/lower-rate work.
- Historical reconciliation recomputes source-detected car/track identity, lap numbering, boundaries, times, validity, and sectors. It includes AC Evo Tourist timed attempts; it does not keep obsolete closed-circuit detections or infer missing layouts.
- Frame-overlap matches preserve original lap IDs and user-authored notes, favourites, profiles, setup snapshots, tune links, and experiment associations. Obsolete unmatched detections are removed; newly detected laps receive new IDs. Repaired rows invalidate telemetry, metrics, and analysis caches.
- A successful replay stores the current detector version; subsequent startup passes skip that session. Missing/corrupt captures and replays that recover no laps from existing history leave the repair marker pending and retain saved rows, with per-session failure logs.
- The startup pass has a fixed session-ID high-water mark, so newly recorded sessions do not extend it. Race-result and LMU identity backfills run after historical lap reconciliation.
- Recording paths and names are chosen by telemetry/runtime adapters. This domain must not change their naming, activation, or shutdown order.
- Game adapters own frame recognition and parsing. Telemetry owns live pipeline behavior. Database modules own session/lap persistence.
- Import rollback deletes sessions and their newly recorded files. Scheduled maintenance skips active recordings; background compression remains age-gated, while user-triggered compression also includes untracked `.bin` files.
  
## Scheduled maintenance

- `maintenance-runtime.ts` owns one managed Effect runtime per backend lifecycle, atomic admission, job status, and tracked fibers. Manual downsampling uses Promise facades; the backend acknowledges accepted work only after admission and storage reservation. The five-minute scheduler starts immediately and spaces subsequent passes from completion.
- `compressor.ts` runs compression, fresh retention-policy validation, automatic downsampling, deletion, then orphan/staged-import/operation-temp cleanup in order. Failed automatic downsampling skips deletion for that pass. See the [maintenance guide](../../docs/contributing/scheduled-recording-maintenance.md) for timing, publication, recovery, and lifecycle contracts.
- Downsampling's two-pass streaming format engine belongs to `packages/capture-formats`; this package owns database eligibility, locks, atomic path/lap-index publication, cache invalidation, and shutdown lifecycle. Live UDP rates are unaffected.

## Testing

`test/raw-binary-storage.test.ts` covers metadata bytes, offsets, reprocessing, and truncated captures. `test/session-recorder.test.ts` covers record round trips and truncated final records. `test/session-compressor.test.ts` covers gzip output and age gating. `test/raw-capture-identity.test.ts` covers storage-independent hashes. `test/lap-export-import-roundtrip.test.ts` covers capture slicing and import replay. Changes to framing or file maintenance should preserve these byte-level and lifecycle contracts.
