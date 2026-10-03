import type { RecordingGameSupport } from "@raceiq/backend-core/test-support/recordings/parse-dump";
import { iracingServerAdapter } from "../../src/index";
import { readIRacingFrames } from "@raceiq/capture-formats/iracing/dump";

export const iracingRecordingSupport: RecordingGameSupport = {
  adapter: iracingServerAdapter,
  async *readPackets(dumpPath) {
    let carModel: string | null = null;
    let trackName: string | null = null;
    const parserState = iracingServerAdapter.createParserState?.() ?? null;
    let frames: Buffer[];
    try {
      frames = readIRacingFrames(dumpPath);
    } catch {
      frames = [];
    }
    for (const frame of frames) {
      const packet = iracingServerAdapter.tryParse(frame, parserState);
      if (!packet) continue;
      carModel ??= packet.iracing?.carName ?? null;
      trackName ??= packet.iracing?.trackName ?? null;
      yield { packet, carModel, trackName };
    }
  },
};
