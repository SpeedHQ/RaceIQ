import type { TelemetryParser } from "@raceiq/shared/telemetry/parser";
import type { LapIndexPacket } from "@raceiq/shared/telemetry/lap-index";
import { normalizeLMUSourceFrame } from "./normalizer";
import { canHandleLMUSourceFrame, createLMUSourceFrameDecoder } from "@raceiq/capture-formats/lmu/source-frame";

const sourceDecoder = createLMUSourceFrameDecoder();

export const lmuParser: TelemetryParser<null> = {
  canHandle(buf) { return canHandleLMUSourceFrame(buf); },
  tryParse(buf) {
    const frame = sourceDecoder.decode(buf);
    return frame ? normalizeLMUSourceFrame(frame) : null;
  },
  tryParseLapIndex(buf): LapIndexPacket | null { return this.tryParse(buf, null) as LapIndexPacket | null; },
  primeParserState() {},
  createParserState() { sourceDecoder.reset(); return null; },
};
