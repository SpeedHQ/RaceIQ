# Session storage maintenance

RaceIQ keeps retained raw session recordings under the configured recording
directory, defaulting to `<DATA_DIR>/sessions/<gameId>/`, with `own` and `others`
ownership folders. `sessions.rawFile` continues to identify the retained source.
Published per-lap files have a separate manifest reference; historical session bundles also have an archive reference until migrated.

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

## Published per-lap files

New splits publish an immutable session attempt directory containing manifest v3
`manifest.json` and one physical sparse `.bin` file per persisted lap. Auxiliary
`.bin` files preserve source data outside lap ownership windows. Detector lap
numbers, including zero, are preserved.

DB layout version 1 stores `captureManifestFile` as the JSON path and leaves
`captureArchiveFile` null. Replay/export read the selected physical file, not a
virtual member of a session archive. Publication syncs and verifies all files,
renames the complete attempt, then commits fenced session/lap references.
Startup fences interrupted attempts and removes unpublished output only when
no published reference owns it.

Historical layout-2 / manifest-v4 bundles remain readable until startup consent
migrates them from their retained canonical source. The atomic switch preserves
old references on failure. Missing retained sources prevent rebuilding; server
diagnostics report the prerequisite and existing bundles remain intact.

Cleanup enumerates physical paths from the manifest and preserves referenced
files. Relocation moves the complete attempt directory and updates the manifest
DB path; relative lap paths do not need rewriting. Old archive readers and
reference-aware cleanup remain available during migration.


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

Published lap files and their retained sources, plus queued/active split work, are
excluded from recompression. Split publication does not retire or reclaim
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
