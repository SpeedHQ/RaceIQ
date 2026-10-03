import type { RecordingGameSupport, ParsedFrames } from "@raceiq/backend-core/test-support/recordings/parse-dump";
import { acEvoServerAdapter } from "../../src/index";
import { parseAcEvoBuffers, createAcEvoParserCache } from "../../src/parser";
import { readKunosFrames } from "@raceiq/backend-core/games/kunos/frame-reader";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";

export function readAcEvoPackets(dumpPath: string): ParsedFrames {
  let frames: { physics: Buffer; graphics: Buffer; staticData: Buffer }[];
  try {
    frames = readKunosFrames(dumpPath);
  } catch {
    return { packets: [], carModel: null, trackName: null };
  }
  const cache = createAcEvoParserCache();
  const packets: TelemetryPacket[] = [];
  for (const frame of frames) {
    const packet = parseAcEvoBuffers(frame.physics, frame.graphics, frame.staticData, cache);
    if (packet) packets.push(packet);
  }
  return {
    packets,
    carModel: cache.lastCarModel || null,
    trackName: cache.lastTrack || null,
  };
}

export const acEvoRecordingSupport: RecordingGameSupport = {
  adapter: acEvoServerAdapter,
  async *readPackets(dumpPath) {
  let frames: { physics: Buffer; graphics: Buffer; staticData: Buffer }[];
  try {
    frames = readKunosFrames(dumpPath);
  } catch {
    return;
  }
  const cache = createAcEvoParserCache();
  for (const frame of frames) {
    const packet = parseAcEvoBuffers(frame.physics, frame.graphics, frame.staticData, cache);
    if (packet) yield { packet, carModel: cache.lastCarModel || null, trackName: cache.lastTrack || null };
  }
  },
};
