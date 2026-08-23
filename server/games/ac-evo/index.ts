import { resolve } from "node:path";
import type { ServerGameAdapter } from "../types";
import type { TelemetryPacket } from "../../../shared/telemetry/types";
import { acEvoAdapter } from "../../../shared/games/ac-evo";
import { getAcEvoCarName } from "../../../shared/racing/cars/ac-evo";
import { getAcEvoTrackName, getAcEvoSharedTrackName, getAcEvoTrackByName, getAcEvoTrackBySetupFolder } from "../../../shared/racing/tracks/catalogs/ac-evo";
import { LAP_DETECTOR_AC_EVO_ID, LapDetectorAcEvo } from "./lap-detector";
import { AC_EVO_RACE_EVENT_DERIVATIONS } from "./race-event-semantics";
import { parseAcEvoBuffers, createAcEvoParserCache, type AcEvoParserCache } from "./parser";
import { ACEVO_PACKED_MAGIC, unpackTriplet } from "../kunos/pack-triplet";
import { resolveKunosReplayTimestamp } from "../kunos/replay-clock";
import { baseRaceEventObservation, kunosDamagePercent, localPlayerObservation, normalizedFuelLitres, normalizedTireWear } from "../race-event-observation";

export const acEvoServerAdapter: ServerGameAdapter = {
  ...acEvoAdapter,

  runtime: {
    pit: {
      seedFuelFromHistory: true,
      seedTireWearFromHistory: true,
      useDistanceBasedWearCurves: false,
    },
    bestLapFromSession: false,
    requiresTrackCalibration: false,
    normSuspensionTravelMm: { min: 20, max: 80 },
  },
  raceEventDerivations: AC_EVO_RACE_EVENT_DERIVATIONS,
  raceEventTimestampDomain: "wall-clock",
  raceEventObservedAtMs: (_packet, receivedAtMs) => receivedAtMs,

  processNames: ["AssettoCorsaEVO.exe"],

  getSetupsDirCandidates(home: string): string[] {
    // AC EVO saves setups to Saved Games\ACE\Car Setups as binary
    // .carsetup (protobuf) files — not under Documents like ACC.
    return [resolve(home, "Saved Games", "ACE", "Car Setups")];
  },

  getCarName(ordinal: number): string {
    return getAcEvoCarName(ordinal);
  },

  getTrackName(ordinal: number): string {
    return getAcEvoTrackName(ordinal);
  },

  getSharedTrackName(ordinal: number): string | undefined {
    return getAcEvoSharedTrackName(ordinal);
  },

  getTrackOrdinalByName(name: string): number | undefined {
    return getAcEvoTrackBySetupFolder(name)?.id ?? getAcEvoTrackByName(name)?.id;
  },

  canHandle(buf: Buffer): boolean {
    return buf.length > 4 && buf.readUInt32LE(0) === ACEVO_PACKED_MAGIC;
  },

  tryParse(buf: Buffer, state: unknown): TelemetryPacket | null {
    const triplet = unpackTriplet(buf);
    if (!triplet) return null;
    if (triplet.physics.length < 4) return null;
    const cache = (state as AcEvoParserCache | null) ?? createAcEvoParserCache();
    const timestampMS = resolveKunosReplayTimestamp(cache.replayClock, triplet.physics.readInt32LE(0), triplet.timestampMS);
    return parseAcEvoBuffers(triplet.physics, triplet.graphics, triplet.staticData, cache, timestampMS);
  },

  createParserState(): AcEvoParserCache {
    return createAcEvoParserCache();
  },

  toRaceEventObservation(packet, context) {
    const observation = baseRaceEventObservation(packet, context);
    const sessionType = packet.acc?.acEvo?.sessionType;
    if (sessionType && sessionType !== "unknown") {
      observation.raceResult = {
        ...observation.raceResult,
        sessionType,
        sourcePaths: {
          ...observation.raceResult?.sourcePaths,
          sessionType: "acc.acEvo.sessionType",
        },
      };
    }
    observation.nativeRaceControlCode = packet.acc?.flagStatus?.toLowerCase() ?? "unknown";
    const nativePitCode = packet.acc?.pitStatus ?? null;
    observation.participants = [
      localPlayerObservation(packet, {
        pitState: "unknown",
        nativePitCode,
        fuelLitres: normalizedFuelLitres(packet, acEvoAdapter.telemetry.fuel.packetUnit),
        tireCompound: packet.acc?.tireCompound && packet.acc.tireCompound !== "unknown" ? packet.acc.tireCompound : null,
        tireWear: normalizedTireWear(packet),
        damage: kunosDamagePercent(packet),
        penaltyValue: null,
        incidentCount: null,
      }),
    ];
    return observation;
  },

  lapDetectorId: LAP_DETECTOR_AC_EVO_ID,

  createLapDetector: (opts) => new LapDetectorAcEvo(opts),
};
