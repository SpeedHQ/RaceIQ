import type { TelemetryParser } from "@raceiq/shared/telemetry/parser";
import type { LapIndexPacket } from "@raceiq/shared/telemetry/lap-index";
import { createIRacingParserState, type IRacingParserState, normalizeIRacingFrame, projectIRacingLapIndex } from "./normalizer";
import { canHandleIRacingSourceFrame, decodeIRacingSourceFrame } from "@raceiq/capture-formats/iracing/source-frame";

export const iracingParser: TelemetryParser<IRacingParserState> = {
  canHandle(buf) { return canHandleIRacingSourceFrame(buf); },
  tryParse(buf, state) {
    const frame = decodeIRacingSourceFrame(buf, state?.source);
    return frame ? normalizeIRacingFrame(frame, state) : null;
  },
  tryParseLapIndex(buf, state): LapIndexPacket | null {
    const frame = decodeIRacingSourceFrame(buf, state?.source);
    return frame ? projectIRacingLapIndex(frame, state) : null;
  },
  primeParserState(buf, state) { decodeIRacingSourceFrame(buf, state?.source); },
  createParserState() { return createIRacingParserState(); },
};
