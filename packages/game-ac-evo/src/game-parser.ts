import type { TelemetryParser } from "@raceiq/shared/telemetry/parser";
import type { LapIndexPacket } from "@raceiq/shared/telemetry/lap-index";
import { ACEVO_PACKED_MAGIC, unpackTriplet } from "@raceiq/capture-formats/kunos/pack-triplet";
import { parseAcEvoBuffers, createAcEvoParserCache } from "./parser";
import { parseAcEvoLapIndex } from "./lap-index";

export const acEvoParser: TelemetryParser<ReturnType<typeof createAcEvoParserCache>> = {
  canHandle(buf) { return buf.length > 4 && buf.readUInt32LE(0) === ACEVO_PACKED_MAGIC; },
  tryParse(buf, state, timestampMs = 0) {
    const triplet = unpackTriplet(buf);
    if (!triplet) return null;
    const cache = state ?? createAcEvoParserCache();
    return parseAcEvoBuffers(triplet.physics, triplet.graphics, triplet.staticData, cache, timestampMs);
  },
  tryParseLapIndex(buf, state, timestampMs = 0): LapIndexPacket | null {
    const triplet = unpackTriplet(buf);
    const cache = state ?? createAcEvoParserCache();
    return triplet ? parseAcEvoLapIndex(triplet.physics, triplet.graphics, triplet.staticData, cache, timestampMs) : null;
  },
  primeParserState(buf, state) {
    const triplet = unpackTriplet(buf);
    if (triplet) parseAcEvoLapIndex(triplet.physics, triplet.graphics, triplet.staticData, state ?? createAcEvoParserCache());
  },
  createParserState() { return createAcEvoParserCache(); },
};
