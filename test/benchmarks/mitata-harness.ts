import { memoryUsage } from "bun:jsc";
import { measure, run } from "mitata";
import { B } from "mitata/src/main.mjs";

// Mitata's run options do not reach measurement tuning. Keep every benchmark on
// the same warmup/sample policy, including async storage benchmarks.
const BENCHMARK_OPTIONS = {
  min_samples: 10,
  max_samples: 30,
  batch_samples: 10,
  min_cpu_time: 50_000_000,
};

type BenchmarkInternal = {
  _args: Record<string, unknown[]>;
  _name: string;
  _group: number;
  _gc: string | boolean;
  _highlight: unknown;
  flags: number;
  f: unknown;
};
interface BenchmarkPrototype {
  run: (throwOnError?: boolean) => Promise<unknown>;
}

// Mitata does not expose B's runtime prototype contract.
const benchmarkPrototype = B.prototype as unknown as BenchmarkPrototype;
benchmarkPrototype.run = async function (this: BenchmarkInternal, throwOnError = false) {
  if (Object.keys(this._args).length !== 0) {
    throw new Error("Parametric benchmarks are not supported by the RaceIQ Mitata harness");
  }

  const tuning: Record<string, unknown> = {
    inner_gc: this._gc === "inner",
    gc: !this._gc ? false : undefined,
    heap: () => memoryUsage().current,
    ...BENCHMARK_OPTIONS,
  };
  const baseline = !!(this.flags & 0x1);
  const style = { highlight: this._highlight, compact: !!(this.flags & 0x2) };
  let stats: unknown;
  let error: unknown;
  try {
    stats = await measure(this.f as Parameters<typeof measure>[0], tuning as unknown as Parameters<typeof measure>[1]);
  } catch (caught) {
    error = caught;
    if (throwOnError) throw caught;
  }
  return {
    kind: "static",
    args: this._args,
    alias: this._name,
    group: this._group,
    baseline,
    runs: [{ stats, error, args: {}, name: this._name }],
    style,
  };
};

export async function runMitataBenchmarks(outputPath: string): Promise<void> {
  const results = await run();
  const slim = JSON.parse(JSON.stringify(results), (key, value) => (key === "samples" || key === "ticks" ? undefined : value));
  await Bun.write(outputPath, JSON.stringify(slim, null, 2));
}
