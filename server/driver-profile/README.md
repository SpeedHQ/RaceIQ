# Driver profile

## Purpose

Build deterministic, game-scoped driver fingerprints from stored laps and generate a short AI trend summary. This domain owns detector rollups, physics-style axes, normalized trend windows, prompt construction, and profile-run orchestration.

## Structure

- `load.ts` loads the newest usable telemetry and aligns metadata, insights, and style summaries.
- `detectors.ts` aggregates per-lap findings and derives ranked weaknesses and style axes.
- `trend.ts` normalizes pace within game/car/track contexts and compares recent and previous windows.
- `fingerprint.ts` assembles the stable persisted fingerprint contract.
- `prompt.ts` renders deterministic trend evidence for the summarizer.
- `runner.ts` handles provider setup, deduplication, stale-result rejection, persistence, and background batching.
- `math.ts` contains shared deterministic numeric helpers.

## Boundaries and invariants

Fingerprints are global to one selected game. Trend input is newest-first; detector results remain paired with lap metadata before deterministic lap-id sorting. Missing measurements stay `null`, detector frequencies are per-lap, and unquantified weaknesses remain separate from time-loss rankings. Prompt text contains trend evidence only. Runner writes a result only when its lap-pool key is still current and no newer successful run exists.

Database access, telemetry decoding, AI providers, settings, and HTTP routing stay outside this domain's pure calculation modules.

## Testing

Pure aggregation and trend contracts are covered in `test/driver-profile-aggregate.test.ts`; prompt shape and evidence restrictions are covered in `test/driver-profiler-prompt.test.ts`. Runner changes should additionally cover pool-key deduplication, background batching, stale-result rejection, provider failure, and persistence payloads.
