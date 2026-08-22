import { resolve } from "node:path";
import type { ServerGameAdapter } from "../types";
import type { TelemetryPacket } from "../../../shared/telemetry/types";
import { accAdapter } from "../../../shared/games/acc";
import { getAccCarName, getAccCarByModel } from "../../../shared/racing/cars/acc";
import { getAccTrackName, getAccSharedTrackName, getAccTrackByName, getAccTrackBySetupFolder } from "../../../shared/racing/tracks/catalogs/acc";
import { LAP_DETECTOR_ACC_ID, LapDetectorAcc } from "./lap-detector";
import { ACC_RACE_EVENT_DERIVATIONS } from "./race-event-semantics";
import { parseAccBuffers } from "./parser";
import { PHYSICS, STATIC } from "./structs";
import { readWString } from "./utils";
import { ACC_PACKED_MAGIC, unpackTriplet } from "../kunos/pack-triplet";
import { createKunosReplayClock, isKunosReplayClock, resolveKunosReplayTimestamp, type KunosReplayClock } from "../kunos/replay-clock";
import { baseRaceEventObservation, kunosDamagePercent, localPlayerObservation, normalizedFuelLitres, normalizedTireWear } from "../race-event-observation";

export const accServerAdapter: ServerGameAdapter = {
  ...accAdapter,

  runtime: {
    pit: {
      seedFuelFromHistory: true,
      seedTireWearFromHistory: true,
      useDistanceBasedWearCurves: true,
    },
    bestLapFromSession: true,
    requiresTrackCalibration: false,
    normSuspensionTravelMm: { min: 0, max: 50 },
  },
  raceEventDerivations: ACC_RACE_EVENT_DERIVATIONS,
  raceEventTimestampDomain: "wall-clock",
  raceEventObservedAtMs: (_packet, receivedAtMs) => receivedAtMs,

  processNames: ["acc.exe", "acs2.exe", "AC2-Win64-Shipping.exe"],

  getSetupsDirCandidates(home: string): string[] {
    return [resolve(home, "Documents", "Assetto Corsa Competizione", "Setups"), resolve(home, "OneDrive", "Documents", "Assetto Corsa Competizione", "Setups")];
  },

  getCarName(ordinal: number): string {
    return getAccCarName(ordinal);
  },

  getTrackName(ordinal: number): string {
    return getAccTrackName(ordinal);
  },

  getSharedTrackName(ordinal: number): string | undefined {
    return getAccSharedTrackName(ordinal);
  },

  getTrackOrdinalByName(name: string): number | undefined {
    return getAccTrackBySetupFolder(name)?.id ?? getAccTrackByName(name)?.id;
  },

  // ACC uses shared memory, not UDP — canHandle returns false since
  // ACC data doesn't go through the UDP parser dispatch.
  canHandle(buf: Buffer): boolean {
    return buf.length > 4 && buf.readUInt32LE(0) === ACC_PACKED_MAGIC;
  },

  tryParse(buf: Buffer, state: unknown): TelemetryPacket | null {
    const triplet = unpackTriplet(buf);
    if (!triplet) return null;
    if (triplet.physics.length < 4) return null;
    const replayClock = isKunosReplayClock(state) ? state : createKunosReplayClock();
    const timestampMS = resolveKunosReplayTimestamp(replayClock, triplet.physics.readInt32LE(PHYSICS.packetId.offset), triplet.timestampMS);

    // Prefer re-resolving from the embedded static struct over the packed
    // header — the header is a cache of whatever ParsingProcessor had
    // resolved *at capture time*, which older recordings baked in as 0
    // (Monza/car #0) whenever resolution hadn't happened yet. The static
    // struct is the ground truth and is stored in full on every frame, so
    // re-deriving here repairs already-recorded .bin files on import too.
    let carOrdinal = triplet.carOrdinal;
    let trackOrdinal = triplet.trackOrdinal;
    if (triplet.staticData.length >= STATIC.SIZE) {
      const cm = readWString(triplet.staticData, STATIC.carModel.offset, STATIC.carModel.size);
      const resolvedCar = cm ? getAccCarByModel(cm)?.id : undefined;
      if (resolvedCar != null) carOrdinal = resolvedCar;

      const tn = readWString(triplet.staticData, STATIC.track.offset, STATIC.track.size);
      const resolvedTrack = tn ? getAccTrackByName(tn)?.id : undefined;
      if (resolvedTrack != null) trackOrdinal = resolvedTrack;
    }

    return parseAccBuffers(triplet.physics, triplet.graphics, triplet.staticData, {
      carOrdinal,
      trackOrdinal,
      timestampMS,
    });
  },

  createParserState(): KunosReplayClock {
    return createKunosReplayClock();
  },

  toRaceEventObservation(packet, context) {
    const observation = baseRaceEventObservation(packet, context);
    observation.nativeRaceControlCode = packet.acc?.flagStatus?.toLowerCase() ?? "unknown";
    const nativePitCode = packet.acc?.pitStatus ?? null;
    observation.participants = [
      localPlayerObservation(packet, {
        pitState: "unknown",
        nativePitCode,
        fuelLitres: normalizedFuelLitres(packet, accAdapter.telemetry.fuel.packetUnit),
        tireCompound: packet.acc?.tireCompound && packet.acc.tireCompound !== "unknown" ? packet.acc.tireCompound : null,
        tireWear: normalizedTireWear(packet),
        damage: kunosDamagePercent(packet),
        penaltyValue: null,
        incidentCount: null,
      }),
    ];
    return observation;
  },

  lapDetectorId: LAP_DETECTOR_ACC_ID,

  createLapDetector: (opts) => new LapDetectorAcc(opts),
};
