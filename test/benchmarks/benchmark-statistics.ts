import { percentileSorted } from "../../server/experiments/statistics";

export type HierarchicalPair = {
  base: readonly (readonly number[])[];
  current: readonly (readonly number[])[];
};

export type RelativeEstimate = {
  estimatePct: number;
  ci95: [number, number];
  marginPct: number;
};

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function resample<T>(values: readonly T[], rand: () => number): T[] {
  return Array.from({ length: values.length }, () => values[Math.floor(rand() * values.length)]!);
}

function sideMedian(groups: readonly (readonly number[])[], rand?: () => number): number {
  const sampledGroups = rand ? resample(groups, rand).map((group) => resample(group, rand)) : groups;
  return median(sampledGroups.map((group) => median(group)));
}

function pairLogRatio(pair: HierarchicalPair, rand?: () => number): number | null {
  const base = sideMedian(pair.base, rand);
  const current = sideMedian(pair.current, rand);
  if (!(base > 0) || !(current > 0)) return null;
  return Math.log(current / base);
}

export function pairedHierarchicalMedianChange(
  pairs: readonly HierarchicalPair[],
  options?: { bootstrapSamples?: number; seed?: number },
): RelativeEstimate | null {
  if (pairs.length === 0 || pairs.some((pair) => pair.base.length === 0 || pair.current.length === 0 || pair.base.some((group) => group.length === 0) || pair.current.some((group) => group.length === 0))) return null;
  const pointRatios = pairs.map((pair) => pairLogRatio(pair));
  if (pointRatios.some((ratio) => ratio === null)) return null;
  const estimatePct = (Math.exp(median(pointRatios as number[])) - 1) * 100;
  const bootstrapSamples = options?.bootstrapSamples ?? 10_000;
  if (!Number.isInteger(bootstrapSamples) || bootstrapSamples <= 0) return null;
  const rand = mulberry32(options?.seed ?? 0x5eed1234);
  const bootstrap: number[] = [];
  for (let index = 0; index < bootstrapSamples; index += 1) {
    const sampledPairs = resample(pairs, rand);
    const ratios = sampledPairs.map((pair) => pairLogRatio(pair, rand));
    if (ratios.some((ratio) => ratio === null)) return null;
    bootstrap.push((Math.exp(median(ratios as number[])) - 1) * 100);
  }
  bootstrap.sort((a, b) => a - b);
  const lower = percentileSorted(bootstrap, 0.025);
  const upper = percentileSorted(bootstrap, 0.975);
  return { estimatePct, ci95: [lower, upper], marginPct: (upper - lower) / 2 };
}
