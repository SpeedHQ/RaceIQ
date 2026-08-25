import { describe, expect, test } from "bun:test";
import { runChildBenchmark, type RetainedHeapChildReport, type TimingChildReport } from "../benchmarks/process-bench-contracts";

const bun = process.execPath;
const child = (output: string, exit = 0) => ({
  command: [bun, "-e", `process.stdout.write(${JSON.stringify(output)}); process.exit(${exit})`],
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
