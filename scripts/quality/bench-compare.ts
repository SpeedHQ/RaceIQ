#!/usr/bin/env bun
/**
 * Compare paired mitata bench-results.json files and emit a markdown diff.
 * Usage: bun scripts/quality/bench-compare.ts <base-1.json> <current-1.json> [<base-2.json> <current-2.json> ...]
 */
import { readFileSync } from "node:fs";

type Stats = { p50: number; p99: number; retainedHeap?: { p50: number } };
type Bench = { alias: string; group: number; runs: { stats?: Stats }[] };
type Layout = { name: string | null }[];
type Context = { runtime: string | null; cpu: { name: string | null } };
type RawProcess = { timing?: Record<string, { samplesNs?: number[] }> };
type Results = { layout: Layout; context: Context; benchmarks: Bench[]; rawProcesses?: RawProcess[] };
type Entry = { key: string; median: number; p99: number; retainedHeap?: number };
type Pair = { base: Results; current: Results; baseEntries: Map<string, Entry>; currentEntries: Map<string, Entry> };

const robustSpread = (report: Results, key: string): number | undefined => {
  const values = report.rawProcesses?.map((raw) => {
    const samples = raw.timing?.[key]?.samplesNs;
    if (!samples?.length) return undefined;
    return median(samples);
  }).filter((value): value is number => value !== undefined);
  if (!values?.length) return undefined;
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center))) / (center || 1) * 100;
};

const args = process.argv.slice(2);
const option = (prefix: string): string | undefined => args.find((arg) => arg.startsWith(`${prefix}=`))?.slice(prefix.length + 1);
const usage = "Usage: bun scripts/quality/bench-compare.ts <base-1.json> <current-1.json> [<base-2.json> <current-2.json> ...] [--median-threshold=5] [--p99-threshold=5] [--retained-heap-threshold=5] [--include=<prefix>] [--exclude=<prefix>] [--informational] [--title=<heading>]";
const threshold = (name: string): number => {
  const raw = option(name);
  const value = Number(raw ?? 5);
  if (raw !== undefined && (raw.trim() === "" || !Number.isFinite(value) || value < 0)) {
    console.error(`${name} must be a finite non-negative number\n${usage}`);
    process.exit(1);
  }
  return value;
};
const medianThreshold = threshold("--median-threshold");
const p99Threshold = threshold("--p99-threshold");
const retainedHeapThreshold = threshold("--retained-heap-threshold");
const includePrefix = option("--include");
const excludePrefix = option("--exclude");
const informational = args.includes("--informational");
const title = option("--title");
const files = args.filter((arg) => !arg.startsWith("--"));

if (args.some((arg) => arg.startsWith("--threshold=")) || files.length === 0 || files.length % 2 !== 0) {
  console.error(usage);
  process.exit(1);
}

function readReport(path: string): Results {
  return JSON.parse(readFileSync(path, "utf-8")) as Results;
}

function extract(report: Results): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  for (const benchmark of report.benchmarks) {
    const stats = benchmark.runs[0]?.stats;
    if (!stats) continue;
    const groupName = report.layout[benchmark.group]?.name ?? "root";
    const key = `${groupName}/${benchmark.alias}`;
    entries.set(key, {
      key,
      median: stats.p50,
      p99: stats.p99,
      retainedHeap: stats.retainedHeap?.p50,
    });
  }
  return entries;
}

const pairs: Pair[] = [];
for (let index = 0; index < files.length; index += 2) {
  const base = readReport(files[index]!);
  const current = readReport(files[index + 1]!);
  const baseRuntime = base.context.runtime ?? "?";
  const currentRuntime = current.context.runtime ?? "?";
  const baseCpu = base.context.cpu.name ?? "?";
  const currentCpu = current.context.cpu.name ?? "?";
  if (baseRuntime !== currentRuntime || baseCpu !== currentCpu) {
    console.error(`Context mismatch in pair ${index / 2 + 1}: base ${baseRuntime}/${baseCpu}, current ${currentRuntime}/${currentCpu}`);
    process.exit(1);
  }
  pairs.push({ base, current, baseEntries: extract(base), currentEntries: extract(current) });
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}
function fmtTime(ns: number): string {
  if (ns < 1000) return `${ns.toFixed(0)} ns`;
  if (ns < 1_000_000) return `${(ns / 1000).toFixed(2)} µs`;
  return `${(ns / 1_000_000).toFixed(2)} ms`;
}


function pct(current: number, base: number): number {
  return base === 0 ? 0 : ((current - base) / base) * 100;
}

function sign(change: number): string {
  if (Math.abs(change) < 0.5) return "≈";
  return change > 0 ? "🔴" : "🟢";
}

function fmtDelta(change: number): string {
  return `${sign(change)} ${change > 0 ? "+" : ""}${change.toFixed(1)}%`;
}

const allKeys = new Set<string>();
for (const pair of pairs) {
  for (const key of pair.baseEntries.keys()) allKeys.add(key);
  for (const key of pair.currentEntries.keys()) allKeys.add(key);
}
const keys = [...allKeys].filter((key) => (!includePrefix || key.startsWith(includePrefix)) && (!excludePrefix || !key.startsWith(excludePrefix))).sort();
const varianceDiagnostics: string[] = [];
if (keys.length === 0 && includePrefix) {
  console.error(`No benchmarks match --include=${includePrefix}`);
  process.exit(1);
}
if (keys.length === 0 && excludePrefix) {
  console.error(`No benchmarks remain after --exclude=${excludePrefix}`);
  process.exit(1);
}

const rows: string[] = [];
const regressions: string[] = [];
let baselinePending = false;
for (const key of keys) {
  const baseEntries = pairs.map((pair) => pair.baseEntries.get(key));
  const currentEntries = pairs.map((pair) => pair.currentEntries.get(key));
  if (currentEntries.some((entry) => !entry)) {
    console.error(`Current result missing for ${key} in one or more report pairs`);
    process.exit(1);
  }
  for (let pairIndex = 0; pairIndex < pairs.length; pairIndex++) {
    const baseSpread = robustSpread(pairs[pairIndex]!.base, key);
    const currentSpread = robustSpread(pairs[pairIndex]!.current, key);
    if ((baseSpread !== undefined && baseSpread > 25) || (currentSpread !== undefined && currentSpread > 25)) {
      varianceDiagnostics.push(`${key} pair ${pairIndex + 1}: high process variance (MAD ${baseSpread?.toFixed(1) ?? "—"}% base, ${currentSpread?.toFixed(1) ?? "—"}% current)`);
    }
  }
  const currentValues = currentEntries as Entry[];
  const baseValues = baseEntries.filter((entry): entry is Entry => entry !== undefined);
  if (baseValues.length !== pairs.length) {
    baselinePending = true;
    const currentMedian = median(currentValues.map((entry) => entry.median));
    const currentP99 = median(currentValues.map((entry) => entry.p99));
    rows.push(`| ${key} | — | ${fmtTime(currentMedian)} / ${fmtTime(currentP99)} | Baseline pending | — | — |`);
    continue;
  }

  const baseMedian = median(baseValues.map((entry) => entry.median));
  const currentMedian = median(currentValues.map((entry) => entry.median));
  const baseP99 = median(baseValues.map((entry) => entry.p99));
  const currentP99 = median(currentValues.map((entry) => entry.p99));
  const medianChange = median(pairs.map((_, index) => pct(currentValues[index]!.median, baseValues[index]!.median)));
  const p99Change = median(pairs.map((_, index) => pct(currentValues[index]!.p99, baseValues[index]!.p99)));
  const retainedReady = pairs.every((_, index) => baseValues[index]!.retainedHeap !== undefined && currentValues[index]!.retainedHeap !== undefined);
  const retainedChange = retainedReady
    ? median(pairs.map((_, index) => pct(currentValues[index]!.retainedHeap!, baseValues[index]!.retainedHeap!)))
    : undefined;
  const retainedDisplay = retainedReady ? fmtDelta(retainedChange!) : "—";
  rows.push(`| ${key} | ${fmtTime(baseMedian)} / ${fmtTime(baseP99)} | ${fmtTime(currentMedian)} / ${fmtTime(currentP99)} | ${fmtDelta(medianChange)} | ${fmtDelta(p99Change)} | ${retainedDisplay} |`);
  if (!informational) {
    if (medianChange > medianThreshold) regressions.push(`- **${key}**: median +${medianChange.toFixed(1)}%`);
    if (p99Change > p99Threshold) regressions.push(`- **${key}**: p99 +${p99Change.toFixed(1)}%`);
    if (retainedReady && retainedChange! > retainedHeapThreshold) regressions.push(`- **${key}**: retained heap +${retainedChange!.toFixed(1)}%`);
  }
}

const reportTitle = title ?? (informational ? "Informational microbenchmarks" : "Bench comparison");
const reportNote = informational
  ? `\n\n_Report-only. Small timings can vary between runs._${includePrefix ? `\nIncluded benchmarks: \`${includePrefix}*\`` : ""}`
  : `\nThresholds: median ±${medianThreshold}%; p99 ±${p99Threshold}%; retained heap ±${retainedHeapThreshold}%${includePrefix ? `\nIncluded benchmarks: \`${includePrefix}*\`` : ""}`;
const currentContext = pairs[0]!.current.context;
const header = `## ${reportTitle}\n\nRuntime: \`${currentContext.runtime ?? "?"}\` on \`${currentContext.cpu.name ?? "?"}\`${reportNote}`;
const body = rows.join("\n");
const footer = informational
  ? ""
  : regressions.length
    ? `\n\n### Regressions\n${regressions.join("\n")}`
    : baselinePending
      ? "\n\n_Baseline pending. Regression assessment starts after matching results exist on the base branch._"
      : "\n\n_No regressions above configured thresholds._";
const diagnostics = varianceDiagnostics.length
  ? `\n\n### Diagnostics\n${varianceDiagnostics.map((diagnostic) => `- ${diagnostic}`).join("\n")}`
  : "";
console.log(`${header}\n\n| Bench | Baseline median / p99 | Current median / p99 | Δ median | Δ p99 | Δ retained heap |\n|---|---:|---:|---:|---:|---:|\n${body}${diagnostics}${footer}`);
if (regressions.length > 0 && args.includes("--fail-on-regression")) process.exit(1);
