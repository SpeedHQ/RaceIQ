#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ReplayParserBenchmarkReport, ReplayParserBenchmarkResult } from "../../test/benchmarks/replay-parser.bench";

const MAX_THROUGHPUT_REGRESSION_PERCENT = 10;
const MAX_MEMORY_REGRESSION_PERCENT = 15;
const args = process.argv.slice(2);
const files = args.filter((argument) => !argument.startsWith("--"));

if (files.length !== 2) {
  console.error("Usage: bun scripts/quality/replay-parser-bench-compare.ts <baseline.json> <current.json> [--fail-on-regression]");
  process.exit(1);
}

const NonEmptyStringSchema = z.string().refine((value) => value.trim().length > 0);
const PositiveFiniteNumberSchema = z.number().finite().positive();
const NonNegativeFiniteNumberSchema = z.number().finite().nonnegative();

const BenchmarkBudgetSchema = z.object({
  maxPeakRssBytes: PositiveFiniteNumberSchema,
  maxIncrementalRssBytes: PositiveFiniteNumberSchema,
  maxIncrementalHeapBytes: PositiveFiniteNumberSchema,
});

const BenchmarkResultSchema = z.object({
  name: z.enum(["parser", "replay"]),
  fixture: NonEmptyStringSchema,
  inputFrames: z.number().finite().int().positive(),
  outputItems: z.number().finite().int().nonnegative(),
  semanticCount: z.number().finite().int().nonnegative(),
  durationMs: PositiveFiniteNumberSchema,
  throughputPerSecond: PositiveFiniteNumberSchema,
  baselineRssBytes: NonNegativeFiniteNumberSchema,
  peakRssBytes: NonNegativeFiniteNumberSchema,
  incrementalPeakRssBytes: NonNegativeFiniteNumberSchema,
  baselineHeapBytes: NonNegativeFiniteNumberSchema,
  peakHeapBytes: NonNegativeFiniteNumberSchema,
  incrementalPeakHeapBytes: NonNegativeFiniteNumberSchema,
  budget: BenchmarkBudgetSchema,
});

const BenchmarkReportSchema = z.object({
  schemaVersion: z.literal(2),
  runtime: NonEmptyStringSchema,
  platform: NonEmptyStringSchema,
  architecture: NonEmptyStringSchema,
  machine: z.object({
    cpuModel: NonEmptyStringSchema,
    logicalCpuCount: z.number().finite().int().positive(),
    totalMemoryBytes: PositiveFiniteNumberSchema,
  }),
  results: z.array(BenchmarkResultSchema).length(2).refine(
    (results) =>
      results.filter((result) => result.name === "parser").length === 1
      && results.filter((result) => result.name === "replay").length === 1,
  ),
});

function readReport(path: string): ReplayParserBenchmarkReport {
  let report: unknown;
  try {
    report = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error(`${path} is not a valid replay/parser benchmark report`);
  }
  const parsedReport = BenchmarkReportSchema.safeParse(report);
  if (!parsedReport.success) {
    throw new Error(`${path} is not a valid replay/parser benchmark report`);
  }
  return parsedReport.data;
}

function indexedResults(report: ReplayParserBenchmarkReport, path: string): Map<string, ReplayParserBenchmarkResult> {
  const results = new Map<string, ReplayParserBenchmarkResult>();
  for (const result of report.results) {
    if (results.has(result.name)) throw new Error(`${path} contains duplicate ${result.name} results`);
    results.set(result.name, result);
  }
  return results;
}

function percentChange(current: number, baseline: number): number {
  return baseline === 0 ? 0 : ((current - baseline) / baseline) * 100;
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function signedPercent(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function absoluteBudgetFailures(result: ReplayParserBenchmarkResult): string[] {
  const failures: string[] = [];
  if (result.peakRssBytes > result.budget.maxPeakRssBytes) {
    failures.push(`${result.name} peak RSS ${formatBytes(result.peakRssBytes)} exceeds ${formatBytes(result.budget.maxPeakRssBytes)}`);
  }
  if (result.incrementalPeakRssBytes > result.budget.maxIncrementalRssBytes) {
    failures.push(`${result.name} incremental RSS ${formatBytes(result.incrementalPeakRssBytes)} exceeds ${formatBytes(result.budget.maxIncrementalRssBytes)}`);
  }
  if (result.incrementalPeakHeapBytes > result.budget.maxIncrementalHeapBytes) {
    failures.push(`${result.name} incremental heap ${formatBytes(result.incrementalPeakHeapBytes)} exceeds ${formatBytes(result.budget.maxIncrementalHeapBytes)}`);
  }
  return failures;
}

function budgetRelaxationFailures(
  baseline: ReplayParserBenchmarkResult,
  current: ReplayParserBenchmarkResult,
): string[] {
  const failures: string[] = [];
  if (current.budget.maxPeakRssBytes > baseline.budget.maxPeakRssBytes) {
    failures.push(
      `${current.name} maxPeakRssBytes budget relaxed: ${formatBytes(baseline.budget.maxPeakRssBytes)} → ${formatBytes(current.budget.maxPeakRssBytes)}`,
    );
  }
  if (current.budget.maxIncrementalRssBytes > baseline.budget.maxIncrementalRssBytes) {
    failures.push(
      `${current.name} maxIncrementalRssBytes budget relaxed: ${formatBytes(baseline.budget.maxIncrementalRssBytes)} → ${formatBytes(current.budget.maxIncrementalRssBytes)}`,
    );
  }
  if (current.budget.maxIncrementalHeapBytes > baseline.budget.maxIncrementalHeapBytes) {
    failures.push(
      `${current.name} maxIncrementalHeapBytes budget relaxed: ${formatBytes(baseline.budget.maxIncrementalHeapBytes)} → ${formatBytes(current.budget.maxIncrementalHeapBytes)}`,
    );
  }
  return failures;
}

const [baselinePath, currentPath] = files;
const baselineReport = readReport(baselinePath);
const currentReport = readReport(currentPath);
const baseline = indexedResults(baselineReport, baselinePath);
const current = indexedResults(currentReport, currentPath);
const scenarioNames = [...new Set([...baseline.keys(), ...current.keys()])].sort();
const rows: string[] = [];
const failures: string[] = [];

const sameMachineConfiguration =
  baselineReport.runtime === currentReport.runtime
  && baselineReport.platform === currentReport.platform
  && baselineReport.architecture === currentReport.architecture
  && baselineReport.machine.cpuModel === currentReport.machine.cpuModel
  && baselineReport.machine.logicalCpuCount === currentReport.machine.logicalCpuCount
  && baselineReport.machine.totalMemoryBytes === currentReport.machine.totalMemoryBytes;
if (!sameMachineConfiguration) {
  failures.push("Benchmark reports came from different runtime or machine configurations");
}

rows.push("| Scenario | Throughput baseline → current | Δ throughput | Peak RSS baseline → current | Δ RSS | Peak heap baseline → current | Δ heap | Hard memory budgets |");
rows.push("|---|---:|---:|---:|---:|---:|---:|---|");

for (const name of scenarioNames) {
  const baselineResult = baseline.get(name);
  const currentResult = current.get(name);
  if (!baselineResult || !currentResult) {
    rows.push(`| ${name} | missing | — | missing | — | missing | — | failed |`);
    failures.push(`${name} is missing from ${baselineResult ? "current" : "baseline"} report`);
    continue;
  }

  const sameWorkload =
    baselineResult.fixture === currentResult.fixture
    && baselineResult.inputFrames === currentResult.inputFrames
    && baselineResult.semanticCount === currentResult.semanticCount;
  if (!sameWorkload) {
    failures.push(
      `${name} workload changed: ${baselineResult.fixture}, ${baselineResult.inputFrames} frames/${baselineResult.semanticCount} semantics → ` +
      `${currentResult.fixture}, ${currentResult.inputFrames} frames/${currentResult.semanticCount} semantics`,
    );
  }

  const throughputChange = percentChange(currentResult.throughputPerSecond, baselineResult.throughputPerSecond);
  const rssChange = percentChange(currentResult.peakRssBytes, baselineResult.peakRssBytes);
  const heapChange = percentChange(currentResult.peakHeapBytes, baselineResult.peakHeapBytes);
  const absoluteFailures = absoluteBudgetFailures(currentResult);
  const relaxationFailures = budgetRelaxationFailures(baselineResult, currentResult);
  failures.push(...absoluteFailures, ...relaxationFailures);

  if (sameMachineConfiguration && sameWorkload) {
    if (throughputChange < -MAX_THROUGHPUT_REGRESSION_PERCENT) {
      failures.push(`${name} throughput regressed ${(-throughputChange).toFixed(1)}%, limit is ${MAX_THROUGHPUT_REGRESSION_PERCENT}%`);
    }
    if (rssChange > MAX_MEMORY_REGRESSION_PERCENT) {
      failures.push(`${name} peak RSS regressed ${rssChange.toFixed(1)}%, limit is ${MAX_MEMORY_REGRESSION_PERCENT}%`);
    }
    if (heapChange > MAX_MEMORY_REGRESSION_PERCENT) {
      failures.push(`${name} peak heap regressed ${heapChange.toFixed(1)}%, limit is ${MAX_MEMORY_REGRESSION_PERCENT}%`);
    }
  }

  rows.push(
    `| ${name} | ${baselineResult.throughputPerSecond.toFixed(0)}/s → ${currentResult.throughputPerSecond.toFixed(0)}/s | ${signedPercent(throughputChange)} | ` +
    `${formatBytes(baselineResult.peakRssBytes)} → ${formatBytes(currentResult.peakRssBytes)} | ${signedPercent(rssChange)} | ` +
    `${formatBytes(baselineResult.peakHeapBytes)} → ${formatBytes(currentResult.peakHeapBytes)} | ${signedPercent(heapChange)} | ${absoluteFailures.length === 0 && relaxationFailures.length === 0 ? "pass" : "failed"} |`,
  );
}

const summary = failures.length === 0
  ? "All hard memory and same-machine relative budgets passed."
  : `Budget failures:\n${failures.map((failure) => `- ${failure}`).join("\n")}`;

console.log(
  `## Replay/parser benchmark budgets\n\n` +
  `Runtime: \`${currentReport.runtime}\` on \`${currentReport.machine.cpuModel}\` (${currentReport.machine.logicalCpuCount} logical CPUs). ` +
  `Throughput regression limit: ${MAX_THROUGHPUT_REGRESSION_PERCENT}%. Peak-memory regression limit: ${MAX_MEMORY_REGRESSION_PERCENT}%.\n\n${rows.join("\n")}\n\n${summary}`,
);

if (failures.length > 0 && args.includes("--fail-on-regression")) process.exit(1);
