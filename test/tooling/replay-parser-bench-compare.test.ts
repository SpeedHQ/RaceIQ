import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ReplayParserBenchmarkReport,
  ReplayParserBenchmarkResult,
} from "../benchmarks/replay-parser.bench";

const MIB = 1024 * 1024;
const tempDirs: string[] = [];

interface ReportOptions {
  readonly parserFixture?: string;
  readonly parserMaxPeakRssBytes?: number;
  readonly parserThroughputPerSecond?: number;
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "raceiq-replay-parser-compare-"));
  tempDirs.push(dir);
  return dir;
}

function makeResult(
  name: ReplayParserBenchmarkResult["name"],
  options: ReportOptions = {},
): ReplayParserBenchmarkResult {
  return {
    name,
    fixture: name === "parser" ? (options.parserFixture ?? "test/fixture.bin") : "test/fixture.bin",
    inputFrames: 100,
    outputItems: 100,
    semanticCount: name === "replay" ? 8 : 0,
    durationMs: 100,
    throughputPerSecond: name === "parser" ? (options.parserThroughputPerSecond ?? 1_000) : 1_000,
    baselineRssBytes: 16 * MIB,
    peakRssBytes: 32 * MIB,
    incrementalPeakRssBytes: 16 * MIB,
    baselineHeapBytes: 8 * MIB,
    peakHeapBytes: 24 * MIB,
    incrementalPeakHeapBytes: 16 * MIB,
    budget: {
      maxPeakRssBytes: name === "parser" ? (options.parserMaxPeakRssBytes ?? 128 * MIB) : 256 * MIB,
      maxIncrementalRssBytes: 64 * MIB,
      maxIncrementalHeapBytes: 64 * MIB,
    },
  };
}

function makeReport(options: ReportOptions = {}): ReplayParserBenchmarkReport {
  return {
    schemaVersion: 2,
    runtime: "bun 1.3.14",
    platform: "test-platform",
    architecture: "x64",
    machine: {
      cpuModel: "Test CPU",
      logicalCpuCount: 8,
      totalMemoryBytes: 16 * 1024 * MIB,
    },
    results: [makeResult("parser", options), makeResult("replay", options)],
  };
}

async function runComparator(
  baseline: string,
  current: string,
  failOnRegression = false,
): Promise<{ code: number; output: string }> {
  const dir = makeTempDir();
  const baselinePath = join(dir, "baseline.json");
  const currentPath = join(dir, "current.json");
  await Promise.all([Bun.write(baselinePath, baseline), Bun.write(currentPath, current)]);

  const args = [
    process.execPath,
    "scripts/quality/replay-parser-bench-compare.ts",
    baselinePath,
    currentPath,
  ];
  if (failOnRegression) args.push("--fail-on-regression");
  const proc = Bun.spawn(args, {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, output: `${stdout}\n${stderr}` };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("replay/parser benchmark comparison", () => {
  test("accepts identical compatible reports", async () => {
    const report = JSON.stringify(makeReport());
    const result = await runComparator(report, report, true);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("All hard memory and same-machine relative budgets passed.");
  });

  test("enforces throughput regressions only when requested", async () => {
    const baseline = JSON.stringify(makeReport());
    const current = JSON.stringify(makeReport({ parserThroughputPerSecond: 800 }));

    const enforced = await runComparator(baseline, current, true);
    expect(enforced.code, enforced.output).toBe(1);
    expect(enforced.output).toContain("parser throughput regressed 20.0%, limit is 10%");

    const reportOnly = await runComparator(baseline, current);
    expect(reportOnly.code, reportOnly.output).toBe(0);
    expect(reportOnly.output).toContain("parser throughput regressed 20.0%, limit is 10%");
  });

  test("rejects changed fixtures", async () => {
    const result = await runComparator(
      JSON.stringify(makeReport()),
      JSON.stringify(makeReport({ parserFixture: "test/easier-fixture.bin" })),
      true,
    );

    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain(
      "parser workload changed: test/fixture.bin, 100 frames/0 semantics → test/easier-fixture.bin, 100 frames/0 semantics",
    );
  });

  test("rejects relaxed hard budgets", async () => {
    const result = await runComparator(
      JSON.stringify(makeReport()),
      JSON.stringify(makeReport({ parserMaxPeakRssBytes: 129 * MIB })),
      true,
    );

    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain("parser maxPeakRssBytes budget relaxed: 128.0 MiB → 129.0 MiB");
  });

  test("always rejects malformed and non-finite reports", async () => {
    const valid = JSON.stringify(makeReport({ parserThroughputPerSecond: 1_234 }));
    const duplicateParser = JSON.stringify({
      ...makeReport(),
      results: [makeResult("parser"), makeResult("parser")],
    });
    const missingReplay = JSON.stringify({
      ...makeReport(),
      results: [makeResult("parser")],
    });
    const nonFinite = valid.replace('"throughputPerSecond":1234', '"throughputPerSecond":1e999');

    for (const malformed of ["not json", "{}", duplicateParser, missingReplay, nonFinite]) {
      const result = await runComparator(valid, malformed);
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain("is not a valid replay/parser benchmark report");
    }
  });
});
