# Tracks

## Purpose

Resolve a game and track ordinal into shared track metadata, and align bundled track geometry with recorded game coordinates. This domain owns process-local calibration state and exposes track information to server callers.

## Structure

- `info.ts` is the track-resolution entry point. `resolveTrack` returns names, facts, game geometry, labelled segments, sectors, and lazy outline/length accessors.
- `calibration.ts` collects driven positions, computes live or static Procrustes transforms, refines static alignment with curb anchors, and transforms bundled geometry into source coordinates.

## Boundaries and invariants

- Track slugs come from server game adapters; facts, geometry, sectors, outlines, and names remain owned by shared track-data and car-data modules.
- Resolution preserves the fallback chain: game-specific geometry, ordinal sectors, then thirds; display names fall back to the game roster name.
- Calibration caches are keyed by track ordinal and live for the server process. Live calibration takes precedence over static alignment; cache clearing removes static and curb-refinement state together.
- Sampling thresholds, arc-length correspondence, offset search, curb weighting, transform direction, and returned coordinate/name values are behavior contracts.

## Testing

Cover track resolution with known and unknown game/ordinal combinations, including lazy outline access. For calibration changes, compare transforms and projected points against fixed position, outline, and curb fixtures; also cover live-over-static precedence and cache clearing.
