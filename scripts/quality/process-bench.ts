#!/usr/bin/env bun
import { cpus, arch, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runChildBenchmark, type ProcessBenchmarkConfig, type ProcessBenchmarkReport, type RetainedHeapChildReport, type TimingChildReport } from "../../test/benchmarks/process-bench-contracts";

const args = process.argv.slice(2);
const option = (name: string): string | undefined => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const suite = option("--suite") ?? "replay";
const revision = option("--revision") ?? "unknown";
const processes = Number(option("--processes") ?? 3);
const retainedProcesses = Number(option("--retained-processes") ?? 15);
const retainedWarmups = Number(option("--retained-warmups") ?? 1);
const warmupMs = Number(option("--warmup-ms") ?? 3000);
const measurementMs = Number(option("--measurement-ms") ?? 5000);
const minSamples = Number(option("--min-samples") ?? 20);
const maxSamples = Number(option("--max-samples") ?? 200);
const caseOrder = option("--case-order") ?? "forward";
const output = option("--output");
if (suite !== "replay") throw new Error("Only --suite=replay is supported");
if (!Number.isInteger(processes) || processes <= 0) throw new Error("--processes must be positive integer");
if (!Number.isInteger(retainedProcesses) || retainedProcesses <= 0) throw new Error("--retained-processes must be positive integer");
if (!Number.isInteger(retainedWarmups) || retainedWarmups < 0) throw new Error("--retained-warmups must be non-negative integer");
if (![warmupMs, measurementMs].every((value) => Number.isFinite(value) && value >= 0)) throw new Error("warmup and measurement milliseconds must be finite and non-negative");
if (!Number.isInteger(minSamples) || minSamples <= 0) throw new Error("--min-samples must be positive integer");
if (!Number.isInteger(maxSamples) || maxSamples < minSamples) throw new Error("--max-samples must be integer >= min-samples");
if (caseOrder !== "forward" && caseOrder !== "reverse") throw new Error("--case-order must be forward or reverse");

const root = resolve(dirname(import.meta.path), "../..");
const child = join(root, "test/benchmarks/process-bench-child.ts");
const fixture = join(root, "test/benchmarks/replay-process-bench.ts");
const aliases = [
  "replay/parse 20,000 raw lap frames",
  "replay/resolve 20,000 canonical envelopes",
] as const;
const orderedAliases = caseOrder === "forward" ? aliases : [...aliases].reverse();
const config: ProcessBenchmarkConfig = { processes, retainedProcesses, retainedWarmups, warmupMs, measurementMs, minSamples, maxSamples, caseOrder };
const runTiming = async (alias: string): Promise<TimingChildReport> => runChildBenchmark({
  command: [process.execPath, "run", child, "timing", fixture, String(warmupMs), String(measurementMs), String(minSamples), String(maxSamples)],
  env: { ...process.env, REPLAY_BENCH_CASE: alias } as Record<string, string>,
  kind: "timing",
  expectedSamples: { min: minSamples, max: maxSamples },
});
const runRetainedHeap = async (alias: string): Promise<RetainedHeapChildReport> => runChildBenchmark({
  command: [process.execPath, "run", child, "retainedHeap", fixture, String(retainedWarmups)],
  env: { ...process.env, REPLAY_BENCH_CASE: alias } as Record<string, string>,
  kind: "retainedHeap",
});

const cases: ProcessBenchmarkReport["cases"] = Object.fromEntries(aliases.map((alias) => [alias, { timing: [], retainedHeapDeltas: [] }]));
for (let processIndex = 0; processIndex < processes; processIndex += 1) {
  for (const alias of orderedAliases) cases[alias]!.timing.push(await runTiming(alias));
}
for (const alias of orderedAliases) {
  for (let sampleIndex = 0; sampleIndex < retainedProcesses; sampleIndex += 1) {
    const result = await runRetainedHeap(alias);
    cases[alias]!.retainedHeapDeltas.push(result.deltaBytes);
  }
}

const report: ProcessBenchmarkReport = {
  schemaVersion: 2,
  revision,
  suite: "replay",
  config,
  context: {
    runtime: `Bun ${Bun.version}`,
    cpu: { name: cpus()[0]?.model ?? "unknown", logicalCount: cpus().length },
    os: { platform: platform(), release: release(), arch: arch() },
  },
  cases,
};
const json = JSON.stringify(report, null, 2);
if (output) await Bun.write(output, `${json}\n`); else console.log(json);
