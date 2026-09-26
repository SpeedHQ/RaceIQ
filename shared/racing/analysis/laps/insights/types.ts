import type { AccelReference } from "../time-loss";
import type { AllWheelStates } from "../physics/vehicle";
export type Event = [number, number];

/** Incremental equivalent of groupEvents, including gap and duration rules. */
export class EventRun {
  readonly events: Event[] = [];
  acceptedSeconds = 0;
  private start = -1;
  private end = -1;
  private active = 0;
  private gap = 0;

  private readonly minSeconds: number;
  private readonly mergeGapSeconds: number;
  constructor(minSeconds: number, mergeGapSeconds = 0) {
    this.minSeconds = minSeconds;
    this.mergeGapSeconds = mergeGapSeconds;
  }

  feed(index: number, seconds: number, flag: boolean): void {
    if (!flag && this.start < 0) return;
    if (!(seconds > 0) || !Number.isFinite(seconds)) {
      this.finish();
    } else if (flag) {
      if (this.start < 0) this.start = index;
      this.end = index;
      this.active += seconds;
      this.gap = 0;
    } else if (this.start >= 0) {
      this.gap += seconds;
      if (this.gap > this.mergeGapSeconds + 1e-9) this.finish();
    }
  }

  finish(): void {
    if (this.start >= 0 && this.active + 1e-9 >= this.minSeconds) {
      this.events.push([this.start, this.end]);
      this.acceptedSeconds += this.active;
    }
    this.start = -1;
    this.active = 0;
    this.gap = 0;
  }
}
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

/** Stable output slots. Family scans emit only slots they observed; merge by order after the lap. */
export const INSIGHT_ORDER = {
  overload: 0, imbalance: 1,
  overheat: 2, coreOverheat: 3, surfaceProfile: 4, lockups: 5, wheelspin: 6,
  wearImbalance: 7, tempSplit: 8, rapidPressureLoss: 9, pressureImbalance: 10,
  absActivation: 11, tractionControlActivation: 12, unusedDrs: 13, ersDepletion: 14,
  brakeTractionLoss: 15, revLimiter: 16, coasting: 17, trailBraking: 18,
  counterSteer: 19, earlyBraking: 20, overSlowing: 21, throttleTractionLoss: 22,
  earlyThrottle: 23, binaryThrottle: 24, delayedThrottlePickup: 25,
  brakeDrag: 26, downshiftOverRev: 27, lateBrakingOvershoot: 28,
  understeerScrub: 29, oversteerSlide: 30, steeringSawing: 31,
  throttleMicroLifts: 32, kerbRiding: 33, fuel: 34, peakPower: 35, boost: 36,
} as const;

export interface OrderedInsight {
  order: number;
  insight: LapInsight;
}

export function appendInsights(output: OrderedInsight[], order: number, findings: LapInsight | readonly LapInsight[] | null | undefined): void {
  if (!findings) return;
  if (Array.isArray(findings)) {
    for (const insight of findings) output.push({ order, insight });
  } else {
    output.push({ order, insight: findings as LapInsight });
  }
}

export function insightAt(results: readonly OrderedInsight[], order: number): LapInsight | null {
  return results.find((item) => item.order === order)?.insight ?? null;
}

export function insightsAt(results: readonly OrderedInsight[], order: number): LapInsight[] {
  return results.filter((item) => item.order === order).map((item) => item.insight);
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
  const run = new EventRun(minSeconds, mergeGapSeconds);
  for (let i = 0; i < flags.length; i++) run.feed(i, dt[i], flags[i]);
  run.finish();
  return run.events;
}

export function midFrame(events: [number, number][]): number[] {
  return events.map(([s, e]) => Math.round((s + e) / 2));
}
