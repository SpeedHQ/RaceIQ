import type { TelemetryParser } from "@raceiq/shared/telemetry/parser";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { LapIndexPacket } from "@raceiq/shared/telemetry/lap-index";
import { ACC_PACKED_MAGIC, unpackTriplet } from "@raceiq/capture-formats/kunos/pack-triplet";
import { STATIC } from "@raceiq/capture-formats/acc/structs";
import { parseAccBuffers } from "./parser";
import { parseAccLapIndex } from "./lap-index";
import { readWString } from "./utils";
import { getAccParserCarByModel, getAccParserTrackByName } from "@raceiq/game-acc-metadata/parser-data-resolver";


export const accParser: TelemetryParser<null> = {
  canHandle(buf) { return buf.length > 4 && buf.readUInt32LE(0) === ACC_PACKED_MAGIC; },
  tryParse(buf, _state, timestampMs = 0): TelemetryPacket | null {
    const triplet = unpackTriplet(buf);
    if (!triplet) return null;
    let carOrdinal = triplet.carOrdinal;
    let trackOrdinal = triplet.trackOrdinal;
    if (triplet.staticData.length >= STATIC.SIZE) {
      const cm = readWString(triplet.staticData, STATIC.carModel.offset, STATIC.carModel.size);
      const car = cm ? getAccParserCarByModel(cm)?.id : undefined;
      if (car != null) carOrdinal = car;
      const tn = readWString(triplet.staticData, STATIC.track.offset, STATIC.track.size);
      const track = tn ? getAccParserTrackByName(tn)?.id : undefined;
      if (track != null) trackOrdinal = track;
    }
    return parseAccBuffers(triplet.physics, triplet.graphics, triplet.staticData, { carOrdinal, trackOrdinal, timestampMs });
  },
  tryParseLapIndex(buf, _state, timestampMs = 0): LapIndexPacket | null {
    const t = unpackTriplet(buf);
    return t ? parseAccLapIndex(t.physics, t.graphics, t.staticData, t.carOrdinal, t.trackOrdinal, timestampMs) : null;
  },
  primeParserState() {},
  createParserState() { return null; },
};
