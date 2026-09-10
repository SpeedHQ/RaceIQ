import { run } from "mitata";

// Keep enough samples for stable comparisons without forcing each benchmark
// through long allocation-heavy runs. Pipeline benchmarks already exercise
// their detector state with bounded synthetic laps.
const BENCHMARK_OPTIONS = {
  min_samples: 10,
  max_samples: 20,
  batch_samples: 5,
  min_cpu_time: 100_000_000,
};

export async function runMitataBenchmarks(outputPath: string): Promise<void> {
  const results = await run({ throw: true, ...BENCHMARK_OPTIONS });
  const slim = JSON.parse(JSON.stringify(results, function (key, value) {
    if (key === "ticks") return undefined;
    if (key === "samples" && !(this && typeof this === "object" && "p50" in this && "min" in this && "max" in this)) return undefined;
    return value;
  }));
  await Bun.write(outputPath, JSON.stringify(slim, null, 2));
}
