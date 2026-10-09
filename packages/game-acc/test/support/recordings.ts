import type { RecordingGameSupport, ParsedFrames } from "@raceiq/backend-core/test-support/recordings/parse-dump";
import { accServerAdapter } from "../../src/index";
import { parseAccBuffers } from "../../src/parser";
import { readWString } from "../../src/utils";
import { readKunosFrames } from "@raceiq/capture-formats/kunos/dump";
import { STATIC } from "@raceiq/capture-formats/acc/structs";
import { getAccCarByModel } from "@raceiq/game-acc-metadata/racing/cars/acc";
import { getAccTrackByName } from "@raceiq/game-acc-metadata/racing/tracks/catalogs/acc";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { META_FRAME_MAGIC } from "@raceiq/capture-formats/session/framing";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const DEFAULT_ACC_FRAME_STRIDE = 4;

export function readAccPackets(dumpPath: string): ParsedFrames {
  let frames: { physics: Buffer; graphics: Buffer; staticData: Buffer }[];
  try {
    frames = readKunosFrames(dumpPath);
  } catch {
    return { packets: [], carModel: null, trackName: null };
  }
  let carModel: string | null = null;
  let trackName: string | null = null;
  let carOrdinal = 0;
  let trackOrdinal = 0;
  const packets: TelemetryPacket[] = [];
  for (const frame of frames) {
    if (carOrdinal === 0 || trackOrdinal === 0) {
      const cm = readWString(frame.staticData, STATIC.carModel.offset, STATIC.carModel.size);
      const tn = readWString(frame.staticData, STATIC.track.offset, STATIC.track.size);
      if (cm) { carModel = cm; carOrdinal = getAccCarByModel(cm)?.id ?? 0; }
      if (tn) { trackName = tn; trackOrdinal = getAccTrackByName(tn)?.id ?? 0; }
    }
    const packet = parseAccBuffers(frame.physics, frame.graphics, frame.staticData, { carOrdinal, trackOrdinal });
    if (packet) packets.push(packet);
  }
  return { packets, carModel, trackName };
}

export const accRecordingSupport: RecordingGameSupport = {
  adapter: accServerAdapter,
  async *readPackets(dumpPath, options) {
    let carModel: string | null = null;
    let trackName: string | null = null;
    let frames: { physics: Buffer; graphics: Buffer; staticData: Buffer }[];
    try {
      frames = readKunosFrames(dumpPath);
    } catch {
      return;
    }

    if (frames.length > 0) {
      // ACCTEST recorder format. Parse and process each frame immediately so
      // full-session packet objects are not retained in a second array.
      let carOrdinal = 0;
      let trackOrdinal = 0;
      const frameStride = Math.max(1, Math.floor(options.accFrameStride ?? DEFAULT_ACC_FRAME_STRIDE));
      let frameIndex = 0;
      let processedFrames = 0;
      for (const frame of frames) {
        if (frameIndex++ % frameStride !== 0) continue;
        if (carOrdinal === 0 || trackOrdinal === 0) {
          const cm = readWString(frame.staticData, STATIC.carModel.offset, STATIC.carModel.size);
          const tn = readWString(frame.staticData, STATIC.track.offset, STATIC.track.size);
          if (cm) {
            carModel = cm;
            carOrdinal = getAccCarByModel(cm)?.id ?? 0;
          }
          if (tn) {
            trackName = tn;
            trackOrdinal = getAccTrackByName(tn)?.id ?? 0;
          }
        }
        const packet = parseAccBuffers(frame.physics, frame.graphics, frame.staticData, { carOrdinal, trackOrdinal });
        if (packet) yield { packet, carModel, trackName };
        // Capture adapter writes resolve synchronously. Yield
        // periodically so long recordings do not defer GC until suite timeout.
        if ((++processedFrames & 1023) === 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
    } else {
      let raw: Buffer;
      try {
        raw = readFileSync(dumpPath);
        if (dumpPath.endsWith(".gz")) raw = gunzipSync(raw);
      } catch {
        return;
      }
      if (raw.length < 4 || raw.readUInt32LE(0) !== META_FRAME_MAGIC) {
        return;
      }

      // Session bin format (packed triplets)
      const serverGame = accServerAdapter;
      const parserState = serverGame.createParserState?.() ?? null;
      let offset = 8 + raw.readUInt32LE(4); // skip meta frame
      while (offset < raw.length) {
        if (offset + 4 > raw.length) break;
        const frameLen = raw.readUInt32LE(offset);
        if (frameLen === META_FRAME_MAGIC) {
          offset += 8 + raw.readUInt32LE(offset + 4);
          continue;
        }
        offset += 4;
        if (offset + frameLen > raw.length) break;
        const packet = serverGame.tryParse(raw.subarray(offset, offset + frameLen), parserState);
        offset += frameLen;
        if (packet) yield { packet, carModel, trackName };
      }
    }
  },
};
