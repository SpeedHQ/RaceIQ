import { iracingAdapter } from "../../../shared/games/iracing";
import { getIRacingSharedTrackName, getIRacingTrackName, getIRacingTrackOrdinalByName } from "../../../shared/racing/tracks/catalogs/iracing";
import type { TelemetryPacket } from "../../../shared/telemetry/types";
import { LAP_DETECTOR_IRACING_ID, LapDetectorIRacing } from "./lap-detector";
import { IRACING_RACE_EVENT_DERIVATIONS } from "./race-event-semantics";
import type { ServerGameAdapter } from "../types";
import { createIRacingParserState, type IRacingParserState, normalizeIRacingFrame } from "./normalizer";
import { canHandleIRacingSourceFrame, decodeIRacingSourceFrame } from "./source-frame";
import { baseRaceEventObservation, localPlayerObservation, normalizedFuelLitres } from "../race-event-observation";

export const iracingServerAdapter: ServerGameAdapter = {
  ...iracingAdapter,

  runtime: {
    pit: {
      seedFuelFromHistory: true,
      seedTireWearFromHistory: true,
      useDistanceBasedWearCurves: false,
    },
    bestLapFromSession: false,
    requiresTrackCalibration: false,
    normSuspensionTravelMm: { min: 0, max: 100 },
  },
  raceEventTimestampDomain: "session",
  raceEventDerivations: IRACING_RACE_EVENT_DERIVATIONS,
  raceEventObservedAtMs: (packet, receivedAtMs) => (Number.isFinite(packet.TimestampMS) ? packet.TimestampMS : receivedAtMs),

  processNames: ["iRacingSim64DX11.exe", "iRacingSim64DX11", "iRacingSim.exe"],

  getTrackName(ordinal: number): string {
    return getIRacingTrackName(ordinal);
  },

  getSharedTrackName(ordinal: number): string | undefined {
    return getIRacingSharedTrackName(ordinal);
  },

  getTrackOrdinalByName(name: string): number | undefined {
    return getIRacingTrackOrdinalByName(name);
  },

  canHandle(buf: Buffer): boolean {
    return canHandleIRacingSourceFrame(buf);
  },

  tryParse(buf: Buffer, state: unknown): TelemetryPacket | null {
    const parserState = state as IRacingParserState | null;
    const frame = decodeIRacingSourceFrame(buf, parserState?.source);
    return frame ? normalizeIRacingFrame(frame, parserState) : null;
  },

  createParserState(): IRacingParserState {
    return createIRacingParserState();
  },

  toRaceEventObservation(packet, context) {
    const observation = baseRaceEventObservation(packet, context);
    observation.trackDistanceM = packet.iracing && Number.isFinite(packet.iracing.lapDistanceM) ? packet.iracing.lapDistanceM : null;
    observation.trackDistancePct =
      packet.iracing && Number.isFinite(packet.iracing.lapDistancePct) && packet.iracing.lapDistancePct >= 0 && packet.iracing.lapDistancePct <= 1 ? packet.iracing.lapDistancePct : null;
    // The live SDK does not provide stable world-space racing-line position.
    observation.worldPosition = null;
    const onPitRoad = packet.iracing?.onPitRoad;
    observation.participants = [
      localPlayerObservation(packet, {
        pitState: "unknown",
        nativePitCode: typeof onPitRoad === "boolean" ? (onPitRoad ? 1 : 0) : null,
        fuelLitres: normalizedFuelLitres(packet, iracingAdapter.telemetry.fuel.packetUnit),
        tireCompound: null,
        tireWear: null,
        damage: null,
        penaltyValue: null,
        incidentCount: packet.iracing && Number.isInteger(packet.iracing.incidents) && packet.iracing.incidents >= 0 ? packet.iracing.incidents : null,
      }),
    ];
    return observation;
  },

  lapDetectorId: LAP_DETECTOR_IRACING_ID,

  createLapDetector: (opts) => new LapDetectorIRacing(opts),
};
