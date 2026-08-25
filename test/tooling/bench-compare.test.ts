import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

interface ReportOptions {
  readonly median?: number;
  readonly p99?: number;
  readonly retainedHeap?: number;
  readonly includeReplay?: boolean;
  readonly runtime?: string;
  readonly cpu?: string;
  readonly omitCurrent?: boolean;
  readonly rawProcesses?: boolean;
  readonly highVariance?: boolean;
}
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "raceiq-bench-compare-"));
  tempDirs.push(dir);
  return dir;
}

function makeReport(options: ReportOptions = {}): string {
  const benchmarks = [
    {
      alias: "pipeline",
      group: 1,
      runs: [{ stats: { p50: 100, p99: 120 } }],
    },
  ];
  if (options.includeReplay !== false && !options.omitCurrent) {
    benchmarks.push({
      alias: "resolve 20,000 canonical envelopes",
      group: 0,
      runs: [{ stats: {
        p50: options.median ?? 100,
        p99: options.p99 ?? 120,
        ...(options.retainedHeap === undefined ? {} : { retainedHeap: { p50: options.retainedHeap } }),
      } }],
    });
  }
  return JSON.stringify({
    layout: [{ name: "replay" }, { name: "legacy" }],
    context: { runtime: options.runtime ?? "bun", cpu: { name: options.cpu ?? "Test CPU" } },
    benchmarks,
    ...(options.rawProcesses ? {
      rawProcesses: options.highVariance
        ? [
            { timing: { "replay/resolve 20,000 canonical envelopes": { samplesNs: [100] } } },
            { timing: { "replay/resolve 20,000 canonical envelopes": { samplesNs: [10000] } } },
          ]
        : [{
            timing: {
              "replay/resolve 20,000 canonical envelopes": { samplesNs: [100, 101, 99, 100] },
            },
          }],
    } : {}),
  });
}

async function runComparator(reports: string[], extraArgs: string[] = []): Promise<{ code: number; output: string }> {
  const dir = makeTempDir();
  const paths: string[] = [];
  for (let index = 0; index < reports.length; index += 1) {
    const path = join(dir, `report-${index}.json`);
    await Bun.write(path, reports[index]!);
    paths.push(path);
  }
  const proc = Bun.spawn([process.execPath, "scripts/quality/bench-compare.ts", ...paths, ...extraArgs], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, output: `${stdout}\n${stderr}` };
}

function pairedWith(baseOptions: ReportOptions, currentOptions: ReportOptions, count = 4): string[] {
  return Array.from({ length: count }, () => [makeReport(baseOptions), makeReport(currentOptions)]).flat();
}
function paired(base: number[], current: number[], options: ReportOptions = {}): string[] {
  return base.flatMap((baseMedian, index) => [
    makeReport({ ...options, median: baseMedian }),
    makeReport({ ...options, median: current[index] }),
  ]);
}

describe("Paired benchmark comparison", () => {
  test("accepts identical four-pair reports", async () => {
    const result = await runComparator(paired([100, 100, 100, 100], [100, 100, 100, 100]), ["--fail-on-regression"]);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("No regressions above configured thresholds");
  });

  test("uses paired median so one noisy process does not fail", async () => {
    const result = await runComparator(paired([100, 100, 100, 100], [110, 90, 100, 100]), ["--fail-on-regression"]);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("≈ 0.0%");
  });

  test("fails consistent median and p99 regressions", async () => {
    const result = await runComparator(paired([100, 100, 100, 100], [106, 106, 106, 106]), ["--p99-threshold=5", "--fail-on-regression"]);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain("median +6.0%");
    const p99 = await runComparator(pairedWith({ p99: 120 }, { p99: 130 }), ["--p99-threshold=5", "--fail-on-regression"]);
    expect(p99.code, p99.output).toBe(1);
    expect(p99.output).toContain("p99 +8.3%");
  });

  test("shows retained heap p50 values alongside gated delta", async () => {
    const result = await runComparator(pairedWith({ retainedHeap: 1_000 }, { retainedHeap: 1_100 }));
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("Baseline retained heap p50");
    expect(result.output).toContain("1,000 B");
    expect(result.output).toContain("1,100 B");
    expect(result.output).toContain("Δ retained heap");
  });


  test("shows retained heap pending for legacy base reports", async () => {
    const result = await runComparator(paired([100, 100], [100, 100], { retainedHeap: 1_100 }));
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("Δ retained heap");
    expect(result.output).toContain("| — |");
    expect(result.output).not.toContain("alloc");
  });

  test("fails runtime and CPU mismatches", async () => {
    const runtime = await runComparator([makeReport(), makeReport({ runtime: "node" })]);
    expect(runtime.code).toBe(1);
    expect(runtime.output).toContain("Context mismatch in pair 1");
    const cpu = await runComparator([makeReport(), makeReport({ cpu: "Other CPU" })]);
    expect(cpu.code).toBe(1);
    expect(cpu.output).toContain("Other CPU");
  });

  test("fails missing current results", async () => {
    const result = await runComparator([makeReport(), makeReport({ omitCurrent: true })]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("Current result missing");
  });

  test("preserves include, informational, and title behavior", async () => {
    const result = await runComparator(paired([100, 100], [200, 50]), ["--include=replay/", "--informational", "--title=Replay guardrails"]);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("## Replay guardrails");
    expect(result.output).toContain("Included benchmarks: `replay/*`");
    expect(result.output).not.toContain("legacy/pipeline");
    expect(result.output).toContain("Report-only");
  });
  test("reports high variance from preserved raw process samples", async () => {
    const result = await runComparator([
      makeReport({ rawProcesses: true, highVariance: true }),
      makeReport({ rawProcesses: true, highVariance: true }),
    ]);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("high process variance");
    expect(result.output).toContain("MAD");
  });

  test("rejects invalid threshold values", async () => {
    for (const flag of ["--median-threshold", "--p99-threshold", "--retained-heap-threshold"]) {
      for (const value of ["NaN", "Infinity", "-1", "not-a-number", ""]) {
        const result = await runComparator([makeReport(), makeReport()], [`${flag}=${value}`]);
        expect(result.code, `${flag}=${value}`).toBe(1);
        expect(result.output).toContain("finite non-negative number");
        expect(result.output).toContain("Usage:");
      }
    }
  });

  test("uses new thresholds and metric labels in usage and output", async () => {
    const usage = await runComparator([makeReport()]);
    expect(usage.code).toBe(1);
    expect(usage.output).toContain("--median-threshold");
    expect(usage.output).toContain("--retained-heap-threshold");
    const result = await runComparator(paired([100, 100], [100, 100]));
    expect(result.output).toContain("retained heap");
    expect(result.output).not.toContain("alloc");
  });

  test("allows new benchmark to remain baseline pending", async () => {
    const base = makeReport({ includeReplay: false });
    const current = makeReport();
    const result = await runComparator([base, current, base, current]);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("Baseline pending");
  });
});
