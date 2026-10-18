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
- Recording paths and names are chosen by telemetry/runtime adapters. Split artifacts follow the configured recording directory and session ownership (`own`/`others`); this domain must not change their naming, activation, or shutdown order.
- Game adapters own frame recognition and parsing. Telemetry owns live pipeline behavior. Database modules own session/lap persistence.
- Import rollback deletes sessions and their newly recorded files. Scheduled maintenance skips active recordings; background compression remains age-gated, while user-triggered compression also includes untracked `.bin` files.
## Direct live per-lap recording

`direct-recorder.ts` records new live sessions directly into independent sparse `.bin` files. Session startup reserves an active file and an already-open standby through `PreopenedFileWriter`; native input only encodes and enqueues bounded writes. At a detector-owned boundary, recording switches to the standby synchronously, drains and closes the previous file asynchronously, and starts opening the next standby. No file open, write, fsync, or close is awaited by the boundary operation.

The boundary's native bytes and timestamp finish the previous artifact as non-owned completion context and start the next artifact as its first owned frame. Each file starts with a full sparse checkpoint and the required opaque parser bootstrap/context. Re-announcing a provisional boundary promotes its existing ownership rather than rotating a second time. Artifact creation does not normalize telemetry, replay game parsers, scan an earlier recording, or create a duplicate monolith.

Native input waiting behind a detector decision uses a bounded FIFO so later frames cannot pass an unresolved boundary while database callbacks are pending. Parser-null tails flush when ingress is idle and before finalization. Writer bytes and retiring file lifecycles are bounded; unavailable standby or exhausted capacity fails recording explicitly rather than routing bytes to the wrong file.

Closed files are synced before a standalone version-3 manifest is atomically persisted and directory-synced; only then are lap references published and readiness announced. Sessions use layout 1 and reference the manifest as their source. Direct manifests declare `sourceCoordinates: "native-wire-v1"`: offsets describe full native frame wire lengths, not compressed/sparse file positions. Each chunk's `sourceRecordByteOffset` skips its synthetic initialization prefix; `recordCount` excludes its duplicated trailing boundary. This lets full-session readers reconstruct original source order and timestamps exactly once without a monolith.

Session changes detach the old capture while the next capture starts. Final shutdown waits for accepted writes and publication. Imported and historical recordings retain the separate splitting path below; new live recording does not enqueue it.

Storage maintenance remains excluded while active or retiring captures drain. Orphan cleanup recognizes only controlled direct directory and part names, preserves unpublished parts beside a referenced manifest, and removes those parts only after the source is no longer referenced.

## Lossless per-lap capture splitting

`@raceiq/capture-formats` owns exact encoded record boundaries and strict decoding. `@raceiq/capture-splitting` owns indexed-window normalization, opaque parser initialization preparation through injected game codecs, sequential artifact writing, and independent conservation verification. Ownership comes only from detector byte offsets/frame counts; lap numbers are labels. A shared boundary frame belongs to the next lap and may appear once as trailing non-owned context in the previous artifact. Source offsets count decompressed encoded bytes; the physical source byte length remains separately recorded.

Preparation and verification may scan independently; artifact writing is one sequential pass. Game codecs create/reset parser state and capture/restore opaque checkpoints. The package does not depend on backend registries or concrete parsers. Workers stage and verify artifacts only. Backend fences attempts/source revisions, renames verified staging, and transactionally publishes DB references; invalidation clears stale publication before readers observe changed ownership. Workers never publish or retire source recordings.

Imported parser bootstraps persist through pending and active recorder paths before dependent frames. ZIP export preserves native payloads and explicitly separates owned records from initialization and trailing completion context. Import can use context to complete a detection without recording it as owned telemetry. Saved timing/validity restores from existing ZIP metadata; lap labels never determine ownership.

Compression protects split-job and published sources. Migration fences unpublished queued/failed jobs atomically with source/index changes and requeues after releasing the maintenance lock; active attempts and published provenance remain protected. Capture cleanup clears session/lap/job references together and restores them on pre-delete failure, including when the monolith is missing but artifacts remain. Full session deletion cancels queued work but rejects active attempts. Shared references protect sources/bundles; partial irreversible deletions report accurate residuals. Post-commit notification failures cannot roll back publication or remove its files. Null-layout legacy exports remain valid; invalid non-null layouts fail explicitly.

## Testing

`test/raw-binary-storage.test.ts` covers metadata bytes, offsets, reprocessing, and truncated captures. `test/session-recorder.test.ts` covers record round trips and truncated final records. `test/session-compressor.test.ts` covers gzip output and age gating. `test/raw-capture-identity.test.ts` covers storage-independent hashes. `test/lap-export-import-roundtrip.test.ts` covers capture slicing and import replay. Changes to framing or file maintenance should preserve these byte-level and lifecycle contracts.

Direct recording regressions live in `apps/backend/test/session-capture/preopened-file-writer.test.ts`, `direct-recorder.test.ts`, and `direct-recording-ingress.test.ts`. They cover partial writes, close/drain races, standby/retirement limits, shared frames, provisional promotion, delayed lap binding, source conservation, and export/import without a monolith. `source-loader-stream.test.ts` covers native-wire manifest reconstruction and invalid paths/coordinates.
