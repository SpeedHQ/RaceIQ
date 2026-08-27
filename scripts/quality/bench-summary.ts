import { readFileSync } from "node:fs";

const TIMING_FIELDS: Record<string, true> = {
  min: true, max: true, avg: true, p25: true, p50: true, p75: true,
  p99: true, p999: true, total: true, samples: true,
};

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, label: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as UnknownRecord;
}

function duration(value: number): string {
  const units = [[1e6, "ms"], [1e3, "µs"], [1, "ns"], [1e-3, "ps"]] as const;
  const [scale, unit] = units.find(([threshold]) => Math.abs(value) >= threshold) ?? units.at(-1)!;
  return `${(value / scale).toFixed(2)} ${unit}`;
}

function scalar(value: number, path: string): string {
  if (path.split(".").at(-1) && TIMING_FIELDS[path.split(".").at(-1)!]) return duration(value);
  if (path.startsWith("heap.")) return `${value.toFixed(2)} B`;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function flatten(value: unknown, path: string, rows: string[]): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    rows.push(`| \`${path}\` | ${scalar(value, path)} |`);
    return;
  }
  if (Array.isArray(value)) {
    const numbers = value.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
    if (numbers.length > 0) rows.push(`| \`${path}\` | ${numbers.length} samples (min ${scalar(Math.min(...numbers), path)}, max ${scalar(Math.max(...numbers), path)}) |`);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) flatten(child, path ? `${path}.${key}` : key, rows);
  }
}

export function formatMitataSummary(input: unknown): string {
  const root = record(input, "Mitata result");
  const context = record(root.context, "Mitata context");
  const benchmarks = root.benchmarks;
  if (!Array.isArray(benchmarks) || benchmarks.length === 0) throw new Error("No benchmark metrics emitted");
  const rows: string[] = [];
  for (const [index, rawBenchmark] of benchmarks.entries()) {
    const benchmark = record(rawBenchmark, `benchmark ${index + 1}`);
    const alias = typeof benchmark.alias === "string" ? benchmark.alias : `benchmark-${index + 1}`;
    const runs = benchmark.runs;
    if (!Array.isArray(runs) || runs.length === 0) throw new Error(`Benchmark ${alias} emitted no metrics`);
    for (const [runIndex, rawRun] of runs.entries()) {
      const run = record(rawRun, `${alias} run ${runIndex + 1}`);
      if (run.error !== undefined) throw new Error(`Benchmark ${alias} failed: ${String(record(run.error, `${alias} error`).message ?? run.error)}`);
      const stats = record(run.stats, `${alias} run ${runIndex + 1} stats`);
      const metricRows: string[] = [];
      flatten(stats, "", metricRows);
      if (metricRows.length === 0) throw new Error(`Benchmark ${alias} emitted no numeric metrics`);
      rows.push(`### ${alias}${typeof run.name === "string" && run.name !== alias ? ` — ${run.name}` : ""}\n\n| Metric | Value |\n|---|---:|\n${metricRows.join("\n")}`);
    }
  }
  const runtime = typeof context.runtime === "string" ? context.runtime : "unknown";
  const arch = typeof context.arch === "string" ? context.arch : "unknown";
  const cpu = record(context.cpu ?? {}, "Mitata CPU context");
  const cpuName = typeof cpu.name === "string" ? cpu.name : "unknown";
  return `## Pipeline benchmark metrics\n\nRuntime: \`${runtime}\`; CPU: \`${cpuName}\`; architecture: \`${arch}\`\n\n${rows.join("\n\n")}`;
}

if (import.meta.main) {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error("Usage: bench-summary.ts <mitata-json>");
  process.stdout.write(`${formatMitataSummary(JSON.parse(readFileSync(inputPath, "utf8")))}\n`);
}
