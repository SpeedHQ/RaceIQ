#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";

const MIB = 1024 * 1024;

const BUDGETS = {
  parser: {
    maxPeakRssBytes: 768 * MIB,
    maxIncrementalRssBytes: 512 * MIB,
    maxIncrementalHeapBytes: 512 * MIB,
  },
  replay: {
    maxPeakRssBytes: 1_536 * MIB,
    maxIncrementalRssBytes: 1_024 * MIB,
    maxIncrementalHeapBytes: 1_024 * MIB,
  },
} as const;

type ScenarioName = keyof typeof BUDGETS;

export interface BenchmarkBudget {
  readonly maxPeakRssBytes: number;
  readonly maxIncrementalRssBytes: number;
  readonly maxIncrementalHeapBytes: number;
}


export interface ReplayParserBenchmarkMeasurement {
  readonly name: ScenarioName;
  readonly fixture: string;
  readonly inputFrames: number;
  readonly outputItems: number;
  readonly semanticCount: number;
  readonly durationMs: number;
  readonly throughputPerSecond: number;
  readonly baselineRssBytes: number;
  readonly peakRssBytes: number;
  readonly incrementalPeakRssBytes: number;
  readonly baselineHeapBytes: number;
  readonly peakHeapBytes: number;
  readonly incrementalPeakHeapBytes: number;
}

export interface ReplayParserBenchmarkResult extends ReplayParserBenchmarkMeasurement {
  readonly budget: BenchmarkBudget;
}

export interface ReplayParserBenchmarkReport {
  readonly schemaVersion: 2;
  readonly runtime: string;
  readonly platform: string;
  readonly architecture: string;
  readonly machine: {
    readonly cpuModel: string;
    readonly logicalCpuCount: number;
    readonly totalMemoryBytes: number;
  };
  readonly results: readonly ReplayParserBenchmarkResult[];
}

function argumentValue(name: string): string | undefined {
  const prefix = `${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}


function budgetFailures(results: readonly ReplayParserBenchmarkResult[]): string[] {
  const failures: string[] = [];
  for (const result of results) {
    const budget = result.budget;
    if (result.peakRssBytes > budget.maxPeakRssBytes) {
      failures.push(`${result.name} peak RSS ${formatBytes(result.peakRssBytes)} exceeds ${formatBytes(budget.maxPeakRssBytes)}`);
    }
    if (result.incrementalPeakRssBytes > budget.maxIncrementalRssBytes) {
      failures.push(`${result.name} incremental RSS ${formatBytes(result.incrementalPeakRssBytes)} exceeds ${formatBytes(budget.maxIncrementalRssBytes)}`);
    }
    if (result.incrementalPeakHeapBytes > budget.maxIncrementalHeapBytes) {
      failures.push(`${result.name} incremental heap ${formatBytes(result.incrementalPeakHeapBytes)} exceeds ${formatBytes(budget.maxIncrementalHeapBytes)}`);
    }
  }
  return failures;
}

function formatBytes(bytes: number): string {
  return `${(bytes / MIB).toFixed(1)} MiB`;
}

function printResults(results: readonly ReplayParserBenchmarkResult[]): void {
  for (const result of results) {
    console.log(
      `[telemetry-bench] ${result.name}: ${result.throughputPerSecond.toFixed(0)}/s, ` +
      `peak RSS ${formatBytes(result.peakRssBytes)}, incremental RSS ${formatBytes(result.incrementalPeakRssBytes)}, ` +
      `incremental heap ${formatBytes(result.incrementalPeakHeapBytes)}`,
    );
  }
}


async function runController(): Promise<void> {

  const outputPath = resolve(argumentValue("--output") ?? "telemetry-benchmark-results.json");
  const tempRoot = mkdtempSync(join(tmpdir(), "raceiq-telemetry-benchmark-"));
  const results: ReplayParserBenchmarkResult[] = [];
  try {
    for (const scenario of ["parser", "replay"] as const) {
      const dataDir = join(tempRoot, scenario, "data");
      const resultPath = join(tempRoot, `${scenario}.json`);
      mkdirSync(dataDir, { recursive: true });
      const child = Bun.spawn({
        cmd: [process.execPath, resolve("test/benchmarks/replay-parser-worker.ts"), `--scenario=${scenario}`, `--result=${resultPath}`],
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATA_DIR: dataDir,
          RACEIQ_TEST_MODE: "1",
          NODE_ENV: "test",
        },
        stdout: "inherit",
        stderr: "inherit",
      });
      const exitCode = await child.exited;
      if (exitCode !== 0) throw new Error(`${scenario} benchmark child exited with code ${exitCode}`);
      const measurement = JSON.parse(readFileSync(resultPath, "utf8")) as ReplayParserBenchmarkMeasurement;
      results.push({ ...measurement, budget: BUDGETS[scenario] });
    }

    const cpuInfo = cpus();
    const report: ReplayParserBenchmarkReport = {
      schemaVersion: 2,
      runtime: `bun ${Bun.version}`,
      platform: process.platform,
      architecture: process.arch,
      machine: {
        cpuModel: cpuInfo[0]?.model ?? "unknown",
        logicalCpuCount: cpuInfo.length,
        totalMemoryBytes: totalmem(),
      },
      results,
    };
    await Bun.write(outputPath, JSON.stringify(report, null, 2));
    printResults(results);
    console.log(`[telemetry-bench] report written to ${outputPath}`);

    if (!process.argv.includes("--no-enforce")) {
      const failures = budgetFailures(results);
      if (failures.length > 0) {
        for (const failure of failures) console.error(`[telemetry-bench] budget failed: ${failure}`);
        process.exitCode = 1;
      }
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

await runController();
