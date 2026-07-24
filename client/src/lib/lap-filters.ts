import type { LapMeta } from "../../../shared/types";

/**
 * Laps that are part of a pit cycle (outlap / inlap / pit lap) carry no tuning
 * signal — cold tyres, fuel-flow transients, pit-limiter running. The tuning
 * review surfaces exclude them outright: not listed, not counted, not averaged.
 *
 * The reason strings are produced by `classifyAccPitLap` in
 * `server/acc-lap-rules.ts` and stored on `invalidReason`.
 */
const PIT_CYCLE_REASONS = new Set(["outlap", "inlap", "pit lap"]);

export function isPitCycleLap(lap: Pick<LapMeta, "invalidReason">): boolean {
  return lap.invalidReason != null && PIT_CYCLE_REASONS.has(lap.invalidReason);
}
