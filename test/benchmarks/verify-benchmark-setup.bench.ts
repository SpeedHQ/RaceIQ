import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

type Options = {
  timing?: number[][];
  heap?: number[];
  runtime?: string;
  caseOrder?: "forward" | "reverse";
  cases?: Record<string, unknown>;
};
function report(options: Options = {}): string {
  const timing = options.timing ?? [Array(20).fill(100), Array(20).fill(100), Array(20).fill(100)];
  const heap = options.heap ?? Array(15).fill(100);
  const cases = options.cases ?? {
    "replay/sample": {
      timing: timing.map((samples) => ({ warmupIterations: 1, warmupNs: 1, measurementNs: 100, samplesNs: samples })),
      retainedHeapDeltas: heap,
    },
  };
  return JSON.stringify({
    schemaVersion: 2, revision: "test", suite: "replay",
    config: { processes: 3, retainedProcesses: 15, retainedWarmups: 1, warmupMs: 1, measurementMs: 1, minSamples: 20, maxSamples: 200, caseOrder: options.caseOrder ?? "forward" },
    context: { runtime: options.runtime ?? "Bun test", cpu: { name: "test CPU", logicalCount: 4 }, os: { platform: "test", release: "1", arch: "arm64" } },
    cases,
  });
}
async function compare(reports: string[], extra: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "raceiq-compare-"));
  tempDirs.push(dir);
  const paths = await Promise.all(reports.map(async (contents, index) => {
    const path = join(dir, `${index}.json`);
    await Bun.write(path, contents);
    return path;
  }));
  const proc = Bun.spawn([process.execPath, "test/benchmarks/compare-benchmarks.ts", ...paths, "--bootstrap-samples=200", ...extra], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, output: `${stdout}\n${stderr}` };
}
function paired(baseTiming: number[][], currentTiming: number[][], baseHeap = Array(15).fill(100), currentHeap = Array(15).fill(100)): string[] {
  return [report({ timing: baseTiming, heap: baseHeap }), report({ timing: currentTiming, heap: currentHeap }), report({ timing: baseTiming, heap: baseHeap }), report({ timing: currentTiming, heap: currentHeap })];
}

describe("paired benchmark comparison", () => {
  test("identical reports are deterministic zero-width PASS", async () => {
    const result = await compare(paired([Array(20).fill(100), Array(20).fill(100), Array(20).fill(100)], [Array(20).fill(100), Array(20).fill(100), Array(20).fill(100)]), ["--fail-on-regression"]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("0.00%");
    expect(result.output.match(/PASS/g)?.length).toBe(2);
  });
  test("narrow CPU and heap regressions fail", async () => {
    const result = await compare(paired([Array(20).fill(100), Array(20).fill(100), Array(20).fill(100)], [Array(20).fill(112), Array(20).fill(112), Array(20).fill(112)], Array(15).fill(100), Array(15).fill(112)), ["--median-threshold=10", "--retained-heap-threshold=10", "--fail-on-regression"]);
    expect(result.code).toBe(1);
    expect(result.output.match(/REGRESSION/g)?.length).toBe(2);
  });
  test("precise sub-threshold changes pass", async () => {
    const result = await compare(paired([Array(20).fill(100), Array(20).fill(100), Array(20).fill(100)], [Array(20).fill(105), Array(20).fill(105), Array(20).fill(105)]), ["--fail-on-regression"]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("PASS");
  });
  test("threshold crossing, error budget overflow, and unmeasurable heap are inconclusive", async () => {
    const crossing = await compare(paired([Array(20).fill(100), Array(20).fill(100), Array(20).fill(100)], [Array(20).fill(50), Array(20).fill(100), Array(20).fill(200)]), ["--fail-on-regression"]);
    expect(crossing.code).toBe(0);
    expect(crossing.output).toContain("INCONCLUSIVE");
    const noisyGroups = Array.from({ length: 3 }, () => [...Array(10).fill(50), ...Array(10).fill(150)]);
    const noisy = await compare(paired([Array(20).fill(100), Array(20).fill(100), Array(20).fill(100)], noisyGroups), ["--max-cpu-error=0.1", "--fail-on-regression"]);
    expect(noisy.output).toContain("INCONCLUSIVE");
    const heap = await compare(paired([Array(20).fill(100), Array(20).fill(100), Array(20).fill(100)], [Array(20).fill(100), Array(20).fill(100), Array(20).fill(100)], Array(15).fill(0), Array(15).fill(10)), ["--fail-on-regression"]);
    expect(heap.output).toContain("unmeasurable");
  });
  test("rejects malformed and mismatched reports", async () => {
    const malformed = await compare(["{}", report()], ["--fail-on-regression"]);
    expect(malformed.code).toBe(1);
    const mismatch = await compare([report(), report({ runtime: "other" })]);
    expect(mismatch.code).toBe(1);
  });
  test("repeated seeded runs emit identical output", async () => {
    const reports = paired([Array(20).fill(100), Array(20).fill(101), Array(20).fill(99)], [Array(20).fill(103), Array(20).fill(104), Array(20).fill(102)]);
    const first = await compare(reports);
    const second = await compare(reports);
    expect(first.output).toBe(second.output);
  });
});
