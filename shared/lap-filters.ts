import type { LapMeta } from "./types";

/**
 * Laps that are part of a pit cycle (outlap / inlap / pit lap) carry no tuning
 * signal — cold tyres, fuel-flow transients, pit-limiter running. The tuning
 * review surfaces exclude them outright: not listed, not counted, not averaged.
 *
 * The reason strings are produced by `classifyAccPitLap` in
 * `server/acc-lap-rules.ts` and stored on `invalidReason`.
 *
 * Shared (not client-only) because the server-side auto-exclude reconciliation
 * (`server/tuning-auto-exclude.ts`) applies the same pit-cycle rule.
 */
export const PIT_CYCLE_REASONS = ["outlap", "inlap", "pit lap"] as const;

/**
 * The pit-cycle reason vocabulary, as a type. `classifyAccPitLap` returns this
 * rather than a bare string union of its own, so the producer and the
 * consumers cannot drift: renaming a reason here is a compile error at every
 * site that names one, instead of a silent reclassification.
 *
 * This matters because a pit lap that slips through reads as a clean lap and
 * gets fed into the racing-line spread, where cold tyres and a pit-limiter
 * run poison the result without ever looking obviously wrong.
 */
export type PitCycleReason = (typeof PIT_CYCLE_REASONS)[number];

const PIT_CYCLE_REASON_SET: ReadonlySet<string> = new Set(PIT_CYCLE_REASONS);

export function isPitCycleLap(lap: Pick<LapMeta, "invalidReason">): boolean {
  return lap.invalidReason != null && PIT_CYCLE_REASON_SET.has(lap.invalidReason);
}
