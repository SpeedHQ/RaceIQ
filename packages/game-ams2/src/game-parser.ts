import type { TelemetryParser } from "@raceiq/shared/telemetry/parser";
import { decodeAMS2Frame } from "./frame";
import { normalizeAMS2Frame } from "./normalizer";

function parseDrivingFrame(buffer: Buffer) {
  const frame = decodeAMS2Frame(buffer);
  if (!frame || ![2, 3, 4].includes(frame.memory.readUInt32LE(8))) return null;
  return normalizeAMS2Frame(buffer);
}

export const ams2Parser: TelemetryParser<null> = {
  canHandle: buffer => decodeAMS2Frame(buffer) !== null,
  tryParse: parseDrivingFrame,
  tryParseLapIndex: parseDrivingFrame,
  primeParserState: () => {},
  createParserState: () => null,
};
