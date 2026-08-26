import { gcAndSweep } from "bun:jsc";
import { pathToFileURL } from "node:url";
import { measureRetainedHeap, measureTiming, type BenchmarkModule } from "./process-bench-runtime";

function fail(message: string): never {
  console.error(`process-bench-child: ${message}`);
  process.exit(1);
}

const [, , mode, moduleSpecifier, ...values] = process.argv;
if (mode !== "timing" && mode !== "retainedHeap") fail("first argument must be timing or retainedHeap");
if (!moduleSpecifier) fail("fixture module is required");
const numbers = values.map(Number);
if (mode === "timing") {
  const [warmupMs, measurementMs, minSamples, maxSamples] = numbers;
  if (![warmupMs, measurementMs].every((value) => Number.isFinite(value) && value >= 0)) fail("warmup and measurement milliseconds must be finite and non-negative");
  if (![minSamples, maxSamples].every((value) => Number.isInteger(value) && value > 0) || minSamples > maxSamples) fail("sample bounds must be positive integers with min <= max");
} else if (!Number.isInteger(numbers[0]) || numbers[0]! < 0) {
  fail("warmup count must be a non-negative integer");
}

let loaded: BenchmarkModule;
const stdoutWrite = process.stdout.write.bind(process.stdout);
console.log = (...args: unknown[]) => console.error(...args);
process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => process.stderr.write(chunk, ...(args as [never]))) as typeof process.stdout.write;
try {
  const specifier = moduleSpecifier.startsWith(".") || moduleSpecifier.startsWith("/")
    ? pathToFileURL(moduleSpecifier).href
    : moduleSpecifier;
  const imported = await import(specifier) as Partial<BenchmarkModule> & { default?: Partial<BenchmarkModule> };
  const candidate = imported.default && typeof imported.default.runIteration === "function" ? imported.default : imported;
  loaded = candidate as BenchmarkModule;
} catch (error) {
  fail(`could not load fixture: ${error instanceof Error ? error.message : String(error)}`);
}
if (typeof loaded.runIteration !== "function") fail("fixture must export runIteration()");

try {
  const runtime = { nowNs: Bun.nanoseconds, gcAndSweep, setSink: (value: unknown) => { (globalThis as typeof globalThis & { __raceiqBenchmarkSink?: unknown }).__raceiqBenchmarkSink = value; } };
  const report = mode === "timing"
    ? await measureTiming(loaded, {
        warmupNs: numbers[0]! * 1_000_000,
        measurementNs: numbers[1]! * 1_000_000,
        minSamples: numbers[2]!,
        maxSamples: numbers[3]!,
      }, runtime)
    : await measureRetainedHeap(loaded, numbers[0]!, runtime);
  process.stdout.write = stdoutWrite;
  stdoutWrite(`${JSON.stringify(report)}\n`);
} catch (error) {
  fail(`benchmark failed: ${error instanceof Error ? error.message : String(error)}`);
}
