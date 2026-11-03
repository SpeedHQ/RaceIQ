import type { TelemetryParser } from "@raceiq/shared/telemetry/parser";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { LapIndexPacket } from "@raceiq/shared/telemetry/lap-index";
import { ACC_PACKED_MAGIC, unpackTriplet } from "@raceiq/capture-formats/kunos/pack-triplet";
import { parseAccBuffers } from "./parser";
import { parseAccLapIndex } from "./lap-index";


// ACC parser is frame-local; checkpoint restore requires no payload.
export const accParser: TelemetryParser<null> = {
  canHandle(buf) { return buf.length > 4 && buf.readUInt32LE(0) === ACC_PACKED_MAGIC; },
  tryParse(buf, _state, timestampMs = 0): TelemetryPacket | null {
    const triplet = unpackTriplet(buf);
    if (!triplet) return null;
    const carId = triplet.carOrdinal < 0 ? "" : String(triplet.carOrdinal);
    const trackId = triplet.trackOrdinal < 0 ? "" : String(triplet.trackOrdinal);
    return parseAccBuffers(triplet.physics, triplet.graphics, triplet.staticData, { fallbackCarId: carId, fallbackTrackId: trackId, timestampMs });
  },
  tryParseLapIndex(buf, _state, timestampMs = 0): LapIndexPacket | null {
    const t = unpackTriplet(buf);
    return t ? parseAccLapIndex(t.physics, t.graphics, t.staticData, t.carOrdinal < 0 ? "" : String(t.carOrdinal), t.trackOrdinal < 0 ? "" : String(t.trackOrdinal), timestampMs) : null;
  },
  primeParserState() {},
  createParserState() { return null; },
};
