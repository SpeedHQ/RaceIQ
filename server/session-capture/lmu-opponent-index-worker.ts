import { parentPort, workerData } from "node:worker_threads";
import {
  buildLmuOpponentIndex,
  type LmuOpponentIndexStagedPublication,
  type LmuOpponentIndexBuildResult,
  type LmuOpponentIndexSourceDependency,
  type LmuOpponentPlayerLapFacts,
} from "../lap-analysis/lmu-opponent-index";
import { LmuOpponentAdmissionError } from "./lmu-companion";
import { decodeLMUSourceFrame } from "@raceiq/capture-formats/lmu/source-frame";
import { iterateSessionCaptureRecordsFromSource } from "./source-loader";
import type { SessionCaptureSource } from "./source-loader";
export type WorkerRequest =
  | { type: "admission-result"; requestId: number; allowed: boolean }
  | { type: "publish-result"; requestId: number; published: boolean };

export type WorkerMessage =
  | { type: "admission"; requestId: number; blockIndex: number }
  | { type: "publish"; requestId: number; staged: LmuOpponentIndexStagedPublication }
  | { type: "complete"; result: LmuOpponentIndexBuildResult; metrics: WorkerMetrics }
  | { type: "yielded"; metrics: WorkerMetrics }
  | { type: "failure"; error: string };

interface WorkerMetrics {
  buildDurationMs: number;
  processCpuUserMicros: number;
  processCpuSystemMicros: number;
  processRssBytes: number;
  sourceFramesScanned: number;
  nativeFramesDecoded: number;
}

interface PlayerLapWindow {
  playerLapId: number;
  startFrameIndex: number | null;
  startByteOffset: number | null;
  frameCount: number;
}

interface WorkerInput {
  source: SessionCaptureSource;
  sourceRevision: string;
  sourceDependencies: readonly LmuOpponentIndexSourceDependency[];
  playerLapWindows: readonly PlayerLapWindow[];
  indexRoot: string;
}

function requireParentPort() {
  if (!parentPort) throw new Error("LMU opponent index worker requires a parent port");
  return parentPort;
}
const port = requireParentPort();
const input = workerData as WorkerInput;
let sequence = 0;
let nextBlockIndex = 0;
function logTestDiagnostic(location: string, error: unknown): void {
  if (process.env.RACEIQ_TEST_MODE !== "1" && !process.env.RACEIQ_LMU_OPPONENT_INDEX_TEST_METRICS_FILE) return;
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(`[LMUOpponentIndexTest] worker ${location}: ${detail}`);
}

const pending = new Map<number, (value: boolean) => void>();

port.on("message", (message: WorkerRequest) => {
  const resolve = pending.get(message.requestId);
  if (!resolve) return;
  if (message.type === "admission-result") resolve(message.allowed);
  else resolve(message.published);
  pending.delete(message.requestId);
});

function request(type: "admission", payload: { blockIndex: number }): Promise<boolean>;
function request(type: "publish", payload: { staged: LmuOpponentIndexStagedPublication }): Promise<boolean>;
function request(
  type: "admission" | "publish",
  payload: { blockIndex: number } | { staged: LmuOpponentIndexStagedPublication },
): Promise<boolean> {
  const requestId = ++sequence;
  const { promise, resolve } = Promise.withResolvers<boolean>();
  pending.set(requestId, resolve);
  if (type === "admission" && "blockIndex" in payload) {
    port.postMessage({ type, requestId, blockIndex: payload.blockIndex });
  } else if (type === "publish" && "staged" in payload) {
    port.postMessage({ type, requestId, staged: payload.staged });
  } else {
    throw new Error("Invalid LMU opponent worker request");
  }
  return promise;
}

function admitNextBlock(): Promise<boolean> {
  return request("admission", { blockIndex: nextBlockIndex++ });
}

async function collectPlayerLapFacts(
  countSourceFrame: () => void,
  countNativeDecode: () => void,
): Promise<LmuOpponentPlayerLapFacts[] | null> {
  const windows = input.playerLapWindows;
  const byFrame = new Map<number, PlayerLapWindow[]>();
  const byOffset = new Map<number, PlayerLapWindow[]>();
  const facts = new Map<number, Set<string>>();
  for (const window of windows) {
    facts.set(window.playerLapId, new Set());
    if (window.startFrameIndex !== null) {
      const matches = byFrame.get(window.startFrameIndex) ?? [];
      matches.push(window);
      byFrame.set(window.startFrameIndex, matches);
    }
    if (window.startByteOffset !== null) {
      const matches = byOffset.get(window.startByteOffset) ?? [];
      matches.push(window);
      byOffset.set(window.startByteOffset, matches);
    }
  }
  if (windows.length === 0) return [];
  const active = new Map<number, { remaining: number; channelIds: Set<string> }>();
  const started = new Set<number>();
  let frameIndex = 0;
  let framesSinceAdmission = 0;
  const startWindows = (matches: readonly PlayerLapWindow[]) => {
    for (const window of matches) {
      if (started.has(window.playerLapId)) continue;
      started.add(window.playerLapId);
      active.set(window.playerLapId, { remaining: window.frameCount, channelIds: facts.get(window.playerLapId)! });
    }
  };
  for await (const record of iterateSessionCaptureRecordsFromSource(input.source, {
    strict: true,
    admission: admitNextBlock,
  })) {
    if (record.kind !== "frame") continue;
    countSourceFrame();
    startWindows(byFrame.get(frameIndex) ?? []);
    startWindows(byOffset.get(record.offset) ?? []);
    if (active.size > 0) {
      countNativeDecode();
      const player = decodeLMUSourceFrame(record.frame)?.lmuContext?.competitors?.find((entry) => entry.isPlayer);
      if (player) {
        for (const value of active.values()) {
          for (const [semanticId, channel] of Object.entries(player.channels)) {
            if (channel.state === "ok" && channel.freshness === "fresh" &&
                typeof channel.value === "number" && Number.isFinite(channel.value)) value.channelIds.add(semanticId);
          }
        }
      }
      for (const [lapId, value] of active) {
        value.remaining--;
        if (value.remaining === 0) active.delete(lapId);
      }
    }
    frameIndex++;
    if (++framesSinceAdmission === 256) {
      framesSinceAdmission = 0;
      if (!await admitNextBlock()) return null;
    }
  }
  return windows.map((window) => ({
    playerLapId: window.playerLapId,
    comparableChannelIds: [...facts.get(window.playerLapId)!].sort(),
  }));
}

async function run(): Promise<void> {
  const startedAt = performance.now();
  const cpuStart = process.cpuUsage();
  let sourceFramesScanned = 0;
  let nativeFramesDecoded = 0;
  const metrics = (): WorkerMetrics => {
    const cpu = process.cpuUsage(cpuStart);
    return {
      buildDurationMs: performance.now() - startedAt,
      processCpuUserMicros: cpu.user,
      processCpuSystemMicros: cpu.system,
      processRssBytes: process.memoryUsage().rss,
      sourceFramesScanned,
      nativeFramesDecoded,
    };
  };
  try {
    const playerLapFacts = await collectPlayerLapFacts(
      () => { sourceFramesScanned++; },
      () => { nativeFramesDecoded++; },
    );
    if (playerLapFacts === null) {
      port.postMessage({ type: "yielded", metrics: metrics() } satisfies WorkerMessage);
      return;
    }
    const result = await buildLmuOpponentIndex({
      source: input.source,
      sourceRevision: input.sourceRevision,
      sourceDependencies: input.sourceDependencies,
      playerLapFacts,
      indexRoot: input.indexRoot,
      admission: admitNextBlock,
      publish: (staged) => request("publish", { staged }),
    });
    sourceFramesScanned += result.stats.sourceFramesScanned;
    nativeFramesDecoded += result.stats.sourceFramesScanned;
    const buildMetrics = metrics();
    if (!result.published) port.postMessage({ type: "yielded", metrics: buildMetrics } satisfies WorkerMessage);
    else port.postMessage({ type: "complete", result, metrics: buildMetrics } satisfies WorkerMessage);
  } catch (error) {
    if (error instanceof LmuOpponentAdmissionError) {
      port.postMessage({ type: "yielded", metrics: metrics() } satisfies WorkerMessage);
    } else {
      logTestDiagnostic("build", error);
      port.postMessage({ type: "failure", error: error instanceof Error ? error.message : String(error) } satisfies WorkerMessage);
    }
  } finally {
    port.close();
  }
}

void run();
