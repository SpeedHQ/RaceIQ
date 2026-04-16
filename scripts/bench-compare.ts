#!/usr/bin/env bun
/**
 * Compare two mitata bench-results.json files and emit a markdown diff.
 *
 * Usage: bun scripts/bench-compare.ts <baseline.json> <current.json> [--threshold=5]
 *
 * Threshold (%) controls what counts as a regression flag in the output.
 */

import { readFileSync } from "fs";

type Stats = { avg: number; min: number; p50: number; p99: number; heap?: { avg: number } };
type Bench = { alias: string; group: number; runs: { stats?: Stats }[] };
type Layout = { name: string | null }[];
type Results = { layout: Layout; benchmarks: Bench[] };

const args = process.argv.slice(2);
const threshold = Number(args.find((a) => a.startsWith("--threshold="))?.split("=")[1] ?? 5);
const files = args.filter((a) => !a.startsWith("--"));
if (files.length !== 2) {
  console.error("Usage: bun scripts/bench-compare.ts <baseline.json> <current.json> [--threshold=5]");
  process.exit(1);
}
const [baselinePath, currentPath] = files;

const baseline = JSON.parse(readFileSync(baselinePath, "utf-8")) as Results;
const current = JSON.parse(readFileSync(currentPath, "utf-8")) as Results;

type Entry = { key: string; avg: number; heap: number };
function extract(r: Results): Map<string, Entry> {
  const out = new Map<string, Entry>();
  for (const b of r.benchmarks) {
    const groupName = r.layout[b.group]?.name ?? "root";
    const stats = b.runs[0]?.stats;
    if (!stats) continue;
    out.set(`${groupName}/${b.alias}`, { key: `${groupName}/${b.alias}`, avg: stats.avg, heap: stats.heap?.avg ?? 0 });
  }
  return out;
}

const base = extract(baseline);
const cur = extract(current);
const keys = [...new Set([...base.keys(), ...cur.keys()])].sort();

function fmtTime(ns: number): string {
  if (ns < 1000) return `${ns.toFixed(0)} ns`;
  if (ns < 1_000_000) return `${(ns / 1000).toFixed(2)} µs`;
  return `${(ns / 1_000_000).toFixed(2)} ms`;
}
function fmtBytes(b: number): string {
  if (b < 1024) return `${b.toFixed(0)} b`;
  return `${(b / 1024).toFixed(2)} kb`;
}
function pct(a: number, b: number): number { return b === 0 ? 0 : ((a - b) / b) * 100; }
function sign(p: number): string {
  if (Math.abs(p) < 0.5) return "≈";
  return p > 0 ? "🔴" : "🟢";
}

const rows: string[] = [];
const regressions: string[] = [];
rows.push(`| Bench | Baseline | Current | Δ time | Δ alloc |`);
rows.push(`|---|---:|---:|---:|---:|`);
for (const key of keys) {
  const b = base.get(key);
  const c = cur.get(key);
  if (!b || !c) {
    rows.push(`| ${key} | ${b ? fmtTime(b.avg) : "—"} | ${c ? fmtTime(c.avg) : "—"} | _missing_ | |`);
    continue;
  }
  const dt = pct(c.avg, b.avg);
  const dh = pct(c.heap, b.heap);
  rows.push(`| ${key} | ${fmtTime(b.avg)} / ${fmtBytes(b.heap)} | ${fmtTime(c.avg)} / ${fmtBytes(c.heap)} | ${sign(dt)} ${dt > 0 ? "+" : ""}${dt.toFixed(1)}% | ${sign(dh)} ${dh > 0 ? "+" : ""}${dh.toFixed(1)}% |`);
  if (dt > threshold) regressions.push(`- **${key}**: time +${dt.toFixed(1)}% (${fmtTime(b.avg)} → ${fmtTime(c.avg)})`);
  if (dh > threshold && b.heap > 0) regressions.push(`- **${key}**: alloc +${dh.toFixed(1)}% (${fmtBytes(b.heap)} → ${fmtBytes(c.heap)})`);
}

const header = `## Bench comparison\n\nRuntime: \`${current.context?.runtime ?? "?"} ${(current as unknown as { context?: { version?: string } }).context?.version ?? ""}\` on \`${(current as unknown as { context?: { cpu?: { name?: string } } }).context?.cpu?.name ?? "?"}\`\nThreshold: ±${threshold}%`;
const body = rows.join("\n");
const footer = regressions.length
  ? `\n\n### Regressions (>${threshold}%)\n${regressions.join("\n")}`
  : `\n\n_No regressions above ${threshold}% threshold._`;

console.log(`${header}\n\n${body}${footer}`);

// Exit non-zero if any regression exceeds threshold AND caller asks for it
if (regressions.length > 0 && args.includes("--fail-on-regression")) process.exit(1);
