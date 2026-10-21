import type { RecordingGameSupport } from "@raceiq/backend-core/test-support/recordings/parse-dump";
import { f1ServerAdapter } from "../../src/index";
import { readUdpDump } from "@raceiq/backend-core/test-support/recordings/udp";

export const f1RecordingSupport: RecordingGameSupport = {
  adapter: f1ServerAdapter,
  async *readPackets(dumpPath) {
    let buffers: Buffer[];
    try {
      buffers = readUdpDump(dumpPath);
    } catch {
      return;
    }
    const parserState = f1ServerAdapter.createParserState?.() ?? null;
    for (const buffer of buffers) {
      const packet = f1ServerAdapter.tryParse(buffer, parserState);
      if (packet) yield { packet };
    }
  },
};
