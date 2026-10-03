import { readFileSync } from "node:fs";
import type { GameId } from "@raceiq/shared/games/ids";
import { getAccCarByModel } from "@raceiq/shared/racing/cars/acc";
import { getAccTrackByName } from "@raceiq/shared/racing/tracks/catalogs/acc";
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

export function readRecordedTelemetry(
  gameId: GameId,
  recordingPath: string,
): RecordedTelemetry {
  if (gameId === "acc") return readAccPackets(recordingPath);
  if (gameId === "ac-evo") return readAcEvoPackets(recordingPath);
  if (gameId === "iracing") return readIRacingPackets(recordingPath);
  if (gameId === "lmu") return readLMUPackets(recordingPath);
  return {
    packets: readFramedPackets(gameId, recordingPath),
    carModel: null,
    trackName: null,
  };
}
