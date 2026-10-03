import type { RecordingGameSupport } from "@raceiq/backend-core/test-support/recordings/parse-dump";
import { lmuServerAdapter } from "../../src/index";
import { readLMUFrames } from "@raceiq/capture-formats/lmu/dump";

export const lmuRecordingSupport: RecordingGameSupport = {
  adapter: lmuServerAdapter,
  async *readPackets(dumpPath) {
    let carModel: string | null = null;
    let trackName: string | null = null;
    const parserState = lmuServerAdapter.createParserState?.() ?? null;
    let frames: Buffer[];
    try {
      frames = readLMUFrames(dumpPath);
    } catch {
      frames = [];
    }
    for (const frame of frames) {
      const packet = lmuServerAdapter.tryParse(frame, parserState);
      if (!packet) continue;
      carModel ??= packet.lmu?.carModel ?? null;
      trackName ??= packet.lmu?.trackName ?? null;
      yield { packet, carModel, trackName };
    }
  },
};
