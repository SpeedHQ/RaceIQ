import { gcAndSweep } from "bun:jsc";
import { measure, run } from "mitata";
import { B } from "mitata/src/main.mjs";

const BENCHMARK_OPTIONS = {
  min_samples: 20,
  max_samples: 40,
  batch_samples: 10,
  min_cpu_time: 1_000_000_000,
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

type RetainedHeapCallback = () => unknown | Promise<unknown>;
type RetainedHeapStats = {
  p50: number;
  min: number;
  max: number;
  samples: number[];
};

const retainedHeapCallbacks = new Map<string, RetainedHeapCallback>();
let retainedHeapRoot: unknown;

function retainedHeapKey(group: string, alias: string): string {
  return `${group}/${alias}`;
}

export function registerRetainedHeapBenchmark(group: string, alias: string, create: RetainedHeapCallback): void {
  const key = retainedHeapKey(group, alias);
  if (retainedHeapCallbacks.has(key)) {
    throw new Error(`Duplicate retained-heap benchmark registration: ${key}`);
  }
  retainedHeapCallbacks.set(key, create);
}

async function measureRetainedHeap(create: RetainedHeapCallback): Promise<RetainedHeapStats> {
  await create();
  const samples: number[] = [];
  let attempts = 0;
  while (samples.length < 7) {
    attempts += 1;
    retainedHeapRoot = undefined;
    gcAndSweep();
    const baseline = gcAndSweep();
    const created = await create();
    retainedHeapRoot = created;
    gcAndSweep();
    const liveHeap = gcAndSweep();
    const delta = liveHeap - baseline;
    retainedHeapRoot = undefined;
    gcAndSweep();
    if (!Number.isFinite(delta) || delta < 0) {
      if (attempts >= 100) {
        throw new Error(`Invalid retained-heap delta after 100 attempts: ${delta}`);
      }
      continue;
    }
    samples.push(delta);
  }
  return {
    p50: [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)],
    min: Math.min(...samples),
    max: Math.max(...samples),
    samples,
  };
}

const benchmarkPrototype = B.prototype as unknown as BenchmarkPrototype;
benchmarkPrototype.run = async function (this: BenchmarkInternal, throwOnError = false) {
  if (Object.keys(this._args).length !== 0) {
    throw new Error("Parametric benchmarks are not supported by the RaceIQ Mitata harness");
  }

  const tuning: Record<string, unknown> = {
    inner_gc: this._gc === "inner",
    gc: !this._gc ? false : undefined,
    heap: false,
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
  for (const [key, create] of retainedHeapCallbacks) {
    const [, alias] = key.split("/", 2);
    const matching = results.benchmarks.filter((candidate) => candidate.alias === alias);
    const benchmark = matching.length === 1 ? matching[0] : undefined;
    if (!benchmark || !benchmark.runs[0]?.stats) {
      throw new Error(`Retained-heap benchmark result not found: ${key}`);
    }
    (benchmark.runs[0].stats as unknown as Record<string, unknown>).retainedHeap = await measureRetainedHeap(create);
  }
  const slim = JSON.parse(JSON.stringify(results, function (key, value) {
    if (key === "ticks") return undefined;
    if (key === "samples" && !(this && typeof this === "object" && "p50" in this && "min" in this && "max" in this)) {
      return undefined;
    }
    return value;
  }));
  await Bun.write(outputPath, JSON.stringify(slim, null, 2));
}
