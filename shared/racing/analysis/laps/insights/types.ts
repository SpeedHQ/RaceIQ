import type { AccelReference } from "../time-loss";

export type InsightCategory = "suspension" | "tires" | "driving" | "mechanical";
export type InsightSeverity = "info" | "warning" | "critical";

export interface LapInsight {
  id: string;
  category: InsightCategory;
  severity: InsightSeverity;
  label: string;
  detail: string;
  frameIndices: number[];
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
}

export function groupEvents(flags: boolean[], minFrames: number, mergeGap = 0): [number, number][] {
  // Runs separated by fewer than mergeGap false frames are merged before the
  // minFrames filter, so a flickering signal counts as one event, not several.
  const runs: [number, number][] = [];
  let start = -1;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i]) {
      if (start === -1) start = i;
    } else {
      if (start !== -1) runs.push([start, i - 1]);
      start = -1;
    }
  }
  if (start !== -1) runs.push([start, flags.length - 1]);

  const merged: [number, number][] = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && run[0] - last[1] - 1 <= mergeGap) {
      last[1] = run[1];
    } else {
      merged.push([run[0], run[1]]);
    }
  }
  return merged.filter(([s, e]) => e - s + 1 >= minFrames);
}

export function midFrame(events: [number, number][]): number[] {
  return events.map(([s, e]) => Math.round((s + e) / 2));
}
