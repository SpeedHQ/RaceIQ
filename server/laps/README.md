# Laps

## Purpose

Owns portable lap-session archives. `archive.ts` builds ZIP exports from persisted raw capture ranges, names downloads, and imports capture members through the normal session-capture pipeline.

## Structure

- `archive.ts` — public archive manifest types, ZIP builder, filename builder, and ZIP importer.

## Boundaries and invariants

- Database queries provide lap metadata and raw capture locations; this domain does not own persistence.
- Session-capture framing and import code remains authoritative for frame encoding, compression, parsing, and lap detection.
- Game modules remain authoritative for game identification and iRacing session-frame handling.
- Archive layout stays `manifest.json` plus `<gameId>-<track>-session<id>.bin.gz` members. Version 3 exports authenticate exact member inventory, capture checksums, and source-generation metadata. Readers accept released version 2, version 1, and manifestless archives with legacy source-fidelity behavior; any present malformed manifest is rejected. Member naming, sorted import order, compression, and extra lap-trigger frame remain compatibility contracts.
- Imports create new sessions without duplicate merging and replay captures through current parser, detector, and quality code while preserving available source and transport provenance.
- Missing or unusable raw captures are skipped during export; an export fails when none remain.

## Testing

Exercise exports containing one session, multiple sessions, non-adjacent laps, gzip and plain raw captures, and iRacing slices requiring a session prefix. Check exact member names and manifest fields, then import the archive through `importLapsZip` and confirm capture order, skip counts, errors, and detected laps.
