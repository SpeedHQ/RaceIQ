# Session capture

## Purpose

Owns RaceIQ raw-session persistence: length-prefixed frame recording, gzip storage, capture identity, import replay, session reprocessing, and orphan-file maintenance.

## Structure

- `framing.ts` defines capture framing and gzip helpers. `recorder.ts` appends frames and patches the final frame count.
- `import-capture.ts` detects canonical uploads and feeds them to `import-pipeline.ts`, which captures imported database identities and rolls failed imports back.
- `reprocess.ts` streams canonical `.bin`/`.bin.gz` frames (including sparse records) through the current lap detector, resets it at segment boundaries, and preserves lap-owned metadata where possible. MoTeC `.motec.zip` archives still require decoded channel arrays.
- `reconcile.ts` replays pending historical sessions in bounded, ascending pages after HTTP startup. Database migration v67 marks every pre-upgrade session pending, including AC Evo sessions with already-filled identities.
- `identity.ts` hashes decompressed capture content so raw and gzip storage represent the same input.
- `compressor.ts` and `cleanup.ts` maintain recorded files after sessions finish.

## Boundaries and invariants

- Capture bytes are an optional 12-byte metadata frame (`0xffffffff`, payload length `4`, frame count), followed by ordered `[uint32 LE length][payload]` records. Recovery readers can stop at truncated tails; reprocessing uses strict framing and rejects malformed or truncated captures before changing saved laps.
- Gzip changes storage encoding only. Identity hashes, parsing, and reprocessing operate on decompressed bytes.
- Compression streams through a temporary gzip file and publishes it only after successful completion. The database path changes before the raw source is removed; failures preserve the source.
- Compression, capture cleanup, reprocessing, and session/lap favourite updates share the maintenance lock. A cleanup plan cannot delete telemetry after a favourite update completes, and reprocessing cannot restore an archived capture path. Orphan cleanup acquires the same lock per file.
- Automatic capture cleanup is off by default. When enabled in Storage settings, scheduled maintenance uses the selected 30/90/180/365-day age and retains session/lap metadata; manual cleanup remains available.
- Historical reconciliation recomputes source-detected car/track identity, lap numbering, boundaries, times, validity, and sectors. It includes AC Evo Tourist timed attempts; it does not keep obsolete closed-circuit detections or infer missing layouts.
- Frame-overlap matches preserve original lap IDs and user-authored notes, favourites, profiles, setup snapshots, tune links, and experiment associations. Obsolete unmatched detections are removed; newly detected laps receive new IDs. Repaired rows invalidate telemetry, metrics, and analysis caches.
- A successful replay stores the current detector version; subsequent startup passes skip that session. Missing/corrupt captures and replays that recover no laps from existing history leave the repair marker pending and retain saved rows, with per-session failure logs.
- The startup pass has a fixed session-ID high-water mark, so newly recorded sessions do not extend it. Race-result and LMU identity backfills run after historical lap reconciliation.
- Recording paths and names are chosen by telemetry/runtime adapters. This domain must not change their naming, activation, or shutdown order.
- Game adapters own frame recognition and parsing. Telemetry owns live pipeline behavior. Database modules own session/lap persistence.
- Import rollback deletes sessions and their newly recorded files. Scheduled maintenance skips active recordings; background compression remains age-gated, while user-triggered compression also includes untracked `.bin` files.
## Lossless per-lap capture splitting

`@raceiq/capture-formats` owns exact encoded record boundaries and strict decoding. `@raceiq/capture-splitting` owns indexed-window normalization, opaque parser initialization preparation through injected game codecs, sequential artifact writing, and independent conservation verification. Ownership comes only from detector byte offsets/frame counts; lap numbers are labels. A shared boundary frame belongs to the next lap and may appear once as trailing non-owned context in the previous artifact. Source offsets count decompressed encoded bytes; the physical source byte length remains separately recorded.

Preparation and verification may scan independently; artifact writing is one sequential pass. Game codecs create/reset parser state and capture/restore opaque checkpoints. The package does not depend on backend registries or concrete parsers. Workers stage and verify artifacts only. Backend fences attempts/source revisions, renames verified staging, and transactionally publishes DB references; invalidation clears stale publication before readers observe changed ownership. Workers never publish or retire source recordings.

Imported parser bootstraps persist through pending and active recorder paths before dependent frames. ZIP export preserves native payloads and explicitly separates owned records from initialization and trailing completion context. Import can use context to complete a detection without recording it as owned telemetry. Saved timing/validity restores from existing ZIP metadata; lap labels never determine ownership.

Compression protects split-job and published sources. Migration fences unpublished queued/failed jobs atomically with source/index changes and requeues after releasing the maintenance lock; active attempts and published provenance remain protected. Capture cleanup clears session/lap/job references together and restores them on pre-delete failure, including when the monolith is missing but artifacts remain. Full session deletion cancels queued work but rejects active attempts. Shared references protect sources/bundles; partial irreversible deletions report accurate residuals. Post-commit notification failures cannot roll back publication or remove its files. Null-layout legacy exports remain valid; invalid non-null layouts fail explicitly.

## Testing

`test/raw-binary-storage.test.ts` covers metadata bytes, offsets, reprocessing, and truncated captures. `test/session-recorder.test.ts` covers record round trips and truncated final records. `test/session-compressor.test.ts` covers gzip output and age gating. `test/raw-capture-identity.test.ts` covers storage-independent hashes. `test/lap-export-import-roundtrip.test.ts` covers capture slicing and import replay. Changes to framing or file maintenance should preserve these byte-level and lifecycle contracts.
