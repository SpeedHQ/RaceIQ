import { pathToFileURL } from "node:url";

type TimingModule = {
  setup?: () => void | Promise<void>;
  runIteration: () => void | Promise<void>;
};

function fail(message: string): never {
  console.error(`process-bench-child: ${message}`);
  process.exit(1);
}

const [, , mode, moduleSpecifier, warmupText, iterationsText] = process.argv;
if (mode !== "timing") fail("first argument must be timing");
if (!moduleSpecifier) fail("fixture module is required");
const warmupIterations = Number(warmupText);
const iterations = Number(iterationsText);
if (!Number.isInteger(warmupIterations) || warmupIterations < 0) fail("warmup count must be a non-negative integer");
if (!Number.isInteger(iterations) || iterations <= 0) fail("iteration count must be a positive integer");

let loaded: TimingModule;
try {
  const specifier = moduleSpecifier.startsWith(".") || moduleSpecifier.startsWith("/")
    ? pathToFileURL(moduleSpecifier).href
    : moduleSpecifier;
  const imported = await import(specifier) as Partial<TimingModule> & { default?: Partial<TimingModule> };
  loaded = (imported.default?.runIteration ? imported.default : imported) as TimingModule;
} catch (error) {
  fail(`could not load fixture: ${error instanceof Error ? error.message : String(error)}`);
}
if (typeof loaded.runIteration !== "function") fail("fixture must export runIteration()");

try {
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => process.stderr.write(chunk, ...(args as [ never ]))) as typeof process.stdout.write;
  await loaded.setup?.();
  for (let i = 0; i < warmupIterations; i++) await loaded.runIteration();
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
} catch (error) {
  fail(`benchmark failed: ${error instanceof Error ? error.message : String(error)}`);
}
