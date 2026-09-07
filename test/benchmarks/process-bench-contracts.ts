import type { RetainedHeapChildReport, TimingChildReport } from "./process-bench-runtime";

export type { RetainedHeapChildReport, TimingChildReport } from "./process-bench-runtime";

export type TimingChildConfig = {
  readonly command: string[];
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly kind: "timing";
  readonly expectedSamples: { min: number; max: number };
};

export type RetainedHeapChildConfig = {
  readonly command: string[];
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly kind: "retainedHeap";
};

export type ChildBenchmarkConfig = TimingChildConfig | RetainedHeapChildConfig;

export type ProcessBenchmarkConfig = {
  processes: number;
  retainedProcesses: number;
  retainedWarmups: number;
  warmupMs: number;
  measurementMs: number;
  minSamples: number;
  maxSamples: number;
  caseOrder: "forward" | "reverse";
};

export type ProcessBenchmarkContext = {
  runtime: string;
  cpu: { name: string; logicalCount: number };
  os: { platform: string; release: string; arch: string };
};

export type ProcessBenchmarkReport = {
  schemaVersion: 2;
  revision: string;
  suite: "replay";
  config: ProcessBenchmarkConfig;
  context: ProcessBenchmarkContext;
  cases: Record<string, { timing: TimingChildReport[]; retainedHeapDeltas: number[] }>;
};

function isTimingReport(value: unknown, expectedSamples: { min: number; max: number }): value is TimingChildReport {
  if (typeof value !== "object" || value === null) return false;
  const report = value as Partial<TimingChildReport>;
  return typeof report.warmupIterations === "number" && Number.isInteger(report.warmupIterations) && report.warmupIterations >= 0
    && typeof report.warmupNs === "number" && Number.isFinite(report.warmupNs) && report.warmupNs >= 0
    && typeof report.measurementNs === "number" && Number.isFinite(report.measurementNs) && report.measurementNs >= 0
    && Array.isArray(report.samplesNs)
    && report.samplesNs.length >= expectedSamples.min
    && report.samplesNs.length <= expectedSamples.max
    && report.samplesNs.every((sample) => typeof sample === "number" && Number.isFinite(sample) && sample >= 0);
}

function isRetainedHeapReport(value: unknown): value is RetainedHeapChildReport {
  return typeof value === "object" && value !== null
    && typeof (value as RetainedHeapChildReport).deltaBytes === "number"
    && Number.isFinite((value as RetainedHeapChildReport).deltaBytes);
}

async function runChild(config: ChildBenchmarkConfig): Promise<unknown> {
  if (config.command.length === 0) throw new Error("Child benchmark command must not be empty");
  const child = Bun.spawn(config.command, { cwd: config.cwd, env: config.env, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`Child benchmark exited with code ${exitCode}: ${stderr.trim()}`);
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) throw new Error(`Expected one JSON line from child benchmark, received ${lines.length}`);
  let report: unknown;
  try {
    report = JSON.parse(lines[0]!);
  } catch (error) {
    throw new Error(`Child benchmark emitted malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (config.kind === "timing" && !isTimingReport(report, config.expectedSamples)) throw new Error("Child benchmark timing report has invalid fields or sample count");
  if (config.kind === "retainedHeap" && !isRetainedHeapReport(report)) throw new Error("Child benchmark retained heap must be finite");
  return report;
}

export function runChildBenchmark(config: TimingChildConfig): Promise<TimingChildReport>;
export function runChildBenchmark(config: RetainedHeapChildConfig): Promise<RetainedHeapChildReport>;
export async function runChildBenchmark(config: ChildBenchmarkConfig): Promise<TimingChildReport | RetainedHeapChildReport> {
  return await runChild(config) as TimingChildReport | RetainedHeapChildReport;
}
