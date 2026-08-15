#!/usr/bin/env bun

import { heapStats } from "bun:jsc";
import { gunzipSync } from "node:zlib";

import { parseRawLapFramesFromBuffer, type LapReplaySource } from "../../server/db/telemetry-replay-storage";
import { initServerGameAdapters } from "../../server/games/init";
import { resolveTelemetryReplay } from "../../server/telemetry/replay";
import { initGameAdapters } from "../../shared/games/init";
import type { ReplayParserSoakMeasurement, ReplayParserSoakSample, ReplayParserSoakScenarioName } from "./replay-parser-soak";

const FRAME_COUNT = Number(process.env.TELEMETRY_BENCHMARK_FRAMES ?? 20_000);
const FIXTURE = "test/artifacts/sessions/session-ac-evo-mid-2026-04-21T20-24-34-810Z.bin.gz";
const SEMANTIC_IDS = ["motion.speed", "inputs.accel", "inputs.brake", "inputs.gear", "inputs.clutch-percent", "timing.current-lap", "timing.lap-number", "timing.distance-traveled"] as const;
const REPLAY_SOURCE: LapReplaySource = {
  id: 1,
  sessionId: 1,
  createdAt: "2026-04-21T20:24:34.810Z",
  gameId: "ac-evo",
  rawFile: null,
  rawByteOffset: 12,
  rawFrameCount: FRAME_COUNT,
};

interface SoakCycleResults {
  readonly durationMs: number;
  readonly samples: readonly ReplayParserSoakSample[];
}

function argumentValue(name: string): string | undefined {
  const prefix = `${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function integerArgument(name: string, minimum: number, maximum: number): number {
  const rawValue = argumentValue(name);
  const value = Number(rawValue);
  if (rawValue === undefined || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}, received ${rawValue}`);
  }
  return value;
}

function validateSoakOutput(name: ReplayParserSoakScenarioName, outputItems: number): void {
  if (outputItems < FRAME_COUNT || outputItems > FRAME_COUNT + 1) {
    const outputName = name === "parser" ? "packets" : "envelopes";
    throw new Error(`${name === "parser" ? "Parser" : "Replay"} soak expected ` + `${FRAME_COUNT}-${FRAME_COUNT + 1} ${outputName}, received ${outputItems}`);
  }
}

async function postGcSample(iteration: number): Promise<ReplayParserSoakSample> {
  await Bun.sleep(0);
  Bun.gc(true);
  return {
    iteration,
    postGcRssBytes: process.memoryUsage.rss(),
    postGcHeapBytes: heapStats().heapSize,
  };
}

async function runSoakCycles(
  name: ReplayParserSoakScenarioName,
  warmupIterations: number,
  measuredIterations: number | undefined,
  targetDurationMs: number | null,
  runCycle: () => number,
): Promise<SoakCycleResults> {
  for (let iteration = 0; iteration < warmupIterations; iteration++) {
    validateSoakOutput(name, runCycle());
    await postGcSample(0);
  }

  const samples: ReplayParserSoakSample[] = [];
  const startedAt = performance.now();
  function shouldContinue(): boolean {
    if (measuredIterations !== undefined) return samples.length < measuredIterations;
    if (targetDurationMs === null) {
      throw new Error("Duration-based soak requires a target duration");
    }
    return performance.now() - startedAt < targetDurationMs;
  }
  while (shouldContinue()) {
    validateSoakOutput(name, runCycle());
    samples.push(await postGcSample(samples.length + 1));
  }
  if (samples.length < 20) {
    throw new Error(`${name} soak requires at least 20 measured samples, received ${samples.length}`);
  }
  return { durationMs: performance.now() - startedAt, samples };
}

if (!Number.isInteger(FRAME_COUNT) || FRAME_COUNT <= 0 || FRAME_COUNT > 20_000) {
  throw new Error(`TELEMETRY_BENCHMARK_FRAMES must be an integer between 1 and 20000, received ${FRAME_COUNT}`);
}

const scenario = argumentValue("--scenario") as ReplayParserSoakScenarioName | undefined;
const resultPath = argumentValue("--result");
if ((scenario !== "parser" && scenario !== "replay") || !resultPath) {
  throw new Error("Soak worker requires --scenario=parser|replay and --result=<path>");
}
const iterationsRaw = argumentValue("--iterations");
const durationRaw = argumentValue("--duration-ms");
if ((iterationsRaw === undefined) === (durationRaw === undefined)) {
  throw new Error("Soak worker requires exactly one of --iterations or --duration-ms");
}
const measuredIterations = iterationsRaw === undefined ? undefined : integerArgument("--iterations", 20, 1_000);
const targetDurationMs = durationRaw === undefined ? null : integerArgument("--duration-ms", 1_000, 3_600_000);
const warmupIterations = integerArgument("--warmup", 1, 100);

const originalLog = console.log;
const result = await (async (): Promise<ReplayParserSoakMeasurement> => {
  console.log = () => {};
  try {
    initGameAdapters();
    initServerGameAdapters();
    const capture = Buffer.from(gunzipSync(Buffer.from(await Bun.file(FIXTURE).arrayBuffer())));
    let runCycle: () => number;
    if (scenario === "parser") {
      runCycle = () => parseRawLapFramesFromBuffer(capture, 12, FRAME_COUNT, "ac-evo", FIXTURE).length;
    } else {
      const packets = parseRawLapFramesFromBuffer(capture, 12, FRAME_COUNT, "ac-evo", FIXTURE);
      validateSoakOutput("parser", packets.length);
      runCycle = () => resolveTelemetryReplay(1, REPLAY_SOURCE, packets, SEMANTIC_IDS).envelopes.length;
    }

    const cycles = await runSoakCycles(scenario, warmupIterations, measuredIterations, targetDurationMs, runCycle);
    return {
      name: scenario,
      fixture: FIXTURE,
      framesPerIteration: FRAME_COUNT,
      semanticCount: scenario === "replay" ? SEMANTIC_IDS.length : 0,
      warmupIterations,
      measuredIterations: cycles.samples.length,
      targetDurationMs,
      ...cycles,
    };
  } finally {
    console.log = originalLog;
  }
})();
await Bun.write(resultPath, JSON.stringify(result, null, 2));
console.log(`[telemetry-soak] ${scenario}: recorded ${result.samples.length} post-GC samples over ` + `${(result.durationMs / 60_000).toFixed(1)} minutes`);
