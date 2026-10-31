---
name: raceiq-raw-opponent-capture-analysis
description: Analyze LMU opponent telemetry directly from native recording plus companion data without reading persisted opponent-index artifacts.
---

# Raw LMU opponent capture analysis

Use when a reported lap duration or replay discontinuity may reflect capture data rather than derived processing.

1. Load the project instructions. Find the capture's `capture-manifest.json` and native opponent companion file. Read the manifest only for locating the raw source and validating source identity; do not open `.opponent-index` state or publication files when the question asks for source truth.
2. Resolve the owning session's `carId`, `trackId`, and game from the database. These inputs affect native source identity reconstruction.
3. Decode all native capture records with `iterateLmuOpponentCaptureFrames(source, { retainSourceFrames: false })` from `server/lap-analysis/lmu-opponent-laps.ts`. This reader joins raw primary records with the raw opponent companion. Do not infer telemetry from catalog summaries or stored index locators.
4. Stream observations; do not retain source-frame buffers. For each opponent identity, summarize observed-time range, sample count, lap-number/distance transitions, lap-time scalar values, source update-sequence transitions, capture-sequence deltas, and maximum adjacent timestamp step.
5. Match a URL opponent ID by hashing `sessionKey + NUL + vehicleId + NUL + incarnation + NUL + intervalStartCaptureSequence` with SHA-256. Detect interval starts from first observation and observed lap-distance wraps; validate the matched candidate against raw timestamps, lap number, and distance.
6. Separate scalar lap timing from telemetry coverage. A reported last-lap time can describe a completed lap even when capture began mid-lap. Check initial distance/lap state and captured duration through the next observed boundary.
7. Distinguish missing observations from counter resets. Counter decrease alone is not proof of a telemetry gap; compare adjacent capture sequence and observed timestamps. Continuous 200ms raw observations mean a replay hole from a reset is processing behavior, not missing recorded telemetry. Preserve actual forward update-sequence gaps and visibly disconnected long timestamp gaps.
8. Report raw record count, target identity and interval, exact start/end timestamps and distances, timing scalar, maximum timestamp step, reset/gap counts, whether the lap coverage is partial, and whether derived replay inserted false discontinuities. Clearly state if any full raw sample could not be decoded.
