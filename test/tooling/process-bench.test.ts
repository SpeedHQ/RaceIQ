import { describe, expect, test } from "bun:test";
import { measureRetainedHeap, measureTiming, type BenchmarkRuntime } from "../benchmarks/process-bench-runtime";
import { runChildBenchmark, type RetainedHeapChildReport, type TimingChildReport } from "../benchmarks/process-bench-contracts";
import { join } from "node:path";

const bun = process.execPath;
const child = (output: string, exit = 0) => ({ command: [bun, "-e", `process.stdout.write(${JSON.stringify(output)}); process.exit(${exit})`] });
const runtime = (advance: number, sweepValues: number[] = []) => {
  let now = 0;
  let sweepIndex = 0;
  const sinks: unknown[] = [];
  const events: string[] = [];
  const fake: BenchmarkRuntime = {
    nowNs: () => now,
    gcAndSweep: () => { now += 100; events.push("sweep"); return sweepValues[sweepIndex++] ?? 100; },
    setSink: (value) => { sinks.push(value); events.push("sink"); },
  };
  return { fake, advance: () => { now += advance; }, sinks, events };
};

function fixturePath(): string {
  return join("/tmp", `process-bench-fixture-${crypto.randomUUID()}.ts`);
}

const retainedHeapChild = async (source: string) => {
  const path = fixturePath();
  await Bun.write(path, source);
  return { command: [bun, "run", join(process.cwd(), "test/benchmarks/process-bench-child.ts"), "retainedHeap", path, "1"], kind: "retainedHeap" as const };
};


describe("timing acquisition", () => {
  test("orders setup, warmup, out-of-band sweep, synchronous return, and sink rooting", async () => {
    const state: string[] = [];
    const clock = runtime(10);
    const report = await measureTiming({
      setup: () => { state.push("setup"); },
      runIteration: () => { state.push("run"); clock.advance(); return {}; },
    }, { warmupNs: 0, measurementNs: 20, minSamples: 2, maxSamples: 3 }, clock.fake);
    expect(state).toEqual(["setup", "run", "run"]);
    expect(report.samplesNs).toEqual([10, 10]);
    expect(clock.events.slice(0, 3)).toEqual(["sink", "sweep", "sink"]);
    expect(clock.sinks.some((value) => typeof value === "object" && value !== null)).toBe(true);
  });

  test("awaits promise returns and stops only after time and sample minima", async () => {
    const clock = runtime(10);
    let promisePath = false;
    const report = await measureTiming({ runIteration: () => { promisePath = true; clock.advance(); return Promise.resolve("result"); } }, { warmupNs: 0, measurementNs: 10, minSamples: 3, maxSamples: 4 }, clock.fake);
    expect(promisePath).toBe(true);
    expect(report.samplesNs).toHaveLength(3);
  });

  test("fails when max samples exhaust before measurement duration", async () => {
    const clock = runtime(1);
    await expect(measureTiming({ runIteration: () => { clock.advance(); return null; } }, { warmupNs: 0, measurementNs: 1000, minSamples: 1, maxSamples: 2 }, clock.fake)).rejects.toThrow("maxSamples=2");
  });

  test("retained mode preserves finite negative deltas", async () => {
    const clock = runtime(0, [100, 50, 50]);
    const report = await measureRetainedHeap({ runIteration: () => ({ retained: true }) }, 0, clock.fake);
    expect(report.deltaBytes).toBe(-50);
  });
});

describe("child process contract", () => {
  test("validates stdout JSON and timing sample bounds", async () => {
    const report = await runChildBenchmark({
      ...child(JSON.stringify({ warmupIterations: 2, warmupNs: 10, measurementNs: 20, samplesNs: [10, 20] })),
      kind: "timing", expectedSamples: { min: 2, max: 3 },
    });
    expect((report as TimingChildReport).samplesNs).toHaveLength(2);
  });
  test("rejects malformed JSON, extra lines, and non-zero exits", async () => {
    await expect(runChildBenchmark({ ...child("not json"), kind: "retainedHeap" })).rejects.toThrow("malformed JSON");
    await expect(runChildBenchmark({ ...child("{}\n{}"), kind: "retainedHeap" })).rejects.toThrow("one JSON line");
    await expect(runChildBenchmark({ ...child("failure", 7), kind: "retainedHeap" })).rejects.toThrow("exited with code 7");
  });
  test("accepts signed retained heap JSON", async () => {
    const report = await runChildBenchmark({ ...child(JSON.stringify({ deltaBytes: -42 })), kind: "retainedHeap" });
    expect((report as RetainedHeapChildReport).deltaBytes).toBe(-42);
  });
  test("keeps fixture diagnostics off stdout", async () => {
    const config = await retainedHeapChild(`export function setup() { console.log("diagnostic"); } export function runIteration() { console.log("iteration"); return []; }`);
    const report = await runChildBenchmark(config);
    expect(typeof (report as RetainedHeapChildReport).deltaBytes).toBe("number");
  });
});
