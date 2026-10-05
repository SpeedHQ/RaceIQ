import { readFileSync } from "node:fs";
import type { GameId } from "@raceiq/shared/games/ids";
import { getAccCarByModel } from "@raceiq/game-acc-metadata/racing/cars/acc";
import { getAccTrackByName } from "@raceiq/game-acc-metadata/racing/tracks/catalogs/acc";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { parseAccBuffers } from "@raceiq/game-acc/parser";
import { STATIC } from "@raceiq/capture-formats/acc/structs";
import { readWString } from "@raceiq/game-acc/utils";
import {
  createAcEvoParserCache,
  parseAcEvoBuffers,
} from "@raceiq/game-ac-evo/parser";
import { readIRacingFrames } from "@raceiq/capture-formats/iracing/dump";
import { hasLMUDumpMagic, readLMUFramesFromBuffer } from "@raceiq/capture-formats/lmu/dump";
import { readKunosFrames } from "@raceiq/backend-core/games/kunos/frame-reader";
import { getServerGame } from "@raceiq/backend-core/games/registry";
import { decompressIfGzipSync, iterateSessionCaptureRecords, iterateSessionFrames } from "@raceiq/backend-core/session-capture/framing";
import { applyFrameTime } from "@raceiq/backend-core/session-capture/frame-time";
import { copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { getRecorderEngine, getRecordingEngineKind, runRecordingJob } from "@raceiq/backend-core/runtime/recorder-engine";
import { resolveDataDir } from "@raceiq/backend-core/runtime/config/data-dir";

export interface RecordedTelemetry {
  readonly packets: TelemetryPacket[];
  readonly carModel: string | null;
  readonly trackName: string | null;
}

function readFramedPackets(gameId: GameId, recordingPath: string): TelemetryPacket[] {
  const game = getServerGame(gameId);
  let parserState = game.createParserState?.() ?? null;
  const bytes = decompressIfGzipSync(readFileSync(recordingPath));
  const packets: TelemetryPacket[] = [];
  let inContext = false;
  for (const record of iterateSessionCaptureRecords(bytes)) {
    if (record.kind === "segment-boundary") {
      parserState = game.createParserState?.() ?? null;
      inContext = false;
      continue;
    }
    if (record.kind === "segment-context") {
      inContext = true;
      continue;
    }
    if (record.kind === "segment-context-end") {
      inContext = false;
      continue;
    }
    if (record.kind !== "frame") continue;
    const packet = game.tryParse(record.frame, parserState);
    if (packet && !inContext) {
      applyFrameTime(packet, record.frameTimeMs);
      packets.push(packet);
    }
  }
  return packets;
}

function readAccPackets(recordingPath: string): RecordedTelemetry {
  const frames = readKunosFrames(recordingPath);
  if (frames.length === 0) {
    return {
      packets: readFramedPackets("acc", recordingPath),
      carModel: null,
      trackName: null,
    };
  }

  let carModel: string | null = null;
  let trackName: string | null = null;
  let carOrdinal = 0;
  let trackOrdinal = 0;
  const packets: TelemetryPacket[] = [];
  for (const frame of frames) {
    if (carOrdinal === 0 || trackOrdinal === 0) {
      const nextCarModel = readWString(
        frame.staticData,
        STATIC.carModel.offset,
        STATIC.carModel.size,
      );
      const nextTrackName = readWString(
        frame.staticData,
        STATIC.track.offset,
        STATIC.track.size,
      );
      if (nextCarModel) {
        carModel = nextCarModel;
        carOrdinal = getAccCarByModel(nextCarModel)?.id ?? 0;
      }
      if (nextTrackName) {
        trackName = nextTrackName;
        trackOrdinal = getAccTrackByName(nextTrackName)?.id ?? 0;
      }
    }
    const packet = parseAccBuffers(frame.physics, frame.graphics, frame.staticData, {
      carOrdinal,
      trackOrdinal,
    });
    if (packet) packets.push(packet);
  }
  return { packets, carModel, trackName };
}

function readAcEvoPackets(recordingPath: string): RecordedTelemetry {
  const frames = readKunosFrames(recordingPath);
  if (frames.length === 0) {
    return {
      packets: readFramedPackets("ac-evo", recordingPath),
      carModel: null,
      trackName: null,
    };
  }

  const cache = createAcEvoParserCache();
  const packets: TelemetryPacket[] = [];
  for (const frame of frames) {
    const packet = parseAcEvoBuffers(
      frame.physics,
      frame.graphics,
      frame.staticData,
      cache,
    );
    if (packet) packets.push(packet);
  }
  return {
    packets,
    carModel: cache.lastCarModel || null,
    trackName: cache.lastTrack || null,
  };
}

function readIRacingPackets(recordingPath: string): RecordedTelemetry {
  const bytes = decompressIfGzipSync(readFileSync(recordingPath));
  const records = [...iterateSessionCaptureRecords(bytes)];
  if (records.some((record) =>
    record.kind === "segment-boundary" ||
    record.kind === "segment-context" ||
    record.kind === "segment-context-end"
  )) {
    const framed = readFramedPackets("iracing", recordingPath);
    const first = framed[0]?.iracing;
    return {
      packets: framed,
      carModel: first?.carName ?? null,
      trackName: first?.trackName ?? null,
    };
  }
  const game = getServerGame("iracing");
  const parserState = game.createParserState?.() ?? null;
  const packets: TelemetryPacket[] = [];
  let carModel: string | null = null;
  let trackName: string | null = null;
  for (const frame of readIRacingFrames(recordingPath)) {
    const packet = game.tryParse(frame, parserState);
    if (!packet) continue;
    carModel ??= packet.iracing?.carName ?? null;
    trackName ??= packet.iracing?.trackName ?? null;
    packets.push(packet);
  }
  return { packets, carModel, trackName };
}

function readLMUPackets(recordingPath: string): RecordedTelemetry {
  const game = getServerGame("lmu");
  const packets: TelemetryPacket[] = [];
  let carModel: string | null = null;
  let trackName: string | null = null;
  const bytes = decompressIfGzipSync(readFileSync(recordingPath));
  const frames = hasLMUDumpMagic(bytes)
    ? readLMUFramesFromBuffer(bytes)
    : iterateSessionFrames(bytes);
  for (const frame of frames) {
    const packet = game.tryParse(frame, null);
    if (!packet) continue;
    carModel ??= packet.lmu?.carModel || packet.lmu?.carName || null;
    trackName ??= packet.lmu?.trackName ?? null;
    packets.push(packet);
  }
  return { packets, carModel, trackName };
}

async function readRecordedTelemetryBun(gameId: GameId, recordingPath: string): Promise<RecordedTelemetry> {
  if (gameId === "acc") return readAccPackets(recordingPath);
  if (gameId === "ac-evo") return readAcEvoPackets(recordingPath);
  if (gameId === "iracing") return readIRacingPackets(recordingPath);
  if (gameId === "lmu") return readLMUPackets(recordingPath);
  return { packets: readFramedPackets(gameId, recordingPath), carModel: null, trackName: null };
}

export async function readRecordedTelemetry(gameId: GameId, recordingPath: string): Promise<RecordedTelemetry> {
  return runRecordingJob(async () => {
    if (getRecordingEngineKind() !== "rust") return readRecordedTelemetryBun(gameId, recordingPath);
    const engine = getRecorderEngine();
    if (!engine) throw new Error("Rust recorder is not registered");
    const root = resolve(resolveDataDir(), "recorder-jobs");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const outputRoot = await mkdtemp(join(root, "replay-"));
    const jobId = `replay-${basename(outputRoot)}`;
    try {
      const sourcePath = join(outputRoot, recordingPath.toLowerCase().endsWith(".gz") ? "source.capture.gz" : "source.capture");
      const sourceInfo = await stat(recordingPath);
      if (sourceInfo.size > 1024 * 1024 * 1024) throw new Error("Replay capture exceeds 1 GiB input limit");
      await copyFile(recordingPath, sourcePath);
      const response = await engine.request("read-capture", {
        jobId, gameId, input: { path: sourcePath }, outputRoot,
      }) as Record<string, unknown>;
      if (response.jobId !== jobId || typeof response.resultPath !== "string") throw new Error("Invalid Rust replay response");
      const resultPath = containedReplayPath(outputRoot, response.resultPath);
      const manifest = await Bun.file(resultPath).json() as Record<string, unknown>;
      if (manifest.version !== 1 || manifest.jobId !== jobId || manifest.operation !== "read-capture" ||
          manifest.gameId !== gameId || !Array.isArray(manifest.packets)) throw new Error("Invalid Rust replay manifest");
      if (!Number.isSafeInteger(manifest.packetCount) || manifest.packetCount !== manifest.packets.length) {
        throw new Error("Rust replay packet count mismatch");
      }
      const packets = manifest.packets.map((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Rust replay packet");
        const entry = value as Record<string, unknown>;
        replaySafeOffset(entry.offset, "packet offset");
        if (entry.frameTimeMs !== null) replaySafeOffset(entry.frameTimeMs, "frame time");
        const packet = entry.packet;
        if (!packet || typeof packet !== "object" || Array.isArray(packet)) throw new Error("Invalid Rust telemetry packet");
        return packet as TelemetryPacket;
      });
      return {
        packets,
        carModel: typeof manifest.carModel === "string" ? manifest.carModel : null,
        trackName: typeof manifest.trackName === "string" ? manifest.trackName : null,
      };
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });
}
function replaySafeOffset(value: unknown, label: string): number {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) throw new Error(`Invalid Rust replay ${label}`);
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`Rust replay ${label} exceeds safe integer range`);
  return Number(parsed);
}

function containedReplayPath(root: string, value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid Rust replay manifest path");
  const full = resolve(value);
  const rel = relative(resolve(root), full);
  if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("Rust replay manifest path escapes job root");
  }
  return full;
}
