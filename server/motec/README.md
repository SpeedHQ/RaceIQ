# MoTeC

## Purpose

Parses MoTeC i2 `.ld` logs and optional `.ldx` beacon sidecars, selects a game-specific transcoder, and sends the resulting session capture through the normal capture-import pipeline. Imported sessions retain the shared `motec` source marker.

## Structure

- `ld.ts` reads fixed-width log metadata, channel descriptors, and sample arrays.
- `ldx.ts` extracts and normalizes lap-beacon times.
- `targets.ts` registers verified game-specific transcoders and exposes import target metadata.
- `import.ts` is the domain entry point for parsing, transcoding, persistence, and import results.
- `types.ts` defines the parser-to-transcoder result and car/track contracts.

## Boundaries and invariants

`.ld` is a container, not a game-neutral channel schema. Only a transcoder verified against that game's export may be registered. Parsing retains header and channel metadata and decodes samples using the file's scaling fields; rate correction changes only the derived `effectiveFreq`. `.ldx` times are converted from microseconds to seconds, deduplicated, and sorted. Missing or empty beacons mean one unsplit stint.

Game-specific channel mapping and capture synthesis stay under `server/games/<game>`. This domain does not define telemetry meaning, capture framing, lap detection, database schema, or HTTP routes; it calls those owners through their existing entry points. Caller-supplied car and track ordinals remain authoritative over log-header hints.

Transcoders declare the effective path inputs, channel treatment, source cadence, and missing channels they actually used. Imported-source verification identifies the original log, while canonical RaceIQ capture integrity remains a separate retained fact.

## Testing

`test/motec-import.test.ts` covers LD metadata and samples, malformed input, effective-rate correction, LDX beacons, car/track resolution, synthesis, and database import behavior. `test/motec-viz.test.ts` checks reconstructed paths against known track geometry. Binary fixtures should be compared byte-for-byte when parser or synthesis boundaries change.
