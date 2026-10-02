# Session storage maintenance

RaceIQ keeps raw session recordings under `<DATA_DIR>/sessions/<gameId>/`.
Database rows in `sessions.rawFile` point to the active `.bin` or compressed
`.bin.gz` file.

Maintenance has three responsibilities:

1. delete empty database sessions at startup;
2. compress completed recordings;
3. remove unreferenced recording files.

All destructive background work stops while `isSessionActive()` is true.

## Startup and schedule

`server/index.ts` runs:

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

## Empty sessions

`deleteEmptySessions()` selects session rows with zero laps. It removes each
associated raw file when possible, then deletes the rows. At startup there is no
active session to exclude; callers outside startup can pass `activeSessionId`.

## Orphan cleanup

`cleanupOrphanSessionFiles()` builds a set of every referenced
`sessions.rawFile`, then scans game directories under `<DATA_DIR>/sessions/`.
It removes:

- uncompressed `.bin` files of 12 bytes or less (header only);
- `.bin` or `.bin.gz` files with no owning database row.

Unreadable or concurrently removed files are skipped.

## Operational boundaries

- Active recordings are not compressed or deleted.
- Background compression leaves recordings newer than 24 hours untouched.
- User-triggered compression can process every uncompressed file immediately.
- `test/artifacts/` is outside production session storage and is never scanned.
- Manually placing a file under `<DATA_DIR>/sessions/` without a database row
  makes it eligible for orphan removal. Use `test/artifacts/` for fixtures.

Intervals and age thresholds are code constants, not user settings.
