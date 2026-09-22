import type { AccelReference } from "../time-loss";
import type { AllWheelStates } from "../physics/vehicle";
import type { LapPathPoint } from "../../../tracks/path";
import type { TelemetryPacket } from "../../../../telemetry/types";

export type InsightCategory = "suspension" | "tires" | "driving" | "mechanical";
export const RACING_LINE_SEMANTIC_ID = "track.racing-line" as const;

export type RacingLineReference =
  | {
      semanticId: typeof RACING_LINE_SEMANTIC_ID;
      source: "track-data";
      points: readonly LapPathPoint[];
    }
  | {
      semanticId: typeof RACING_LINE_SEMANTIC_ID;
      source: "unavailable";
      reason: "missing-track-identity" | "missing-track-data";
    };

export interface LapAnalysisContext {
  racingLine: RacingLineReference;
}

export type InsightSeverity = "info" | "warning" | "critical";

export interface LapInsight {
  id: string;
  category: InsightCategory;
  severity: InsightSeverity;
  label: string;
  detail: string;
  frameIndices: number[];
  /** Native intervention is observed; inferred modulation is not confirmation. */
  evidenceSource?: "native" | "inferred";
  /**
   * Conservative estimate of the seconds this fault cost, when one can be
   * defended (see `time-loss.ts`). Absent means "not quantified", which is not
   * the same as zero — most detectors describe a symptom whose cost is already
   * counted by whichever quantified detector it causes.
   *
   * Never sum these into a lap total: detectors overlap in time.
   */
  timeLossS?: number;
}

export interface TimeLossCtx {
  dt: number[];
  ref: AccelReference;
  wheelStates?: readonly AllWheelStates[];
}

/** Evidence duration per sample. Unknown time never supplies positive evidence. */
export function eventDurations(telemetry: readonly TelemetryPacket[]): number[] {
  const dt = new Array<number>(telemetry.length).fill(0);
  for (let i = 0; i < telemetry.length - 1; i++) {
    const seconds = (telemetry[i + 1].TimestampMS - telemetry[i].TimestampMS) / 1000;
    if (Number.isFinite(seconds) && seconds > 0 && seconds <= 0.1) dt[i] = seconds;
  }
  return dt;
}

export function eventSeconds(dt: readonly number[], start: number, end: number, flags?: readonly boolean[]): number {
  let seconds = 0;
  for (let i = start; i <= end; i++) {
    if (dt[i] > 0 && (!flags || flags[i])) seconds += dt[i];
  }
  return seconds;
}

export function groupEvents(flags: readonly boolean[], dt: readonly number[], minSeconds: number, mergeGapSeconds = 0): [number, number][] {
  const events: [number, number][] = [];
  let start = -1;
  let end = -1;
  let active = 0;
  let gap = 0;
  const flush = () => {
    if (start >= 0 && active + 1e-9 >= minSeconds) events.push([start, end]);
    start = -1;
    active = 0;
    gap = 0;
  };
  for (let i = 0; i < flags.length; i++) {
    if (!(dt[i] > 0) || !Number.isFinite(dt[i])) {
      flush();
    } else if (flags[i]) {
      if (start < 0) start = i;
      end = i;
      active += dt[i];
      gap = 0;
    } else if (start >= 0) {
      gap += dt[i];
      if (gap > mergeGapSeconds + 1e-9) flush();
    }
  }
  flush();
  return events;
}

export function midFrame(events: [number, number][]): number[] {
  return events.map(([s, e]) => Math.round((s + e) / 2));
}
