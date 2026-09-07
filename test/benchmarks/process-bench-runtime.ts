export type BenchmarkModule = {
  setup?: () => void | Promise<void>;
  runIteration: () => unknown | Promise<unknown>;
};

export type TimingConfig = {
  warmupNs: number;
  measurementNs: number;
  minSamples: number;
  maxSamples: number;
};

export type BenchmarkRuntime = {
  nowNs: () => number;
  gcAndSweep: () => number;
  setSink: (value: unknown) => void;
};

export type TimingChildReport = {
  warmupIterations: number;
  warmupNs: number;
  measurementNs: number;
  samplesNs: number[];
};

export type RetainedHeapChildReport = {
  deltaBytes: number;
};

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> => {
  if (typeof value !== "object" || value === null || !("then" in value)) return false;
  return typeof value.then === "function";
};

async function runOnce(module: BenchmarkModule): Promise<unknown> {
  const result = module.runIteration();
  return isPromiseLike(result) ? await result : result;
}

export async function measureTiming(
  module: BenchmarkModule,
  config: TimingConfig,
  runtime: BenchmarkRuntime,
): Promise<TimingChildReport> {
  await module.setup?.();
  const warmupStart = runtime.nowNs();
  let warmupIterations = 0;
  while (runtime.nowNs() - warmupStart < config.warmupNs) {
    await runOnce(module);
    warmupIterations += 1;
  }
  const warmupNs = runtime.nowNs() - warmupStart;
  const samplesNs: number[] = [];
  const measurementStart = runtime.nowNs();
  while (runtime.nowNs() - measurementStart < config.measurementNs || samplesNs.length < config.minSamples) {
    if (samplesNs.length >= config.maxSamples) {
      throw new Error(`Timing measurement reached maxSamples=${config.maxSamples} before meeting measurementNs=${config.measurementNs} and minSamples=${config.minSamples}`);
    }
    runtime.setSink(undefined);
    runtime.gcAndSweep();
    const start = runtime.nowNs();
    const result = await runOnce(module);
    runtime.setSink(result);
    const elapsed = runtime.nowNs() - start;
    if (!Number.isFinite(elapsed) || elapsed < 0) throw new Error("Timing sample must be finite and non-negative");
    samplesNs.push(elapsed);
  }
  const measurementNs = runtime.nowNs() - measurementStart;
  runtime.setSink(undefined);
  runtime.gcAndSweep();
  return { warmupIterations, warmupNs, measurementNs, samplesNs };
}

export async function measureRetainedHeap(
  module: BenchmarkModule,
  warmupIterations: number,
  runtime: BenchmarkRuntime,
): Promise<RetainedHeapChildReport> {
  await module.setup?.();
  for (let index = 0; index < warmupIterations; index += 1) await runOnce(module);
  runtime.setSink(undefined);
  const baseline = runtime.gcAndSweep();
  runtime.setSink(await runOnce(module));
  const live = runtime.gcAndSweep();
  const deltaBytes = live - baseline;
  runtime.setSink(undefined);
  runtime.gcAndSweep();
  if (!Number.isFinite(deltaBytes)) throw new Error(`Retained heap delta must be finite: ${deltaBytes}`);
  return { deltaBytes };
}
