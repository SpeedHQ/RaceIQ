import { run } from "mitata";

/** Unchanged nanosecond statistics produced by Mitata's measure API. */
export interface MitataStatistics {
  kind: "fn" | "iter" | "yield";
  debug: string;
  ticks: number;
  samples: number[];
  min: number;
  max: number;
  avg: number;
  p25: number;
  p50: number;
  p75: number;
  p99: number;
  p999: number;
  counters?: object;
  gc?: { avg: number; min: number; max: number; total: number };
  heap?: { avg: number; min: number; max: number; total: number };
}

export interface MitataBenchmarkResults {
  context: {
    now: number;
    arch: string | null;
    runtime: string | null;
    cpu: { freq: number; name: string | null };
    noop: { fn: MitataStatistics; iter: MitataStatistics };
  };
  benchmarks: {
    alias: string;
    baseline: boolean;
    args: Record<string, unknown[]>;
    kind: "args" | "static" | "multi-args";
    style: { compact: boolean; highlight: false | string };
    runs: { name: string; args: Record<string, unknown>; stats?: MitataStatistics; error?: unknown }[];
  }[];
}

/** Write compact run output and return Mitata's unchanged results to callers. */
export async function runMitataBenchmarks(outputPath: string): Promise<MitataBenchmarkResults> {
  const results = await run({ throw: true });
  const slim = JSON.parse(JSON.stringify(results, function (key, value) {
    if (key === "ticks") return undefined;
    if (key === "samples" && !(this && typeof this === "object" && "p50" in this && "min" in this && "max" in this)) return undefined;
    return value;
  }));
  await Bun.write(outputPath, JSON.stringify(slim, null, 2));
  return results;
}
