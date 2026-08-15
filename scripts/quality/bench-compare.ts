#!/usr/bin/env bun
/**
 * Compare two mitata bench-results.json files and emit a markdown diff.
 * Usage: bun scripts/quality/bench-compare.ts <baseline.json> <current.json> [--threshold=5] [--p99-threshold=5] [--include=<prefix>] [--exclude=<prefix>] [--informational] [--title=<heading>]
 *
 * Thresholds (%) control what counts as a regression flag in the output.
 * Informational reports show absolute measurements without deltas or judgments.
 */
import { readFileSync } from "node:fs";

type Stats = { p50: number; p99: number; heap?: { avg: number } };
type Bench = { alias: string; group: number; runs: { stats?: Stats }[] };
type Layout = { name: string | null }[];
type Context = {
  runtime: string | null;
  cpu: { name: string | null };
};
type Results = { layout: Layout; context: Context; benchmarks: Bench[] };

const args = process.argv.slice(2);
const threshold = Number(args.find((a) => a.startsWith("--threshold="))?.split("=")[1] ?? 5);
const p99Threshold = Number(args.find((a) => a.startsWith("--p99-threshold="))?.split("=")[1] ?? threshold);
const includePrefix = args.find((a) => a.startsWith("--include="))?.split("=")[1];
const excludePrefix = args.find((a) => a.startsWith("--exclude="))?.split("=")[1];
const informational = args.includes("--informational");
const title = args.find((a) => a.startsWith("--title="))?.slice("--title=".length);
const files = args.filter((a) => !a.startsWith("--"));
if (files.length !== 2) {
  console.error(
    "Usage: bun scripts/quality/bench-compare.ts <baseline.json> <current.json> [--threshold=5] [--p99-threshold=5] [--include=<prefix>] [--exclude=<prefix>] [--informational] [--title=<heading>]",
  );
  process.exit(1);
}
const [baselinePath, currentPath] = files;

const baseline = JSON.parse(readFileSync(baselinePath, "utf-8")) as Results;
const current = JSON.parse(readFileSync(currentPath, "utf-8")) as Results;

type Entry = { key: string; median: number; p99: number; heap: number };
function extract(r: Results): Map<string, Entry> {
  const out = new Map<string, Entry>();
  for (const b of r.benchmarks) {
    const groupName = r.layout[b.group]?.name ?? "root";
    const stats = b.runs[0]?.stats;
    if (!stats) continue;
    out.set(`${groupName}/${b.alias}`, { key: `${groupName}/${b.alias}`, median: stats.p50, p99: stats.p99, heap: stats.heap?.avg ?? 0 });
  }
  return out;
}

const base = extract(baseline);
const cur = extract(current);
const keys = [...new Set([...base.keys(), ...cur.keys()])].filter((key) => (!includePrefix || key.startsWith(includePrefix)) && (!excludePrefix || !key.startsWith(excludePrefix))).sort();
if (keys.length === 0 && includePrefix) {
  console.error(`No benchmarks match --include=${includePrefix}`);
  process.exit(1);
}
if (keys.length === 0 && excludePrefix) {
  console.error(`No benchmarks remain after --exclude=${excludePrefix}`);
  process.exit(1);
}

function fmtTime(ns: number): string {
  if (ns < 1000) return `${ns.toFixed(0)} ns`;
  if (ns < 1_000_000) return `${(ns / 1000).toFixed(2)} µs`;
  return `${(ns / 1_000_000).toFixed(2)} ms`;
}
function fmtBytes(b: number): string {
  if (b < 1024) return `${b.toFixed(0)} b`;
  return `${(b / 1024).toFixed(2)} kb`;
}
function pct(a: number, b: number): number {
  return b === 0 ? 0 : ((a - b) / b) * 100;
}
function sign(p: number): string {
  if (Math.abs(p) < 0.5) return "≈";
  return p > 0 ? "🔴" : "🟢";
}

const rows: string[] = [];
const regressions: string[] = [];
let baselinePending = false;
if (informational) {
  rows.push(`| Bench | Baseline median / p99 | Current median / p99 | Baseline alloc / current alloc |`);
  rows.push(`|---|---:|---:|---:|`);
} else {
  rows.push(`| Bench | Baseline median / p99 | Current median / p99 | Δ median | Δ p99 | Δ alloc |`);
  rows.push(`|---|---:|---:|---:|---:|---:|`);
}
for (const key of keys) {
  const b = base.get(key);
  const c = cur.get(key);
  if (informational) {
    rows.push(
      `| ${key} | ${b ? `${fmtTime(b.median)} / ${fmtTime(b.p99)}` : "—"} | ${c ? `${fmtTime(c.median)} / ${fmtTime(c.p99)}` : "—"} | ${b ? fmtBytes(b.heap) : "—"} / ${c ? fmtBytes(c.heap) : "—"} |`,
    );
    continue;
  }
  if (!b || !c) {
    baselinePending ||= !b && c !== undefined;
    rows.push(
      `| ${key} | ${b ? `${fmtTime(b.median)} / ${fmtTime(b.p99)}` : "—"} | ${c ? `${fmtTime(c.median)} / ${fmtTime(c.p99)}` : "—"} | ${!b && c ? "Baseline pending" : "Current result missing"} | — | — |`,
    );
    continue;
  }
  const medianChange = pct(c.median, b.median);
  const p99Change = pct(c.p99, b.p99);
  const heapChange = pct(c.heap, b.heap);
  rows.push(
    `| ${key} | ${fmtTime(b.median)} / ${fmtTime(b.p99)} | ${fmtTime(c.median)} / ${fmtTime(c.p99)} | ${sign(medianChange)} ${medianChange > 0 ? "+" : ""}${medianChange.toFixed(1)}% | ${sign(p99Change)} ${p99Change > 0 ? "+" : ""}${p99Change.toFixed(1)}% | ${sign(heapChange)} ${heapChange > 0 ? "+" : ""}${heapChange.toFixed(1)}% |`,
  );
  if (medianChange > threshold) regressions.push(`- **${key}**: median +${medianChange.toFixed(1)}% (${fmtTime(b.median)} → ${fmtTime(c.median)})`);
  if (p99Change > p99Threshold) regressions.push(`- **${key}**: p99 +${p99Change.toFixed(1)}% (${fmtTime(b.p99)} → ${fmtTime(c.p99)})`);
  if (heapChange > threshold && b.heap > 0) regressions.push(`- **${key}**: alloc +${heapChange.toFixed(1)}% (${fmtBytes(b.heap)} → ${fmtBytes(c.heap)})`);
}

const reportTitle = title ?? (informational ? "Informational microbenchmarks" : "Bench comparison");
const reportNote = informational
  ? "\n\n_Report-only. Small timings can vary between runs._"
  : `\nThresholds: median/allocation ±${threshold}%; p99 ±${p99Threshold}%${includePrefix ? `\nIncluded benchmarks: \`${includePrefix}*\`` : ""}`;
const header = `## ${reportTitle}\n\nRuntime: \`${current.context.runtime ?? "?"}\` on \`${current.context.cpu.name ?? "?"}\`${reportNote}`;
const body = rows.join("\n");
const footer = informational
  ? ""
  : regressions.length
    ? `\n\n### Regressions\n${regressions.join("\n")}`
    : baselinePending
      ? "\n\n_Baseline pending. Regression assessment starts after matching results exist on the base branch._"
      : `\n\n_No regressions above configured thresholds._`;

console.log(`${header}\n\n${body}${footer}`);

// Exit non-zero if any regression exceeds threshold AND caller asks for it
if (regressions.length > 0 && args.includes("--fail-on-regression")) process.exit(1);
