import { readFileSync } from "node:fs";
import type { GameId } from "../../shared/games/ids";
import { getAccCarByModel } from "../../shared/racing/cars/acc";
import { getAccTrackByName } from "../../shared/racing/tracks/catalogs/acc";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { parseAccBuffers } from "../games/acc/parser";
import { STATIC } from "../games/acc/structs";
import { readWString } from "../games/acc/utils";
import {
  createAcEvoParserCache,
  parseAcEvoBuffers,
} from "../games/ac-evo/parser";
import { readIRacingFrames } from "../games/iracing/recorder";
import { readLMUFrames } from "../games/lmu/recorder";
import { readKunosFrames } from "../games/kunos/frame-reader";
import { getServerGame } from "../games/registry";
import { decompressIfGzipSync, iterateSessionFrames } from "./framing";

export interface RecordedTelemetry {
  readonly packets: TelemetryPacket[];
  readonly carModel: string | null;
  readonly trackName: string | null;
}

function readFramedPackets(gameId: GameId, recordingPath: string): TelemetryPacket[] {
  const game = getServerGame(gameId);
  const parserState = game.createParserState?.() ?? null;
  const bytes = decompressIfGzipSync(readFileSync(recordingPath));
  const packets: TelemetryPacket[] = [];
  for (const frame of iterateSessionFrames(bytes)) {
    const packet = game.tryParse(frame, parserState);
    if (packet) packets.push(packet);
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
  for (const frame of readLMUFrames(recordingPath)) {
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
