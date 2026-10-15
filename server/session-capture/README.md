# Session capture

## Purpose

Owns RaceIQ raw-session persistence: length-prefixed frame recording, gzip storage, capture identity, import replay, session reprocessing, and orphan-file maintenance.

## Structure

- `framing.ts` defines capture framing and gzip helpers. `recorder.ts` appends frames and patches the final frame count.
- `import-capture.ts` detects canonical uploads and feeds them to `import-pipeline.ts`, which captures imported database identities and rolls failed imports back.
- `reprocess.ts` streams canonical `.bin`/`.bin.gz` frames (including sparse records) through the current lap detector, resets it at segment boundaries, and preserves lap-owned metadata where possible. MoTeC `.motec.zip` archives still require decoded channel arrays.
- `reconcile.ts` replays pending converted RaceIQ captures and MoTeC archives in bounded, ascending pages after HTTP startup and recording-folder organization. Database migration v67 marks pre-upgrade sessions pending; v76 queues every historical AC Evo session to rediscover native layouts. Unconverted legacy full-frame captures are excluded from playback and reprocessing.
- `identity.ts` hashes decompressed capture content so raw and gzip storage represent the same input.
- `compressor.ts` and `cleanup.ts` maintain recorded files after sessions finish.

## Boundaries and invariants

- Capture bytes are an optional 12-byte metadata frame (`0xffffffff`, payload length `4`, frame count), followed by ordered `[uint32 LE length][payload]` records. Recovery readers can stop at truncated tails; reprocessing uses strict framing and rejects malformed or truncated captures before changing saved laps.
- A released recording with persisted `captureFormatVersion: 1` has completed capture conversion even if its stream contains only source checkpoints and no sparse delta or format marker. Database-backed reprocessing, replay, and dashboard reads carry this provenance into both streaming and buffered loaders; cache keys include it. Standalone files without that provenance still require a sparse marker or delta. Provenance does not bypass framing validation or rewrite source bytes, timestamps, or lap offsets.
- Gzip changes storage encoding only. Identity hashes, parsing, and reprocessing operate on decompressed bytes.
- Compression streams through a temporary gzip file and publishes it only after successful completion. The database path changes before the raw source is removed; failures preserve the source.
- Compression, capture cleanup, reprocessing, and session/lap favourite updates share the maintenance lock. A cleanup plan cannot delete telemetry after a favourite update completes, and reprocessing cannot restore an archived capture path. Orphan cleanup acquires the same lock per file.
- Automatic capture cleanup is off by default. When enabled in Storage settings, scheduled maintenance uses the selected 30/90/180/365-day age and retains session/lap metadata; manual cleanup remains available.
- Historical reconciliation recomputes source-detected car/track identity, lap numbering, boundaries, times, validity, and sectors. It includes AC Evo Tourist timed attempts; it does not keep obsolete closed-circuit detections or infer missing layouts.
- Frame-overlap matches preserve original lap IDs and user-authored notes, favourites, profiles, setup snapshots, tune links, and experiment associations. Obsolete unmatched detections are removed; newly detected laps receive new IDs. Repaired rows invalidate telemetry, metrics, and analysis caches.
- A successful replay stores the current detector version; subsequent startup passes skip that session. Missing/corrupt captures and replays that recover no laps from existing history leave the repair marker pending and retain saved rows, with per-session failure logs.
- Startup reconciliation waits for existing recordings to be organized into `<game>/own` or `<game>/others`. Organization still requires explicit consent. Pending, failed, or interrupted organization blocks the startup pass; successful cutover automatically resumes it without restarting the server.
- The startup pass has a fixed session-ID high-water mark, so newly recorded sessions do not extend it. Startup stages run in order: historical lap reconciliation, LMU identity backfill, race-result backfill, then the dashboard processor. Exceptions and incomplete reports block successors: historical failures, missing captures, or remaining stale sessions; unresolved LMU identities; race-result errors or failed game backfills. Legitimate ambiguous or skipped race results are terminal outcomes, not failures.
- Recording paths and names are chosen by telemetry/runtime adapters. This domain must not change their naming, activation, or shutdown order.
- Game adapters own frame recognition and parsing. Telemetry owns live pipeline behavior. Database modules own session/lap persistence.
- Import rollback deletes sessions and their newly recorded files. Scheduled maintenance skips active recordings; background compression remains age-gated, while user-triggered compression also includes untracked `.bin` files.

## Testing

`test/raw-binary-storage.test.ts` covers metadata bytes, offsets, reprocessing, and truncated captures. `test/session-recorder.test.ts` covers record round trips and truncated final records. `test/session-compressor.test.ts` covers gzip output and age gating. `test/raw-capture-identity.test.ts` covers storage-independent hashes. `test/lap-export-import-roundtrip.test.ts` covers capture slicing and import replay. Changes to framing or file maintenance should preserve these byte-level and lifecycle contracts.
