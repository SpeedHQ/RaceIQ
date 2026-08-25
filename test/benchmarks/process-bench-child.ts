import { gcAndSweep } from "bun:jsc";
import { pathToFileURL } from "node:url";

type BenchmarkModule = {
  setup?: () => void | Promise<void>;
  runIteration: () => unknown | Promise<unknown>;
};

let retainedHeapRoot: unknown;

function fail(message: string): never {
  console.error(`process-bench-child: ${message}`);
  process.exit(1);
}

const [, , mode, moduleSpecifier, warmupText, iterationsText] = process.argv;
if (mode !== "timing" && mode !== "retainedHeap") fail("first argument must be timing or retainedHeap");
if (!moduleSpecifier) fail("fixture module is required");
const warmupIterations = Number(warmupText);
if (!Number.isInteger(warmupIterations) || warmupIterations < 0) fail("warmup count must be a non-negative integer");
const iterations = Number(iterationsText);
if (mode === "timing" && (!Number.isInteger(iterations) || iterations <= 0)) fail("iteration count must be a positive integer");

let loaded: BenchmarkModule;
try {
  const specifier = moduleSpecifier.startsWith(".") || moduleSpecifier.startsWith("/")
    ? pathToFileURL(moduleSpecifier).href
    : moduleSpecifier;
  const imported = await import(specifier) as Partial<BenchmarkModule> & { default?: Partial<BenchmarkModule> };
  const candidate = (imported.default as { default?: Partial<BenchmarkModule> } | undefined)?.default
    ?? (typeof imported.default?.runIteration === "function" ? imported.default : imported);
  loaded = candidate as BenchmarkModule;
} catch (error) {
  fail(`could not load fixture: ${error instanceof Error ? error.message : String(error)}`);
}
if (typeof loaded.runIteration !== "function") fail("fixture must export runIteration()");

console.log = (...args: unknown[]) => console.error(...args);
const stdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => process.stderr.write(chunk, ...(args as [never]))) as typeof process.stdout.write;
try {
  await loaded.setup?.();
  for (let i = 0; i < warmupIterations; i++) await loaded.runIteration();
  if (mode === "retainedHeap") {
    await loaded.runIteration();
    retainedHeapRoot = undefined;
    const baseline = gcAndSweep();
    retainedHeapRoot = await loaded.runIteration();
    const live = gcAndSweep();
    const delta = live - baseline;
    retainedHeapRoot = undefined;
    gcAndSweep();
    if (!Number.isFinite(delta) || delta < 0) fail(`retained heap delta must be finite and non-negative: ${delta}`);
    process.stdout.write = stdoutWrite;
    stdoutWrite(`${JSON.stringify({ retainedHeap: delta })}\n`);
  } else {
    const samplesNs: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const start = Bun.nanoseconds();
      await loaded.runIteration();
      const elapsed = Bun.nanoseconds() - start;
      if (!Number.isFinite(elapsed) || elapsed < 0) fail("timing sample must be finite and non-negative");
      samplesNs.push(elapsed);
    }
    process.stdout.write = stdoutWrite;
    stdoutWrite(`${JSON.stringify({ iterations, warmupIterations, samplesNs })}\n`);
  }
} catch (error) {
  fail(`benchmark failed: ${error instanceof Error ? error.message : String(error)}`);
}
