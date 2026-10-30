import type { TelemetryParser } from "@raceiq/shared/telemetry/parser";
import type { LapIndexPacket } from "@raceiq/shared/telemetry/lap-index";
import { F1StateAccumulator } from "./f1-state";
import { isF1PacketFormat, parseF1Header } from "@raceiq/capture-formats/f1-2025/f1-wire";

function hasF1Header(buf: Buffer): boolean {
  return buf.length >= 29 && isF1PacketFormat(buf.readUInt16LE(0));
}

export const f1Parser: TelemetryParser<F1StateAccumulator> = {
  canHandle: hasF1Header,
  tryParse(buf, state) { return hasF1Header(buf) ? state.feed(parseF1Header(buf), buf) : null; },
  tryParseLapIndex(buf, state): LapIndexPacket | null { return this.tryParse(buf, state) as unknown as LapIndexPacket; },
  primeParserState(buf, state) { if (hasF1Header(buf)) state.primeParserState(parseF1Header(buf), buf); },
  createParserState() { return new F1StateAccumulator(); },
};
