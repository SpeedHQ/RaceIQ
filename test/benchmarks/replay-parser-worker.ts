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
import type {
  ReplayParserSoakMeasurement,
  ReplayParserSoakSample,
} from "./replay-parser-soak";

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

interface SoakCycleResults {
  readonly durationMs: number;
  readonly samples: readonly ReplayParserSoakSample[];
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

function validateSoakOutput(name: ScenarioName, outputItems: number): void {
  if (outputItems < FRAME_COUNT || outputItems > FRAME_COUNT + 1) {
    const outputName = name === "parser" ? "packets" : "envelopes";
    throw new Error(
      `${name === "parser" ? "Parser" : "Replay"} soak expected ` +
      `${FRAME_COUNT}-${FRAME_COUNT + 1} ${outputName}, received ${outputItems}`,
    );
  }
}

async function postGcSample(iteration: number): Promise<ReplayParserSoakSample> {
  await Bun.sleep(0);
  Bun.gc(true);
  const heap = memoryUsage();
  return {
    iteration,
    postGcRssBytes: process.memoryUsage.rss(),
    postGcHeapBytes: heap.current,
  };
}

async function runSoakCycles(
  name: ScenarioName,
  warmupIterations: number,
  measuredIterations: number,
  runCycle: () => Promise<number>,
): Promise<SoakCycleResults> {
  for (let iteration = 0; iteration < warmupIterations; iteration++) {
    validateSoakOutput(name, await runCycle());
    await postGcSample(0);
  }

  const samples: ReplayParserSoakSample[] = [];
  const startedAt = performance.now();
  for (let iteration = 1; iteration <= measuredIterations; iteration++) {
    validateSoakOutput(name, await runCycle());
    samples.push(await postGcSample(iteration));
  }
  return { durationMs: performance.now() - startedAt, samples };
}

async function parseFrameCount(): Promise<number> {
  const packets = await parseRawLapFrames(FIXTURE, 12, FRAME_COUNT, "ac-evo");
  return packets.length;
}

async function runParserSoak(
  warmupIterations: number,
  measuredIterations: number,
): Promise<ReplayParserSoakMeasurement> {
  const cycles = await runSoakCycles("parser", warmupIterations, measuredIterations, parseFrameCount);
  return {
    name: "parser",
    fixture: FIXTURE,
    framesPerIteration: FRAME_COUNT,
    semanticCount: 0,
    warmupIterations,
    measuredIterations,
    ...cycles,
  };
}

async function replayEnvelopeCount(): Promise<number> {
  const sessionId = await insertSession(1, 1, "ac-evo");
  try {
    await updateSessionRawFile(sessionId, FIXTURE, "replay-parser-soak");
    const lapId = await insertLap(sessionId, 1, 90, true, 12, FRAME_COUNT);
    const replay = await queryLapTelemetryBySemanticId(lapId, SEMANTIC_IDS);
    return replay?.envelopes.length ?? 0;
  } finally {
    await deleteSession(sessionId);
  }
}

async function runReplaySoak(
  warmupIterations: number,
  measuredIterations: number,
): Promise<ReplayParserSoakMeasurement> {
  await initDb();
  try {
    const cycles = await runSoakCycles("replay", warmupIterations, measuredIterations, replayEnvelopeCount);
    return {
      name: "replay",
      fixture: FIXTURE,
      framesPerIteration: FRAME_COUNT,
      semanticCount: SEMANTIC_IDS.length,
      warmupIterations,
      measuredIterations,
      ...cycles,
    };
  } finally {
    client.close();
  }
}

function soakIterationArgument(name: string, minimum: number, maximum: number): number {
  const rawValue = argumentValue(name);
  const value = Number(rawValue);
  if (rawValue === undefined || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}, received ${rawValue}`);
  }
  return value;
}

if (!Number.isInteger(FRAME_COUNT) || FRAME_COUNT <= 0 || FRAME_COUNT > 20_000) {
  throw new Error(`TELEMETRY_BENCHMARK_FRAMES must be an integer between 1 and 20000, received ${FRAME_COUNT}`);
}

const scenario = argumentValue("--scenario") as ScenarioName | undefined;
const resultPath = argumentValue("--result");
const mode = argumentValue("--mode") ?? "throughput";
if ((scenario !== "parser" && scenario !== "replay") || !resultPath) {
  throw new Error("Benchmark worker requires --scenario=parser|replay and --result=<path>");
}
if (mode !== "throughput" && mode !== "soak") {
  throw new Error(`Benchmark worker requires --mode=throughput|soak, received ${mode}`);
}

initGameAdapters();
initServerGameAdapters();
if (mode === "throughput") {
  const result = scenario === "parser" ? await runParserScenario() : await runReplayScenario();
  await Bun.write(resultPath, JSON.stringify(result, null, 2));
  console.log(
    `[telemetry-bench] ${result.name}: ${result.throughputPerSecond.toFixed(0)}/s, ` +
    `peak RSS ${(result.peakRssBytes / 1024 / 1024).toFixed(1)} MiB, ` +
    `incremental RSS ${(result.incrementalPeakRssBytes / 1024 / 1024).toFixed(1)} MiB, ` +
    `incremental heap ${(result.incrementalPeakHeapBytes / 1024 / 1024).toFixed(1)} MiB`,
  );
  process.exit(0);
}

const measuredIterations = soakIterationArgument("--iterations", 20, 1_000);
const warmupIterations = soakIterationArgument("--warmup", 1, 100);
const result = scenario === "parser"
  ? await runParserSoak(warmupIterations, measuredIterations)
  : await runReplaySoak(warmupIterations, measuredIterations);
if (result.samples.length !== measuredIterations) {
  throw new Error(
    `${scenario} soak expected ${measuredIterations} post-GC samples, received ${result.samples.length}`,
  );
}
await Bun.write(resultPath, JSON.stringify(result, null, 2));
console.log(`[telemetry-soak] ${scenario}: recorded ${result.samples.length} post-GC samples`);
process.exit(0);
