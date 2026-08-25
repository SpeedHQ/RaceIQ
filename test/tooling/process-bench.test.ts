import { describe, expect, test } from "bun:test";
import { runChildBenchmark, retainedHeapAttemptLimit, type RetainedHeapChildReport, type TimingChildReport } from "../benchmarks/process-bench-contracts";
import { join } from "node:path";

const retainedHeapFixture = async (source: string) => {
  const path = join("/tmp", `process-bench-fixture-${crypto.randomUUID()}.ts`);
  await Bun.write(path, source);
  return path;
};

const retainedHeapChild = async (source: string) => ({
  command: [bun, "run", join(process.cwd(), "test/benchmarks/process-bench-child.ts"), "retainedHeap", await retainedHeapFixture(source), "1"],
  kind: "retainedHeap" as const,
});

const bun = process.execPath;
const child = (output: string, exit = 0) => ({
  command: [bun, "-e", `process.stdout.write(${JSON.stringify(output)}); process.exit(${exit})`],
});
const timingChild = (fixture: string, warmups = 0, iterations = 3) => ({
  command: [bun, "run", "test/benchmarks/process-bench-child.ts", "timing", `data:text/javascript,${encodeURIComponent(fixture)}`, String(warmups), String(iterations)],
  kind: "timing" as const,
});

describe("fixed-iteration timing child", () => {
  test("runs setup before warmup and measured timing", async () => {
    const report = await runChildBenchmark(timingChild(`
      let phase = "loaded";
      export function setup() { if (phase !== "loaded") throw new Error("setup ordering"); phase = "setup"; }
      export function runIteration() { if (phase !== "setup") throw new Error("run before setup"); }
    `, 1, 2)) as TimingChildReport;
    expect(report.iterations).toBe(2);
    expect(report.warmupIterations).toBe(1);
  });

});
describe("retained-heap fixture child", () => {
  test("keeps fixture output off stdout and measures retained result", async () => {
    const config = await retainedHeapChild(`
      export function setup() { console.log("setup diagnostic"); }
      export function runIteration() { console.log("iteration diagnostic"); return new ArrayBuffer(1024 * 1024); }
    `);
    const report = await runChildBenchmark(config) as RetainedHeapChildReport;
    expect(report.retainedHeap).toBeGreaterThan(0);
  });
});


describe("child benchmark contracts", () => {
  test("parses timing report with fixed iteration counts", async () => {
    const report = await runChildBenchmark({
      ...child(JSON.stringify({ iterations: 3, warmupIterations: 2, samplesNs: [10, 20, 30] })),
      kind: "timing",
    }) as TimingChildReport;
    expect(report.iterations).toBe(3);
    expect(report.samplesNs).toHaveLength(report.iterations);
  });

  test("rejects timing report with mismatched sample count", async () => {
    await expect(runChildBenchmark({
      ...child(JSON.stringify({ iterations: 3, warmupIterations: 2, samplesNs: [10] })),
      kind: "timing",
    })).rejects.toThrow("fixed counts");
  });

  test("rejects malformed child output", async () => {
    await expect(runChildBenchmark({ ...child("not json") })).rejects.toThrow("malformed JSON");
  });

  test("rejects non-zero child exits", async () => {
    await expect(runChildBenchmark({ ...child("failure", 7) })).rejects.toThrow("exited with code 7");
  });

  test("rejects negative retained heap", async () => {
    await expect(runChildBenchmark({
      ...child(JSON.stringify({ retainedHeap: -1 })),
      kind: "retainedHeap",
    })).rejects.toThrow("finite and non-negative");
  });

  test("accepts retained heap report", async () => {
    const report = await runChildBenchmark({
      ...child(JSON.stringify({ retainedHeap: 42 })),
      kind: "retainedHeap",
    }) as RetainedHeapChildReport;
    expect(report.retainedHeap).toBe(42);
  });
});

describe("retained-heap retry budget", () => {
  test("allows enough retries for intermittent GC sweep undercounting", () => {
    expect(retainedHeapAttemptLimit(7)).toBe(100);
    expect(retainedHeapAttemptLimit(30)).toBe(120);
  });
});
