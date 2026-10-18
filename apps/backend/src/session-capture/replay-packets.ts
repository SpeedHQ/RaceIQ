import { hasAMS2DumpMagic, readAMS2DumpFramesFromBuffer } from "@raceiq/capture-formats/ams2/dump";
import { readFileSync } from "node:fs";
import type { GameId } from "@raceiq/shared/games/ids";
import { getAccCarByModel, getAccCarName } from "@raceiq/game-acc-metadata/racing/cars/acc";
import { getAccTrackByName, getAccTrackName } from "@raceiq/game-acc-metadata/racing/tracks/catalogs/acc";
import { parseAccBuffers } from "@raceiq/game-acc/parser";
import { STATIC } from "@raceiq/capture-formats/acc/structs";
import { readWString } from "@raceiq/game-acc/utils";
import { createAcEvoParserCache, parseAcEvoBuffers } from "@raceiq/game-ac-evo/parser";
import { readIRacingFrames } from "@raceiq/capture-formats/iracing/dump";
import { hasLMUDumpMagic, readLMUFramesFromBuffer } from "@raceiq/capture-formats/lmu/dump-decoder";
import { hasKunosDumpMagic, readKunosFrames } from "@raceiq/capture-formats/kunos/dump";
import { getServerGame } from "@raceiq/backend-core/games/registry";
import {
  containsSparseCaptureFrames,
  decompressIfGzipSync,
  iterateSessionCaptureRecords,
  iterateSessionFrames,
  PARSER_BOOTSTRAP_VERSION,
} from "@raceiq/capture-formats/session/framing";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { applyFrameTime } from "@raceiq/backend-core/session-capture/frame-time";

export interface RecordedTelemetry {
  readonly packets: TelemetryPacket[];
  readonly carModel: string | null;
  readonly trackName: string | null;
}

function readFramedPackets(gameId: GameId, bytes: Buffer): TelemetryPacket[] {
  const game = getServerGame(gameId);
  let parserState: unknown = game.createParserState?.() ?? null;
  const packets: TelemetryPacket[] = [];
  let inContext = false;
  const records = hasAMS2DumpMagic(bytes)
    ? Array.from(readAMS2DumpFramesFromBuffer(bytes), frame => ({kind: "frame" as const, frame, frameTimeMs: frame.readDoubleLE(8)}))
    : iterateSessionCaptureRecords(bytes, undefined, { strict: false });
  for (const record of records) {
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
    if (record.kind === "parser-bootstrap") {
      if (record.gameId !== gameId || record.formatVersion !== PARSER_BOOTSTRAP_VERSION) {
        throw new Error("Parser bootstrap does not match recording game");
      }
      if (!game.restoreParserCheckpoint) throw new Error(`Parser checkpoint restore unavailable for ${gameId}`);
      parserState = game.restoreParserCheckpoint(parserState, record.payload);
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

function readAccRawPackets(recordingPath: string): RecordedTelemetry {
  const frames = readKunosFrames(recordingPath);
  if (frames.length === 0) return { packets: readFramedPackets("acc", decompressIfGzipSync(readFileSync(recordingPath))), carModel: null, trackName: null };
  let carModel: string | null = null, trackName: string | null = null;
  let carOrdinal = 0, trackOrdinal = 0;
  const packets: TelemetryPacket[] = [];
  for (const frame of frames) {
    if (carOrdinal === 0 || trackOrdinal === 0) {
      const nextCar = readWString(frame.staticData, STATIC.carModel.offset, STATIC.carModel.size);
      const nextTrack = readWString(frame.staticData, STATIC.track.offset, STATIC.track.size);
      if (nextCar) { carModel = nextCar; carOrdinal = getAccCarByModel(nextCar)?.id ?? 0; }
      if (nextTrack) { trackName = nextTrack; trackOrdinal = getAccTrackByName(nextTrack)?.id ?? 0; }
    }
    const packet = parseAccBuffers(frame.physics, frame.graphics, frame.staticData, {
      carId: carOrdinal ? String(carOrdinal) : "", trackId: trackOrdinal ? String(trackOrdinal) : "",
    });
    if (packet) packets.push(packet);
  }
  return { packets, carModel, trackName };
}

function readAcEvoRawPackets(recordingPath: string): RecordedTelemetry {
  const frames = readKunosFrames(recordingPath);
  if (frames.length === 0) return { packets: readFramedPackets("ac-evo", decompressIfGzipSync(readFileSync(recordingPath))), carModel: null, trackName: null };
  const cache = createAcEvoParserCache();
  const packets = frames.flatMap((frame) => {
    const packet = parseAcEvoBuffers(frame.physics, frame.graphics, frame.staticData, cache);
    return packet ? [packet] : [];
  });
  return { packets, carModel: cache.lastCarModel || null, trackName: cache.lastTrack || null };
}

function readIRacingPackets(recordingPath: string): RecordedTelemetry {
  const bytes = decompressIfGzipSync(readFileSync(recordingPath));
  const records = [...iterateSessionCaptureRecords(bytes, undefined, { strict: false })];
  if (records.some((record) =>
    record.kind === "segment-boundary" ||
    record.kind === "segment-context" ||
    record.kind === "segment-context-end"
  )) {
    const framed = readFramedPackets("iracing", bytes);
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
  let carModel: string | null = null, trackName: string | null = null;
  for (const frame of readIRacingFrames(recordingPath)) {
    const packet = game.tryParse(frame, parserState);
    if (!packet) continue;
    carModel ??= packet.iracing?.carName ?? null;
    trackName ??= packet.iracing?.trackName ?? null;
    packets.push(packet);
  }
  return { packets, carModel, trackName };
}

function readLMURawPackets(recordingPath: string): RecordedTelemetry {
  const game = getServerGame("lmu"), bytes = decompressIfGzipSync(readFileSync(recordingPath));
  const packets: TelemetryPacket[] = [];
  let carModel: string | null = null;
  let trackName: string | null = null;
  const frames = hasLMUDumpMagic(bytes)
    ? readLMUFramesFromBuffer(bytes)
    : iterateSessionFrames(bytes, undefined, { strict: false });
  for (const frame of frames) {
    const packet = game.tryParse(frame, null);
    if (!packet) continue;
    carModel ??= packet.lmu?.carModel || packet.lmu?.carName || null;
    trackName ??= packet.lmu?.trackName ?? null;
    packets.push(packet);
  }
  return { packets, carModel, trackName };
}


export function readRecordedTelemetry(
  gameId: GameId,
  recordingPath: string,
): RecordedTelemetry {
  const bytes = decompressIfGzipSync(readFileSync(recordingPath));
  const nativeKunosDump = (gameId === "acc" || gameId === "ac-evo") && hasKunosDumpMagic(bytes);
  const nativeLmuDump = gameId === "lmu" && hasLMUDumpMagic(bytes);
  if (!nativeKunosDump && !nativeLmuDump && containsSparseCaptureFrames(bytes)) {
    const packets = readFramedPackets(gameId, bytes);
    const first = packets[0];
    let carModel: string | null = null;
    let trackName: string | null = null;
    if (gameId === "acc" && first) {
      carModel = first.carId ? getAccCarName(Number(first.carId)) ?? null : null;
      trackName = first.trackId ? getAccTrackName(Number(first.trackId)) ?? null : null;
    } else if (gameId === "ac-evo") {
      const identity = packets.find((packet) => packet.acEvoIdentity)?.acEvoIdentity;
      carModel = identity?.carName ?? null;
      trackName = identity?.trackName ?? null;
    } else if (gameId === "iracing") {
      carModel = first?.iracing?.carName ?? null;
      trackName = first?.iracing?.trackName ?? null;
    } else if (gameId === "lmu") {
      const identity = packets.find((packet) => packet.lmu)?.lmu;
      carModel = identity?.carModel || identity?.carName || null;
      trackName = identity?.trackName ?? null;
    }
    return { packets, carModel, trackName };
  }
  const hasParserBootstrap = !nativeKunosDump && !nativeLmuDump &&
    [...iterateSessionCaptureRecords(bytes, undefined, { strict: false })].some((record) => record.kind === "parser-bootstrap");
  if (hasParserBootstrap) {
    const packets = readFramedPackets(gameId, bytes);
    const first = packets[0];
    return {
      packets,
      carModel: first?.iracing?.carName ?? first?.lmu?.carModel ?? first?.lmu?.carName ?? null,
      trackName: first?.iracing?.trackName ?? first?.lmu?.trackName ?? null,
    };
  }
  if (gameId === "acc") return readAccRawPackets(recordingPath);
  if (gameId === "ac-evo") return readAcEvoRawPackets(recordingPath);
  if (gameId === "iracing") return readIRacingPackets(recordingPath);
  if (gameId === "lmu") return readLMURawPackets(recordingPath);
  return { packets: readFramedPackets(gameId, bytes), carModel: null, trackName: null };
}
