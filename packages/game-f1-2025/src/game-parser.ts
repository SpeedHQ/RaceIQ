import type { TelemetryParser } from "@raceiq/shared/telemetry/parser";
import type { LapIndexPacket } from "@raceiq/shared/telemetry/lap-index";
import { F1StateAccumulator } from "./f1-state";
import { parseF1Header } from "@raceiq/capture-formats/f1-2025/f1-wire";

export const f1Parser: TelemetryParser<F1StateAccumulator> = {
  canHandle(buf) { return buf.length >= 29 && buf.readUInt16LE(0) === 2025; },
  tryParse(buf, state) { return state.feed(parseF1Header(buf), buf); },
  tryParseLapIndex(buf, state): LapIndexPacket | null { return this.tryParse(buf, state) as unknown as LapIndexPacket; },
  primeParserState(buf, state) { state.primeParserState(parseF1Header(buf), buf); },
  createParserState() { return new F1StateAccumulator(); },
};
