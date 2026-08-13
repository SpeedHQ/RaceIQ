#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const MIB = 1024 * 1024;
const SCENARIOS = ["parser", "replay"] as const;

export type ReplayParserSoakScenarioName = (typeof SCENARIOS)[number];

export interface ReplayParserSoakSample {
  readonly iteration: number;
  readonly postGcRssBytes: number;
  readonly postGcHeapBytes: number;
}

export interface ReplayParserSoakMeasurement {
  readonly name: ReplayParserSoakScenarioName;
  readonly fixture: string;
  readonly framesPerIteration: number;
  readonly semanticCount: number;
  readonly warmupIterations: number;
  readonly measuredIterations: number;
  readonly durationMs: number;
  readonly samples: readonly ReplayParserSoakSample[];
}

export interface ReplayParserSoakBudget {
  readonly maxRetainedHeapGrowthBytes: number;
  readonly maxHeapSlopeBytesPerIteration: number;
  readonly maxRetainedRssGrowthBytes: number;
  readonly maxRssSlopeBytesPerIteration: number;
}

export interface ReplayParserSoakResult extends ReplayParserSoakMeasurement {
  readonly firstWindowMedianRssBytes: number;
  readonly lastWindowMedianRssBytes: number;
  readonly firstWindowMedianHeapBytes: number;
  readonly lastWindowMedianHeapBytes: number;
  readonly retainedRssGrowthBytes: number;
  readonly retainedHeapGrowthBytes: number;
  readonly rssSlopeBytesPerIteration: number;
  readonly heapSlopeBytesPerIteration: number;
  readonly budget: ReplayParserSoakBudget;
}

export interface ReplayParserSoakReport {
  readonly schemaVersion: 1;
  readonly runtime: string;
  readonly platform: string;
  readonly architecture: string;
  readonly machine: {
    readonly cpuModel: string;
    readonly logicalCpuCount: number;
  };
  readonly results: readonly ReplayParserSoakResult[];
}

export const RETENTION_BUDGET: ReplayParserSoakBudget = {
  maxRetainedHeapGrowthBytes: 64 * MIB,
  maxHeapSlopeBytesPerIteration: 512 * 1024,
  maxRetainedRssGrowthBytes: 128 * MIB,
  maxRssSlopeBytesPerIteration: MIB,
};

export function median(values: readonly number[]): number {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    throw new Error("Median requires at least one finite value");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[midpoint - 1]! + sorted[midpoint]!) / 2
    : sorted[midpoint]!;
}

export function leastSquaresSlope(values: readonly number[]): number {
  if (values.length < 2 || values.some((value) => !Number.isFinite(value))) {
    throw new Error("Least-squares slope requires at least two finite values");
  }
  const meanIteration = (values.length + 1) / 2;
  const meanValue = values.reduce((sum, value) => sum + value, 0) / values.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < values.length; index++) {
    const iterationDelta = index + 1 - meanIteration;
    numerator += iterationDelta * (values[index]! - meanValue);
    denominator += iterationDelta * iterationDelta;
  }
  return numerator / denominator;
}

export function analyzeSoakResult(measurement: ReplayParserSoakMeasurement): ReplayParserSoakResult {
  if (measurement.samples.length !== measurement.measuredIterations || measurement.samples.length < 2) {
    throw new Error(
      `${measurement.name} expected ${measurement.measuredIterations} samples, received ${measurement.samples.length}`,
    );
  }
  for (const [index, sample] of measurement.samples.entries()) {
    if (
      sample.iteration !== index + 1 ||
      !Number.isFinite(sample.postGcRssBytes) ||
      !Number.isFinite(sample.postGcHeapBytes)
    ) {
      throw new Error(`${measurement.name} contains an invalid post-GC sample at iteration ${index + 1}`);
    }
  }

  const firstWindow = measurement.samples.slice(0, 10);
  const lastWindow = measurement.samples.slice(-10);
  const firstWindowMedianRssBytes = median(firstWindow.map((sample) => sample.postGcRssBytes));
  const lastWindowMedianRssBytes = median(lastWindow.map((sample) => sample.postGcRssBytes));
  const firstWindowMedianHeapBytes = median(firstWindow.map((sample) => sample.postGcHeapBytes));
  const lastWindowMedianHeapBytes = median(lastWindow.map((sample) => sample.postGcHeapBytes));

  return {
    ...measurement,
    firstWindowMedianRssBytes,
    lastWindowMedianRssBytes,
    firstWindowMedianHeapBytes,
    lastWindowMedianHeapBytes,
    retainedRssGrowthBytes: Math.max(0, lastWindowMedianRssBytes - firstWindowMedianRssBytes),
    retainedHeapGrowthBytes: Math.max(0, lastWindowMedianHeapBytes - firstWindowMedianHeapBytes),
    rssSlopeBytesPerIteration: leastSquaresSlope(
      measurement.samples.map((sample) => sample.postGcRssBytes),
    ),
    heapSlopeBytesPerIteration: leastSquaresSlope(
      measurement.samples.map((sample) => sample.postGcHeapBytes),
    ),
    budget: RETENTION_BUDGET,
  };
}

function formatBytes(bytes: number): string {
  return `${(bytes / MIB).toFixed(1)} MiB`;
}

export function retentionBudgetFailures(results: readonly ReplayParserSoakResult[]): string[] {
  const failures: string[] = [];
  for (const result of results) {
    if (
      result.retainedHeapGrowthBytes > result.budget.maxRetainedHeapGrowthBytes &&
      result.heapSlopeBytesPerIteration > result.budget.maxHeapSlopeBytesPerIteration
    ) {
      failures.push(
        `${result.name} post-GC heap retained growth ${formatBytes(result.retainedHeapGrowthBytes)} ` +
        `(limit ${formatBytes(result.budget.maxRetainedHeapGrowthBytes)}) and slope ` +
        `${formatBytes(result.heapSlopeBytesPerIteration)}/iteration ` +
        `(limit ${formatBytes(result.budget.maxHeapSlopeBytesPerIteration)}/iteration)`,
      );
    }
    if (
      result.retainedRssGrowthBytes > result.budget.maxRetainedRssGrowthBytes &&
      result.rssSlopeBytesPerIteration > result.budget.maxRssSlopeBytesPerIteration
    ) {
      failures.push(
        `${result.name} post-GC RSS retained growth ${formatBytes(result.retainedRssGrowthBytes)} ` +
        `(limit ${formatBytes(result.budget.maxRetainedRssGrowthBytes)}) and slope ` +
        `${formatBytes(result.rssSlopeBytesPerIteration)}/iteration ` +
        `(limit ${formatBytes(result.budget.maxRssSlopeBytesPerIteration)}/iteration)`,
      );
    }
  }
  return failures;
}

function argumentValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const argument = process.argv.find((candidate) => candidate === name || candidate.startsWith(prefix));
  if (argument === name) throw new Error(`${name} requires a value`);
  return argument?.slice(prefix.length);
}

function integerArgument(name: string, defaultValue: number, minimum: number, maximum: number): number {
  const rawValue = argumentValue(name);
  if (rawValue === undefined) return defaultValue;
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}, received ${rawValue}`);
  }
  return value;
}

function parseWorkerMeasurement(
  raw: string,
  scenario: ReplayParserSoakScenarioName,
  warmupIterations: number,
  measuredIterations: number,
): ReplayParserSoakMeasurement {
  const value = JSON.parse(raw) as Partial<ReplayParserSoakMeasurement>;
  if (
    value.name !== scenario ||
    typeof value.fixture !== "string" ||
    !Number.isInteger(value.framesPerIteration) ||
    value.framesPerIteration! <= 0 ||
    value.semanticCount !== (scenario === "replay" ? 8 : 0) ||
    value.warmupIterations !== warmupIterations ||
    value.measuredIterations !== measuredIterations ||
    !Number.isFinite(value.durationMs) ||
    value.durationMs! < 0 ||
    !Array.isArray(value.samples) ||
    value.samples.length !== measuredIterations
  ) {
    throw new Error(`${scenario} soak worker returned a malformed result`);
  }
  return value as ReplayParserSoakMeasurement;
}

function printResults(results: readonly ReplayParserSoakResult[]): void {
  for (const result of results) {
    console.log(
      `[telemetry-soak] ${result.name}: heap growth ${formatBytes(result.retainedHeapGrowthBytes)}, ` +
      `heap slope ${formatBytes(result.heapSlopeBytesPerIteration)}/iteration, ` +
      `RSS growth ${formatBytes(result.retainedRssGrowthBytes)}, ` +
      `RSS slope ${formatBytes(result.rssSlopeBytesPerIteration)}/iteration`,
    );
  }
}

async function runController(): Promise<void> {
  const measuredIterations = integerArgument("--iterations", 100, 20, 1_000);
  const warmupIterations = integerArgument("--warmup", 10, 1, 100);
  const outputArgument = argumentValue("--output") ?? "telemetry-soak-results.json";
  if (outputArgument.length === 0) throw new Error("--output requires a non-empty path");
  const outputPath = resolve(outputArgument);
  const tempRoot = mkdtempSync(join(tmpdir(), "raceiq-telemetry-soak-"));
  const results: ReplayParserSoakResult[] = [];

  try {
    for (const scenario of SCENARIOS) {
      const dataDir = join(tempRoot, scenario, "data");
      const resultPath = join(tempRoot, `${scenario}.json`);
      mkdirSync(dataDir, { recursive: true });
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          resolve("test/benchmarks/replay-parser-worker.ts"),
          `--scenario=${scenario}`,
          `--result=${resultPath}`,
          "--mode=soak",
          `--iterations=${measuredIterations}`,
          `--warmup=${warmupIterations}`,
        ],
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
      if (exitCode !== 0) throw new Error(`${scenario} soak child exited with code ${exitCode}`);
      const measurement = parseWorkerMeasurement(
        readFileSync(resultPath, "utf8"),
        scenario,
        warmupIterations,
        measuredIterations,
      );
      results.push(analyzeSoakResult(measurement));
    }

    const cpuInfo = cpus();
    const report: ReplayParserSoakReport = {
      schemaVersion: 1,
      runtime: `bun ${Bun.version}`,
      platform: process.platform,
      architecture: process.arch,
      machine: {
        cpuModel: cpuInfo[0]?.model ?? "unknown",
        logicalCpuCount: cpuInfo.length,
      },
      results,
    };
    await Bun.write(outputPath, JSON.stringify(report, null, 2));
    printResults(results);
    console.log(`[telemetry-soak] report written to ${outputPath}`);

    const failures = retentionBudgetFailures(results);
    if (failures.length === 0) {
      console.log("All parser/replay post-GC retention budgets passed.");
    } else {
      for (const failure of failures) console.error(`[telemetry-soak] budget failed: ${failure}`);
      if (!process.argv.includes("--no-enforce")) process.exitCode = 1;
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) await runController();
