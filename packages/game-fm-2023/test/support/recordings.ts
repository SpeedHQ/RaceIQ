import type { RecordingGameSupport } from "@raceiq/backend-core/test-support/recordings/parse-dump";
import { forzaServerAdapter } from "../../src/index";
import { readUdpDump } from "@raceiq/backend-core/test-support/recordings/udp";

export const fmRecordingSupport: RecordingGameSupport = {
  adapter: forzaServerAdapter,
  async *readPackets(dumpPath) {
    let buffers: Buffer[];
    try {
      buffers = readUdpDump(dumpPath);
    } catch {
      return;
    }
    const parserState = forzaServerAdapter.createParserState?.() ?? null;
    for (const buffer of buffers) {
      const packet = forzaServerAdapter.tryParse(buffer, parserState);
      if (packet) yield { packet };
    }
  },
};
