# Track calibration

RaceIQ aligns a known track outline with simulator source coordinates so live telemetry can be projected onto the outline. Implementation lives in `server/tracks/calibration.ts` and is consumed by the live telemetry pipeline.

## State and lifecycle

- Live calibration is process-local, keyed by track ordinal. It is not persisted.
- A session reset clears the live calibration state. A static transform cache remains available as fallback.
- Static transforms map the external TUMFTM center line into recorded source space.
- Each accepted fit records scale, rotation, translation, RMSE, point count, lap number, and sequence. History is bounded to the latest 12 fits.
- Curb refinement is tracked per track ordinal to avoid repeating refinement work.

## Fit requirements

Calibration samples retain normalized lap progress and lap number. Samples are spatially downsampled with a 5 m minimum separation; zero/non-finite positions are discarded before fitting. A fit requires at least 50 spatially distinct points and a closed-lap coverage window near both progress endpoints.

The fitter pairs source samples with outline positions by normalized progress. When source coverage spans at least 80% of a lap, it derives source arc progress from ordered sample distances, with long segment lengths capped at four times the median. Outline targets are interpolated at each retained progress value; sparse partial laps keep their original progress rather than being compacted to sample order.

Procrustes alignment estimates scale, rotation, and translation. Robust fitting retains the lowest-error 80% after refinement. The resulting transform is used to project source positions to outline space and to calculate track-relative progress/distance.

## Debugging and verification

Calibration behavior is covered by:

- `test/tracks/calibration.test.ts` — DB-free fit, malformed-position, sparse-progress, and partial-lap behavior.
- `test/telemetry/live-pipeline-calibration.test.ts` — live pipeline lifecycle and reset/fallback behavior.

Run focused checks with:

```sh
bun test test/tracks/calibration.test.ts test/telemetry/live-pipeline-calibration.test.ts
```

Do not treat a process-local fit or its visual comparison history as durable data; restart/reload behavior must tolerate an empty live history and use static fallback where available.
