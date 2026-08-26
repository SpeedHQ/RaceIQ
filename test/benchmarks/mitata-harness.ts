import { run } from "mitata";

const BENCHMARK_OPTIONS = {
  min_samples: 20,
  max_samples: 40,
  batch_samples: 10,
  min_cpu_time: 1_000_000_000,
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
