import type { ServerGameAdapter } from "../types";
import { forzaAdapter } from "../../../shared/games/fm-2023";
import { parseForzaPacket } from "./parser";
import { fmCarCatalog } from "../../../shared/racing/cars/fm";
import { fmTrackCatalog } from "../../../shared/racing/tracks/catalogs/fm";
import { getForzaSharedOutline } from "../../../shared/racing/tracks/geometry/outlines";
import { LAP_DETECTOR_ID, LapDetector } from "../../lap-detection/detector";
import { baseRaceEventObservation, localPlayerObservation, normalizedFuelLitres, normalizedTireWear } from "../race-event-observation";

export const forzaServerAdapter: ServerGameAdapter = {
  ...forzaAdapter,

  runtime: {
    pit: {
      seedFuelFromHistory: true,
      seedTireWearFromHistory: false,
      useDistanceBasedWearCurves: false,
    },
    bestLapFromSession: false,
    requiresTrackCalibration: true,
    normSuspensionTravelMm: { min: 20, max: 80 },
  },
  raceEventDerivations: [],
  raceEventTimestampDomain: "session",
  raceEventObservedAtMs: (packet, receivedAtMs) => (Number.isFinite(packet.TimestampMS) ? packet.TimestampMS : receivedAtMs),

  processNames: ["ForzaMotorsport.exe", "forza_steamworks_release_final"],

  getCarName(ordinal) {
    const car = fmCarCatalog.get(ordinal);
    if (!car) return `Car #${ordinal}`;
    return `${car.year} ${car.make} ${car.model}`;
  },

  getTrackName(ordinal) {
    const track = fmTrackCatalog.get(ordinal);
    if (!track) return `Track #${ordinal}`;
    return `${track.name} - ${track.variant}`;
  },

  getSharedTrackName(ordinal) {
    return getForzaSharedOutline(ordinal);
  },

  canHandle(buf) {
    return buf.length >= 324 && buf.length <= 400;
  },

  tryParse(buf) {
    return parseForzaPacket(buf);
  },

  createParserState() {
    return null;
  },

  toRaceEventObservation(packet, context) {
    const observation = baseRaceEventObservation(packet, context);
    observation.participants = [
      localPlayerObservation(packet, {
        pitState: "unknown",
        nativePitCode: null,
        fuelLitres: normalizedFuelLitres(packet, forzaAdapter.telemetry.fuel.packetUnit),
        tireCompound: null,
        tireWear: normalizedTireWear(packet),
        damage: null,
        penaltyValue: null,
        incidentCount: null,
      }),
    ];
    return observation;
  },

  lapDetectorId: LAP_DETECTOR_ID,

  createLapDetector: (opts) => new LapDetector(opts),
};
