# Laps

## Purpose

Owns portable lap-session archives. `archive.ts` builds ZIP exports from persisted raw capture ranges, names downloads, and imports capture members through the normal session-capture pipeline.

## Structure

- `archive.ts` — public archive manifest types, ZIP builder, filename builder, and ZIP importer.

## Boundaries and invariants

- Database queries provide lap metadata and raw capture locations; this domain does not own persistence.
- Session-capture framing and import code remains authoritative for frame encoding, compression, parsing, and lap detection.
- Game modules remain authoritative for game identification and iRacing session-frame handling.
- Archive layout stays `manifest.json` plus `<gameId>-<track>-session<id>.bin.gz` members. Member naming, sorted import order, manifest formatting, compression, and the extra lap-trigger frame are compatibility contracts.
- Imports replay captures as new sessions. They do not merge duplicates or reinterpret telemetry.
- Missing or unusable raw captures are skipped during export; an export fails when none remain.

## Testing

Exercise exports containing one session, multiple sessions, non-adjacent laps, gzip and plain raw captures, and iRacing slices requiring a session prefix. Check exact member names and manifest fields, then import the archive through `importLapsZip` and confirm capture order, skip counts, errors, and detected laps.
