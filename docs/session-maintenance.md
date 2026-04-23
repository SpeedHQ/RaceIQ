# Session Maintenance

Two subsystems keep `data/sessions/` and the `sessions` table tidy:

1. **Compression** — gzips old `.bin` files into `.bin.gz` to reclaim disk.
2. **Orphan deletion** — removes empty session rows + their files, and any recording files not referenced by a session row.

Both share `runMaintenance()` in `server/session-compressor.ts`, which fires immediately on server boot and every 5 minutes thereafter. Both early-return when `isSessionActive()` is true so a live recorder is never disturbed.

## File layout

```
data/
  sessions/
    fm-2023/
      2026-04-21T20-53-41-119Z.bin
      2026-04-22T00-12-08-771Z.bin.gz
    f1-2025/...
    acc/...
    ac-evo/...
```

Each session writes one `.bin` (raw UDP packets / packed shared-memory triplets, length-prefixed). A session row carries `rawFile = <absolute path>` once recording starts. If the file is missing or the row goes away, the other side becomes orphaned.

## Schedule

| Step | When | Function |
|---|---|---|
| Empty-session prune | Once at boot | `deleteEmptySessions()` |
| Background compression | Compressor start, then every 5 min | `runCompression(false)` |
| Orphan sweep | Compressor start, then every 5 min | `cleanupOrphanSessionFiles()` |
| User-triggered compression | Settings → "Compress now" | `runUserCompressionNow()` |

Wire-up:

```
server/index.ts boot:
  → deleteEmptySessions()          (one-shot)
  → startSessionCompressor()
       → runMaintenance() now + every 5 min:
            → runCompression(false)
            → cleanupOrphanSessionFiles()
```

---

# Compression

`server/session-compressor.ts`.

## Format

`.bin` is append-only `[uint32 LE byte-length][N raw bytes]` records, prefixed by a 12-byte meta header. `.bin.gz` is the same byte stream gzipped whole. Readers (`readAccFrames`, `reprocessSession`) detect the `.gz` suffix and gunzip on demand.

## Atomicity

Three steps, ordered for safe failure:

1. Write `.bin.gz` first.
2. Update `sessions.rawFile` to point at the `.gz`.
3. `unlinkSync` the original `.bin`.

A crash between step 1 and 2 leaves both files; next pass overwrites the partial `.gz`. A crash between step 2 and 3 leaves an orphan `.bin`; next orphan sweep removes it.

## Background pass — `runCompression(false)`

```
getUncompressedSessions(ONE_DAY_MS)
  → SQL: rawFile IS NOT NULL AND rawFile NOT LIKE '%.gz' AND createdAt < cutoff
  → for each: compressSession(id, rawFile)
```

The 24h age gate guards against compressing a `.bin` that was just finalised seconds ago.

## User-triggered pass — `runUserCompressionNow()`

```
getUncompressedSessions(0)            // all DB candidates, no age gate
findUncompressedFilesOnDisk()         // walk data/sessions/<gameId>/*.bin
orphanPaths = disk \ dbPaths          // .bin files with no matching row
  → compressSession() for DB candidates
  → compressOrphanFile() for orphans
```

`compressOrphanFile()` writes `.bin.gz`, removes `.bin`, **does not touch the DB** (no row to update).

The filesystem sweep is user-only because the background pass may race finalised-but-not-yet-flushed sessions. User clicks are explicit, so the broader sweep is safe.

## `compressSession(id, binPath)`

```ts
const data = await Bun.file(binPath).arrayBuffer();
const compressed = await gzipAsync(Buffer.from(data));
await Bun.write(binPath + ".gz", compressed);
const row = await db.select({ lapDetectorVersion }).from(sessions).where(eq(sessions.id, id)).get();
await updateSessionRawFile(id, gzPath, row?.lapDetectorVersion ?? "");
unlinkSync(binPath);
```

`updateSessionRawFile` preserves `lapDetectorVersion` so the stale-detection prompt doesn't fire on a freshly compressed session.

---

# Orphan Deletion

Two functions, two passes. Both delete data — guarded by `isSessionActive()`.

## `deleteEmptySessions()` — `server/db/queries.ts`

Runs once at boot.

```sql
SELECT id, rawFile FROM sessions s
LEFT JOIN laps l ON l.sessionId = s.id
GROUP BY s.id HAVING COUNT(l.id) = 0
```

For each row returned (excluding `activeSessionId` if supplied):

1. `unlinkSync(rawFile)` if the file exists. Failures logged + ignored — file may already be gone or compressed.
2. `DELETE FROM sessions WHERE id IN (...)`.

A session with no completed laps has no replayable lap data, no analysis target, no comparison value.

## `cleanupOrphanSessionFiles()` — `server/session-cleanup.ts`

Runs on compressor start + every 5 min.

Single early return on `isSessionActive()`. Otherwise:

- Build a `Set<string>` of every `sessions.rawFile` value.
- Walk `data/sessions/<gameId>/`. For each `.bin` / `.bin.gz`, delete if **either**:
  - It's a `.bin` ≤ 12 bytes (header-only, no packets recorded), OR
  - It's not present in the referenced set (no owning row).

Catches files left over from `.gz`-renamed compressions where the original `.bin` failed to unlink, files whose owning session row was deleted manually, and historical files from before `deleteEmptySessions` started unlinking.

---

## Logging

```
[DB] Cleaned up 3 empty session(s)
[Compressor] Compressing 9 session(s), 4 orphan file(s)…
[Compressor] data/sessions/f1-2025/2026-04-21T20-23-43-816Z.bin → ...gz (13280KB → 1740KB)
[Compressor] (orphan) data/sessions/fm-2023/legacy.bin → ...gz (1024KB → 230KB)
[Compressor] All sessions already compressed
[Cleanup] Removed 13 orphan session file(s)
```

No-op runs print nothing so a clean steady state stays quiet.

## Tunables

`INTERVAL_MS = 5 * 60 * 1000` and `ONE_DAY_MS = 24 * 60 * 60 * 1000` in `session-compressor.ts`. Not exposed via `settings.json` — defaults match user expectations.

## What never gets touched

- Active recordings — `isSessionActive()` early-returns in both subsystems.
- `.bin` files newer than 24h on the background compression pass.
- Files that fail to read or unlink (logged, skipped, retried next pass).
- `test/artifacts/sessions/` — outside `data/sessions/`, never scanned.

## Edge cases

- **Manually-staged `.bin` files**: dropping a `.bin` into `data/sessions/<gameId>/` without inserting a session row gets wiped within 5 minutes by the orphan sweep. Use `test/artifacts/sessions/` for staging.
