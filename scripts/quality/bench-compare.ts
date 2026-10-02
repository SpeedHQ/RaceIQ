#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { pairedHierarchicalMedianChange, type HierarchicalPair, type RelativeEstimate } from "../../test/benchmarks/benchmark-statistics";
import type { ProcessBenchmarkConfig, ProcessBenchmarkContext, ProcessBenchmarkReport } from "../../test/benchmarks/process-bench-contracts";

const args = process.argv.slice(2);
const option = (name: string): string | undefined => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const numberOption = (name: string, fallback: number): number => {
  const value = Number(option(name) ?? fallback);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`);
  return value;
};
const medianThreshold = numberOption("--median-threshold", 10);
const retainedHeapThreshold = numberOption("--retained-heap-threshold", 10);
const maxCpuError = numberOption("--max-cpu-error", 3);
const maxRetainedHeapError = numberOption("--max-retained-heap-error", 5);
const bootstrapSamples = numberOption("--bootstrap-samples", 10_000);
const title = option("--title") ?? "Replay benchmark comparison";
const files = args.filter((arg) => !arg.startsWith("--"));
if (files.length === 0 || files.length % 2 !== 0 || !Number.isInteger(bootstrapSamples) || bootstrapSamples <= 0) throw new Error("Expected paired report files and positive integer bootstrap samples");

function fail(message: string): never { throw new Error(message); }
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function isConfig(value: unknown): value is ProcessBenchmarkConfig {
  if (typeof value !== "object" || value === null) return false;
  const config = value as Record<string, unknown>;
  return Number.isInteger(config.processes) && Number(config.processes) > 0
    && Number.isInteger(config.retainedProcesses) && Number(config.retainedProcesses) > 0
    && Number.isInteger(config.retainedWarmups) && Number(config.retainedWarmups) >= 0
    && finite(config.warmupMs) && config.warmupMs >= 0 && finite(config.measurementMs) && config.measurementMs >= 0
    && Number.isInteger(config.minSamples) && Number(config.minSamples) > 0
    && Number.isInteger(config.maxSamples) && Number(config.maxSamples) >= Number(config.minSamples)
    && (config.caseOrder === "forward" || config.caseOrder === "reverse");
}
function isContext(value: unknown): value is ProcessBenchmarkContext {
  if (typeof value !== "object" || value === null) return false;
  const context = value as Record<string, unknown>;
  const cpu = context.cpu as Record<string, unknown> | undefined;
  const os = context.os as Record<string, unknown> | undefined;
  return typeof context.runtime === "string" && typeof cpu?.name === "string" && Number.isInteger(cpu.logicalCount) && Number(cpu.logicalCount) > 0
    && typeof os?.platform === "string" && typeof os.release === "string" && typeof os.arch === "string";
}
function readReport(path: string): ProcessBenchmarkReport {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch (error) { fail(`Malformed JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  if (typeof value !== "object" || value === null) fail(`${path}: report must be object`);
  const report = value as Record<string, unknown>;
  if (report.schemaVersion !== 2 || report.suite !== "replay" || typeof report.revision !== "string" || !isConfig(report.config) || !isContext(report.context) || typeof report.cases !== "object" || report.cases === null) fail(`${path}: invalid schema version, suite, config, context, or cases`);
  for (const [key, entry] of Object.entries(report.cases)) {
    if (typeof entry !== "object" || entry === null) fail(`${path}: case ${key} is malformed`);
    const value = entry as Record<string, unknown>;
    if (!Array.isArray(value.timing) || !Array.isArray(value.retainedHeapDeltas) || value.timing.length !== report.config.processes || value.retainedHeapDeltas.length !== report.config.retainedProcesses) fail(`${path}: case ${key} has wrong process/sample counts`);
    for (const child of value.timing) {
      if (typeof child !== "object" || child === null) fail(`${path}: case ${key} has malformed timing child`);
      const timing = child as Record<string, unknown>;
      if (!Array.isArray(timing.samplesNs) || !timing.samplesNs.every(finite)) fail(`${path}: case ${key} has malformed timing samples`);
      const samples = timing.samplesNs;
      if (samples.length < report.config.minSamples || samples.length > report.config.maxSamples) fail(`${path}: case ${key} timing sample count outside config`);
    }
    if (!value.retainedHeapDeltas.every(finite)) fail(`${path}: case ${key} has malformed retained heap samples`);
  }
  if (Object.keys(report.cases).length === 0) fail(`${path}: cases must not be empty`);
  return report as ProcessBenchmarkReport;
}
function equal(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

type Pair = { base: ProcessBenchmarkReport; current: ProcessBenchmarkReport };
const pairs: Pair[] = [];
for (let index = 0; index < files.length; index += 2) {
  const base = readReport(files[index]!);
  const current = readReport(files[index + 1]!);
  if (!equal(base.context, current.context) || !equal(base.config, current.config) || base.config.caseOrder !== current.config.caseOrder) fail(`Pair ${index / 2 + 1}: base/current context, config, or case order mismatch`);
  const baseKeys = Object.keys(base.cases).sort();
  const currentKeys = Object.keys(current.cases).sort();
  if (!equal(baseKeys, currentKeys)) fail(`Pair ${index / 2 + 1}: case sets mismatch`);
  pairs.push({ base, current });
}

function fmt(value: number): string { return Number.isFinite(value) ? value.toFixed(2) : "unmeasurable"; }
function classify(result: RelativeEstimate | null, threshold: number, errorBudget: number): "PASS" | "REGRESSION" | "INCONCLUSIVE" {
  if (!result) return "INCONCLUSIVE";
  if (result.ci95[0] > threshold) return "REGRESSION";
  if (result.ci95[1] <= threshold && result.marginPct <= errorBudget) return "PASS";
  return "INCONCLUSIVE";
}
function median(values: readonly number[]): number { const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!; }

const rows: string[] = [];
let inconclusive = false;
let regression = false;
for (const key of Object.keys(pairs[0]!.base.cases).sort()) {
  const cpuPairs: HierarchicalPair[] = pairs.map(({ base, current }) => ({
    base: base.cases[key]!.timing.map((child) => child.samplesNs),
    current: current.cases[key]!.timing.map((child) => child.samplesNs),
  }));
  const heapPairs: HierarchicalPair[] = pairs.map(({ base, current }) => ({
    base: base.cases[key]!.retainedHeapDeltas.map((value) => [value]),
    current: current.cases[key]!.retainedHeapDeltas.map((value) => [value]),
  }));
  for (const [metric, hierarchical, threshold, budget, baseValues, currentValues] of [
    ["CPU", cpuPairs, medianThreshold, maxCpuError, cpuPairs[0]!.base.flat(), cpuPairs[0]!.current.flat()],
    ["retained heap", heapPairs, retainedHeapThreshold, maxRetainedHeapError, heapPairs[0]!.base.flat(), heapPairs[0]!.current.flat()],
  ] as const) {
    const result = pairedHierarchicalMedianChange(hierarchical, { bootstrapSamples, seed: 0x322 });
    const status = classify(result, threshold, budget);
    inconclusive ||= status === "INCONCLUSIVE";
    regression ||= status === "REGRESSION";
    rows.push(`| ${key} (${metric}) | ${fmt(median(baseValues))} | ${fmt(median(currentValues))} | ${result ? `${result.estimatePct.toFixed(2)}% (${result.ci95[0].toFixed(2)}%, ${result.ci95[1].toFixed(2)}%)` : "unmeasurable"} | ${result ? `${result.marginPct.toFixed(2)}%` : "—"} | ${status} |`);
  }
}
const context = pairs[0]!.current.context;
const config = pairs[0]!.current.config;
console.log(`## ${title}\n\nRuntime: \`${context.runtime}\`; CPU: \`${context.cpu.name}\` (${context.cpu.logicalCount} logical); OS: \`${context.os.platform} ${context.os.release} ${context.os.arch}\`\n\nLaunches: processes=${config.processes}, retainedProcesses=${config.retainedProcesses}, retainedWarmups=${config.retainedWarmups}; warmup=${config.warmupMs}ms, measurement=${config.measurementMs}ms, samples=${config.minSamples}-${config.maxSamples}; caseOrder=${config.caseOrder}\n\n| Case | Baseline median | Current median | Estimated change (95% CI) | CI margin | Result |\n|---|---:|---:|---:|---:|---|\n${rows.join("\n")}`);
if (regression && args.includes("--fail-on-regression")) process.exit(1);
