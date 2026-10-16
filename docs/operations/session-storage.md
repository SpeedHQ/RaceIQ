# Session storage maintenance

RaceIQ keeps retained raw session recordings under the configured recording
directory, defaulting to `<DATA_DIR>/sessions/<gameId>/`, with `own` and `others`
ownership folders. `sessions.rawFile` continues to identify the retained source.
Published lap archives have separate manifest and data references.

Maintenance has three responsibilities:

1. delete empty database sessions at startup;
2. compress completed recordings;
3. remove unreferenced recording files.

All destructive background work stops while `isSessionActive()` is true.

## Startup and schedule

`apps/backend/src/index.ts` runs:

```text
deleteEmptySessions()
startSessionCompressor()
  runMaintenance() immediately
  runMaintenance() every 5 minutes
```

`runMaintenance()` runs age-gated compression, then orphan cleanup.

| Operation | Schedule | Source |
| --- | --- | --- |
| Empty-session deletion | Startup | `server/db/session-queries.ts` |
| Background compression | Startup and every 5 minutes | `server/session-capture/compressor.ts` |
| Orphan cleanup | Startup and every 5 minutes | `server/session-capture/cleanup.ts` |
| User compression | Settings **Compress now** | `POST /api/storage/compress` |

## Published lap bundles

New splits publish an immutable session attempt directory containing a manifest v4
`manifest.json` and one `capture.bin.gz` file. Independent gzip members permit
direct selected-lap reads; the JSON index records each member's offset and size.
Do not gunzip or recompress this file as though it were the retained monolith.

DB layout version 2 stores `captureManifestFile` as the JSON path and
`captureArchiveFile` as the data-file path. Layout version 1 retains existing v3
directory bundle reads; null-layout sessions retain historical source reads.
Publication verifies the closed archive, renames the complete attempt, then
commits fenced session/lap references. Startup fences interrupted attempts and
removes unpublished output only when no published reference owns it.

Deleting one lap does not delete a shared archive. Session cleanup removes files
only after their final references are cleared, including when a monolith is
missing or null. Cleanup previews count the shared archive and manifest once.
Relocation moves both files and updates both DB paths without rewriting member
offsets or mutating the manifest.


## Compression

Background compression selects database-referenced `.bin` files whose session
is at least 24 hours old. User-triggered compression removes that age gate and
also compresses unreferenced `.bin` files found on disk.

For a referenced session, `compressSession()`:

1. writes `<path>.bin.gz`;
2. updates `sessions.rawFile` to the gzip path while preserving
   `lapDetectorVersion`;
3. removes the original `.bin`.

This order prevents a database row from pointing to a file that has not been
written. A crash can leave both files; orphan cleanup removes the unreferenced
one on a later pass.

`compressOrphanFile()` uses the same gzip format but does not update the
database.

Readers detect `.gz` and decompress the original recorder byte stream before
parsing. Compression does not change frame layout.

Published bundles and their retained sources, plus queued/active split work, are
excluded from recompression. Archive publication does not retire or reclaim
the monolithic recording.


## Empty sessions

`deleteEmptySessions()` selects session rows with zero laps. It removes each
associated raw file when possible, then deletes the rows. At startup there is no
active session to exclude; callers outside startup can pass `activeSessionId`.

## Orphan cleanup

`cleanupOrphanSessionFiles()` inventories source, manifest, archive, legacy
chunk, and split-job references. It scans ordinary capture files and controlled
`session-<id>/<jobId>-<attemptId>-<revision>/` bundle paths under game/ownership
folders without following symlink directories.

Unreferenced capture files and superseded bundle data/manifests are eligible for
removal. Active staging directories protect all their children; published
archives survive even when their monolith is missing. A broken referenced
manifest protects its directory's unknown members for recovery. Unrelated
filenames inside attempt directories are not removed.

Unreadable or concurrently removed files are skipped.

## Operational boundaries

- Active recordings are not compressed or deleted.
- Background compression leaves recordings newer than 24 hours untouched.
- User-triggered compression can process every uncompressed file immediately.
- `test/artifacts/` is outside production session storage and is never scanned.
- Manually placing a file under `<DATA_DIR>/sessions/` without a database row
  makes it eligible for orphan removal. Use `test/artifacts/` for fixtures.

Intervals and age thresholds are code constants, not user settings.
