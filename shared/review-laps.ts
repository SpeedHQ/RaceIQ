/**
 * Review lap curation. The Track Focus review analyses a stint's telemetry
 * across laps (racing-line spread, per-frame consistency, tyres). At full rate
 * that scales with laps × lap-length — a long track (Nordschleife ~42k
 * frames/lap) at many laps would decode gigabytes and ship a huge trace
 * payload. So the per-frame heavy paths (server /line-spread + client
 * useStintTraces) operate on a curated subset: the N fastest clean laps. The
 * driver can record as many laps as they like; the review curates the best few.
 *
 * Lap-time-based stats (consistency %, degradation slope) still run over the
 * FULL stint — they're cheap (lap-time math, no frame decode) and degradation
 * genuinely needs every lap.
 */
export const REVIEW_LAP_CAP = 5;

/** The `n` fastest laps by lap time. Input is expected to be pre-filtered to
 *  clean/eligible laps; this only ranks + trims. */
export function fastestLaps<T extends { lapTime: number }>(laps: T[], n: number = REVIEW_LAP_CAP): T[] {
  return [...laps].sort((a, b) => a.lapTime - b.lapTime).slice(0, n);
}
