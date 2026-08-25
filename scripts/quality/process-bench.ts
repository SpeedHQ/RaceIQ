#!/usr/bin/env bun
import { cpus } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runChildBenchmark, type RetainedHeapChildReport, type TimingChildReport } from "../../test/benchmarks/process-bench-contracts";

const args = process.argv.slice(2);
const option = (name: string): string | undefined => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const suite = option("--suite") ?? "replay";
const revision = option("--revision") ?? "unknown";
const processes = Number(option("--processes") ?? 1);
const retainedProcesses = Number(option("--retained-processes") ?? 7);
const warmups = Number(option("--warmups") ?? 1);
const iterations = Number(option("--iterations") ?? 20);
const output = option("--output");
if (suite !== "replay") throw new Error("Only --suite=replay is supported");
if (!Number.isInteger(processes) || processes <= 0) throw new Error("--processes must be positive integer");
if (!Number.isInteger(retainedProcesses) || retainedProcesses <= 0) throw new Error("--retained-processes must be positive integer");
if (!Number.isInteger(warmups) || warmups < 0) throw new Error("--warmups must be non-negative integer");
if (!Number.isInteger(iterations) || iterations <= 0) throw new Error("--iterations must be positive integer");

const root = resolve(dirname(import.meta.path), "../..");
const child = join(root, "test/benchmarks/process-bench-child.ts");
const fixture = join(root, "test/benchmarks/replay-process-bench.ts");
const aliases = [
  "parse 20,000 raw lap frames",
  "resolve 20,000 canonical envelopes",
] as const;
const rawKeys = aliases.map((alias) => `replay/${alias}`) as [
  "replay/parse 20,000 raw lap frames",
  "replay/resolve 20,000 canonical envelopes",
];
const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
};
const median = (values: number[]) => percentile(values, 50);
const run = async (mode: "timing" | "retainedHeap", alias: string) => runChildBenchmark({
  command: [process.execPath, "run", child, mode, fixture, String(warmups), String(iterations)],
  env: { ...process.env, REPLAY_BENCH_CASE: alias } as Record<string, string>,
  kind: mode,
});
type RawProcess = { process: number; timing: Record<string, TimingChildReport>; retainedHeap: Record<string, RetainedHeapChildReport> };
const raw: RawProcess[] = [];
const retainedSamples: Record<string, number[]> = Object.fromEntries(rawKeys.map((key) => [key, []]));
for (let index = 0; index < processes; index++) {
  const timing: Record<string, TimingChildReport> = {};
  for (const [index, alias] of aliases.entries()) {
    const rawKey = rawKeys[index]!;
    timing[rawKey] = await run("timing", rawKey) as TimingChildReport;
  }
  raw.push({ process: index + 1, timing, retainedHeap: {} });
}
for (let index = 0; index < retainedProcesses; index++) {
  for (const [aliasIndex, alias] of aliases.entries()) {
    const rawKey = rawKeys[aliasIndex]!;
    const result = await run("retainedHeap", rawKey) as RetainedHeapChildReport;
    retainedSamples[rawKey]!.push(result.retainedHeap);
    raw[index % raw.length]!.retainedHeap[rawKey] = result;
  }
}
 
const benchmarks = aliases.map((alias, index) => {
  const rawKey = rawKeys[index]!;
  const timingSummaries = raw.map((entry) => entry.timing[rawKey]!.samplesNs).map((samples) => ({
    p50: median(samples),
    p99: percentile(samples, 99),
  }));
  const heapSamples = retainedSamples[rawKey]!;
  return { alias, group: 0, runs: [{ stats: {
    p50: median(timingSummaries.map((summary) => summary.p50)),
    p99: median(timingSummaries.map((summary) => summary.p99)),
    retainedHeap: { p50: median(heapSamples), min: Math.min(...heapSamples), max: Math.max(...heapSamples), samples: heapSamples },
  } }] };
});
const report = {
  revision, suite, layout: [{ name: "replay" }],
  context: { runtime: `Bun ${Bun.version}`, cpu: { name: cpus()[0]?.model ?? "unknown" } },
  benchmarks, rawProcesses: raw,
};
const json = JSON.stringify(report, null, 2);
if (output) await Bun.write(output, `${json}\n`); else console.log(json);
