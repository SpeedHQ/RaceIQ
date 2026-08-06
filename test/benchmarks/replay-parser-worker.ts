#!/usr/bin/env bun

import { memoryUsage } from "bun:jsc";
import { client, initDb } from "../../server/db";
import { insertLap } from "../../server/db/lap-mutation-queries";
import { deleteSession, insertSession, updateSessionRawFile } from "../../server/db/session-queries";
import { parseRawLapFrames } from "../../server/db/telemetry-replay-storage";
import { initServerGameAdapters } from "../../server/games/init";
import { queryLapTelemetryBySemanticId } from "../../server/telemetry/replay";
import { initGameAdapters } from "../../shared/games/init";
import type { ReplayParserBenchmarkMeasurement } from "./replay-parser.bench";

const FRAME_COUNT = Number(process.env.TELEMETRY_BENCHMARK_FRAMES ?? 20_000);
const FIXTURE = "test/artifacts/sessions/session-ac-evo-mid-2026-04-21T20-24-34-810Z.bin.gz";
const SEMANTIC_IDS = [
  "motion.speed",
  "inputs.accel",
  "inputs.brake",
  "inputs.gear",
  "inputs.clutch-percent",
  "timing.current-lap",
  "timing.lap-number",
  "timing.distance-traveled",
] as const;

type ScenarioName = ReplayParserBenchmarkMeasurement["name"];

interface MemoryBaseline {
  readonly rssBytes: number;
  readonly heapBytes: number;
}

function argumentValue(name: string): string | undefined {
  const prefix = `${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function settleMemory(): MemoryBaseline {
  Bun.gc(true);
  const heap = memoryUsage();
  return {
    rssBytes: process.memoryUsage.rss(),
    heapBytes: heap.current,
  };
}

function measuredResult(
  name: ScenarioName,
  baseline: MemoryBaseline,
  startedAt: number,
  outputItems: number,
): ReplayParserBenchmarkMeasurement {
  const durationMs = performance.now() - startedAt;
  const heap = memoryUsage();
  const peakRssBytes = Math.max(process.memoryUsage.rss(), process.resourceUsage().maxRSS * 1024);
  const peakHeapBytes = Math.max(heap.current, heap.peak);
  return {
    name,
    fixture: FIXTURE,
    inputFrames: FRAME_COUNT,
    outputItems,
    semanticCount: name === "replay" ? SEMANTIC_IDS.length : 0,
    durationMs,
    throughputPerSecond: (FRAME_COUNT * 1000) / durationMs,
    baselineRssBytes: baseline.rssBytes,
    peakRssBytes,
    incrementalPeakRssBytes: Math.max(0, peakRssBytes - baseline.rssBytes),
    baselineHeapBytes: baseline.heapBytes,
    peakHeapBytes,
    incrementalPeakHeapBytes: Math.max(0, peakHeapBytes - baseline.heapBytes),
  };
}

async function runParserScenario(): Promise<ReplayParserBenchmarkMeasurement> {
  const baseline = settleMemory();
  const startedAt = performance.now();
  const packets = await parseRawLapFrames(FIXTURE, 12, FRAME_COUNT, "ac-evo");
  const result = measuredResult("parser", baseline, startedAt, packets.length);
  if (packets.length < FRAME_COUNT || packets.length > FRAME_COUNT + 1) {
    throw new Error(`Parser benchmark expected ${FRAME_COUNT}-${FRAME_COUNT + 1} packets, received ${packets.length}`);
  }
  return result;
}

async function runReplayScenario(): Promise<ReplayParserBenchmarkMeasurement> {
  await initDb();
  const sessionId = await insertSession(1, 1, "ac-evo");
  try {
    await updateSessionRawFile(sessionId, FIXTURE, "replay-parser-benchmark");
    const lapId = await insertLap(sessionId, 1, 90, true, 12, FRAME_COUNT);
    const baseline = settleMemory();
    const startedAt = performance.now();
    const replay = await queryLapTelemetryBySemanticId(lapId, SEMANTIC_IDS);
    const result = measuredResult("replay", baseline, startedAt, replay?.envelopes.length ?? 0);
    if (!replay || replay.envelopes.length < FRAME_COUNT || replay.envelopes.length > FRAME_COUNT + 1) {
      throw new Error(`Replay benchmark expected ${FRAME_COUNT}-${FRAME_COUNT + 1} envelopes, received ${replay?.envelopes.length ?? 0}`);
    }
    return result;
  } finally {
    await deleteSession(sessionId);
    client.close();
  }
}

if (!Number.isInteger(FRAME_COUNT) || FRAME_COUNT <= 0 || FRAME_COUNT > 20_000) {
  throw new Error(`TELEMETRY_BENCHMARK_FRAMES must be an integer between 1 and 20000, received ${FRAME_COUNT}`);
}

const scenario = argumentValue("--scenario") as ScenarioName | undefined;
const resultPath = argumentValue("--result");
if ((scenario !== "parser" && scenario !== "replay") || !resultPath) {
  throw new Error("Benchmark worker requires --scenario=parser|replay and --result=<path>");
}

initGameAdapters();
initServerGameAdapters();
const result = scenario === "parser" ? await runParserScenario() : await runReplayScenario();
await Bun.write(resultPath, JSON.stringify(result, null, 2));
console.log(
  `[telemetry-bench] ${result.name}: ${result.throughputPerSecond.toFixed(0)}/s, ` +
  `peak RSS ${(result.peakRssBytes / 1024 / 1024).toFixed(1)} MiB, ` +
  `incremental RSS ${(result.incrementalPeakRssBytes / 1024 / 1024).toFixed(1)} MiB, ` +
  `incremental heap ${(result.incrementalPeakHeapBytes / 1024 / 1024).toFixed(1)} MiB`,
);
process.exit(0);
