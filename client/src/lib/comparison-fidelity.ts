import type { ComparisonData, ComparisonRangeData } from "@shared/racing/comparison/types";

export const MAX_FIDELITY_POINTS = 100_000;
export const HIGH_FIDELITY_STEP = 0.1 as const;

type FidelityRange = { start: number; end: number; stepMeters: typeof HIGH_FIDELITY_STEP };

export function selectFidelity(rangeMeters: number, basePointCount: number): FidelityRange | null {
  const fullDistance = Math.max(0, basePointCount - 1);
  if (!(rangeMeters > 0) || fullDistance <= 0 || rangeMeters >= fullDistance * 0.98) return null;
  return { start: 0, end: rangeMeters, stepMeters: HIGH_FIDELITY_STEP };
}

export function normalizeFidelityRange(start: number, end: number, fullDistance: number): FidelityRange {
  const low = Math.max(0, Math.min(fullDistance, Math.min(start, end)));
  const high = Math.max(low, Math.min(fullDistance, Math.max(start, end)));
  const padding = Math.max((high - low) * 0.1, HIGH_FIDELITY_STEP * 20);
  return { start: Math.max(0, low - padding), end: Math.min(fullDistance, high + padding), stepMeters: HIGH_FIDELITY_STEP };
}

function nearestIndex(distances: readonly number[], distance: number): number {
  let low = 0;
  let high = distances.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (distances[middle] < distance) low = middle + 1;
    else high = middle - 1;
  }
  return Math.min(distances.length - 1, Math.max(0, low));
}

function mergeArray(base: number[], detail: number[], distances: number[], detailDistances: number[]): number[] {
  if (detailDistances.length === 0) return base;
  const merged = base.slice();
  for (let index = 0; index < distances.length; index++) {
    const distance = distances[index];
    if (distance < detailDistances[0] || distance > detailDistances.at(-1)!) continue;
    merged[index] = detail[Math.min(nearestIndex(detailDistances, distance), detail.length - 1)];
  }
  return merged;
}

export function cropComparisonRange(range: ComparisonRangeData, start: number, end: number): ComparisonRangeData {
  const low = Math.min(start, end);
  const high = Math.max(start, end);
  const distances = range.traces.distance;
  let first = 0;
  while (first < distances.length && distances[first] < low) first += 1;
  let last = distances.length - 1;
  while (last >= first && distances[last] > high) last -= 1;
  if (first > last) {
    const nearest = Math.min(distances.length - 1, Math.max(0, first < distances.length ? first : distances.length - 1));
    first = nearest;
    last = nearest;
  }
  const traces = Object.fromEntries(
    Object.entries(range.traces).map(([key, values]) => [key, values.slice(first, last + 1)]),
  ) as ComparisonRangeData["traces"];
  return {
    ...range,
    distanceStart: traces.distance[0] ?? range.distanceStart,
    distanceEnd: traces.distance.at(-1) ?? range.distanceEnd,
    traces,
    timeDelta: range.timeDelta.slice(first, last + 1),
  };
}

export function mergeComparisonRange(base: ComparisonData, range: ComparisonRangeData): ComparisonData {
  const baseTrace = base.traces;
  const detail = range.traces;
  const merge = (values: number[], detailValues: number[]) => mergeArray(values, detailValues, baseTrace.distance, detail.distance);
  return {
    ...base,
    traces: {
      distance: baseTrace.distance,
      sourceIndicesA: merge(baseTrace.sourceIndicesA, detail.sourceIndicesA), sourceIndicesB: merge(baseTrace.sourceIndicesB, detail.sourceIndicesB),
      speedA: merge(baseTrace.speedA, detail.speedA), speedB: merge(baseTrace.speedB, detail.speedB),
      throttleA: merge(baseTrace.throttleA, detail.throttleA), throttleB: merge(baseTrace.throttleB, detail.throttleB),
      brakeA: merge(baseTrace.brakeA, detail.brakeA), brakeB: merge(baseTrace.brakeB, detail.brakeB),
      steerA: merge(baseTrace.steerA, detail.steerA), steerB: merge(baseTrace.steerB, detail.steerB),
      gearA: merge(baseTrace.gearA, detail.gearA), gearB: merge(baseTrace.gearB, detail.gearB),
      rpmA: merge(baseTrace.rpmA, detail.rpmA), rpmB: merge(baseTrace.rpmB, detail.rpmB),
      positionXA: merge(baseTrace.positionXA, detail.positionXA), positionXB: merge(baseTrace.positionXB, detail.positionXB),
      positionZA: merge(baseTrace.positionZA, detail.positionZA), positionZB: merge(baseTrace.positionZB, detail.positionZB),
      yawA: merge(baseTrace.yawA, detail.yawA), yawB: merge(baseTrace.yawB, detail.yawB),
      elapsedTimeA: merge(baseTrace.elapsedTimeA, detail.elapsedTimeA), elapsedTimeB: merge(baseTrace.elapsedTimeB, detail.elapsedTimeB),
      tireWearA: baseTrace.tireWearA && detail.tireWearA ? merge(baseTrace.tireWearA, detail.tireWearA) : baseTrace.tireWearA,
      tireWearB: baseTrace.tireWearB && detail.tireWearB ? merge(baseTrace.tireWearB, detail.tireWearB) : baseTrace.tireWearB,
    },
    timeDelta: merge(base.timeDelta, range.timeDelta),
  };
}

export function rangeComparison(base: ComparisonData, range: ComparisonRangeData): ComparisonData {
  return { ...base, traces: range.traces, timeDelta: range.timeDelta };
}
