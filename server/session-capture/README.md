# Session capture

## Purpose

Owns RaceIQ raw-session persistence: length-prefixed frame recording, gzip storage, capture identity, import replay, session reprocessing, and orphan-file maintenance.

## Structure

- `framing.ts` defines capture framing and gzip helpers. `recorder.ts` appends frames and patches the final frame count.
- `import-capture.ts` detects canonical uploads and feeds them to `import-pipeline.ts`, which captures imported database identities and rolls failed imports back.
- `import-results.ts` validates Rust manifests and canonical path containment, materializes analysis recipes through Rust lap-window reads, and commits or rolls back imported sessions/laps.
- `reprocess.ts` streams canonical `.bin`/`.bin.gz` frames (including sparse records) through the current lap detector, resets it at segment boundaries, and preserves lap-owned metadata where possible. MoTeC `.motec.zip` archives still require decoded channel arrays.
- `identity.ts` hashes decompressed capture content so raw and gzip storage represent the same input.
- `compressor.ts` and `cleanup.ts` maintain recorded files after sessions finish.

## Boundaries and invariants

- Capture bytes are an optional 12-byte metadata frame (`0xffffffff`, payload length `4`, frame count), followed by ordered `[uint32 LE length][payload]` records. Readers stop at truncated tails; they do not repair or reorder data.
- Gzip changes storage encoding only, including concatenated gzip members. Identity hashes, parsing, and reprocessing operate on decompressed bytes.
- Compression streams through a temporary gzip file and publishes it only after successful completion. The database path changes before the raw source is removed; failures preserve the source.
- Compression, capture cleanup, reprocessing, and session/lap favourite updates share the maintenance lock. A cleanup plan cannot delete telemetry after a favourite update completes, and reprocessing cannot restore an archived capture path. Orphan cleanup acquires the same lock per file.
- Automatic capture cleanup is off by default. When enabled in Storage settings, scheduled maintenance uses the selected 30/90/180/365-day age and retains session/lap metadata; manual cleanup remains available.
- Segment reprocessing scans the whole capture; each segment gets a fresh detector, while matching by source offset protects notes and favourites if detected lap numbers change.
- Reprocessing preserves favourites on matched replacement laps, keeping their captures protected from telemetry cleanup.
- Recording paths and names are chosen by telemetry/runtime adapters. This domain must not change their naming, activation, or shutdown order.
- Game adapters own frame recognition and parsing. Telemetry owns live pipeline behavior. Database modules own session/lap persistence. Race-result reconciliation runs only after a successful import.
- When Rust is selected, source decoding, detection, reprocessing, capture/lap encoding, and replay run in the bundled child; Bun consumes authoritative results and persists database state without repeating detection. Recording jobs are gated during engine handoffs.
- Rust result paths must remain inside the canonical job directory; reprocessing may retain only explicitly authorized original source paths. Analysis range offsets identify frames, while optional context offsets must identify actual context markers.
- Explicit MoTeC jobs accept ordinary `.zip` filenames. Their lap recipes use source packet offsets and omit binary context offsets because channel logs contain no binary context records.
- Import rollback deletes sessions and their newly recorded files. Scheduled maintenance skips active recordings; background compression remains age-gated, while user-triggered compression also includes untracked `.bin` files.

## Testing

`test/raw-binary-storage.test.ts` covers metadata bytes, offsets, reprocessing, and truncated captures. `test/session-recorder.test.ts` covers record round trips and truncated final records. `test/session-compressor.test.ts` covers gzip output and age gating. `test/raw-capture-identity.test.ts` covers storage-independent hashes. `test/lap-export-import-roundtrip.test.ts` covers capture slicing and import replay. Changes to framing or file maintenance should preserve these byte-level and lifecycle contracts.
