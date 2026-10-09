import type { TelemetryParser } from "@raceiq/shared/telemetry/parser";
import type { LapIndexPacket } from "@raceiq/shared/telemetry/lap-index";
import { normalizeLMUSourceFrame } from "./normalizer";
import { canHandleLMUSourceFrame, decodeLMUSourceFrame } from "@raceiq/capture-formats/lmu/source-frame";

export const lmuParser: TelemetryParser<null> = {
  canHandle(buf) { return canHandleLMUSourceFrame(buf); },
  tryParse(buf) {
    const frame = decodeLMUSourceFrame(buf);
    return frame ? normalizeLMUSourceFrame(frame) : null;
  },
  tryParseLapIndex(buf): LapIndexPacket | null { return this.tryParse(buf, null) as LapIndexPacket | null; },
  primeParserState() {},
  createParserState() { return null; },
};
