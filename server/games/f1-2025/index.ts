import type { ServerGameAdapter } from "../types";
import { f1Adapter } from "../../../shared/games/f1-2025";
import { F1StateAccumulator } from "./f1-state";
import { F1_RACE_EVENT_DERIVATIONS } from "./race-event-semantics";
import { parseF1Header } from "./f1-wire";
import { getF1CarName } from "../../../shared/racing/cars/f1";
import { getF1TrackName, getF1TrackInfo } from "../../../shared/racing/tracks/catalogs/f1";
import { LAP_DETECTOR_ID, LapDetector } from "../../lap-detection/detector";
import type { RaceParticipantObservation } from "../types";
import type { ResultClassification } from "../../race-results/types";
import { baseRaceEventObservation, normalizedFuelLitres, normalizedTireWear } from "../race-event-observation";

export const f1ServerAdapter: ServerGameAdapter = {
  ...f1Adapter,

  runtime: {
    pit: {
      seedFuelFromHistory: false,
      seedTireWearFromHistory: true,
      useDistanceBasedWearCurves: false,
    },
    bestLapFromSession: false,
    requiresTrackCalibration: true,
    normSuspensionTravelMm: { min: 20, max: 80 },
  },
  raceEventDerivations: F1_RACE_EVENT_DERIVATIONS,
  raceEventTimestampDomain: "session",
  raceEventObservedAtMs: (packet, receivedAtMs) => (Number.isFinite(packet.TimestampMS) ? packet.TimestampMS : receivedAtMs),

  processNames: ["F1_25.exe", "F1_2025.exe"],

  getCarName(ordinal) {
    return getF1CarName(ordinal);
  },

  getTrackName(ordinal) {
    return getF1TrackName(ordinal);
  },

  getSharedTrackName(ordinal) {
    return getF1TrackInfo(ordinal)?.commonTrackName || undefined;
  },

  canHandle(buf) {
    return buf.length >= 29 && buf.readUInt16LE(0) === 2025;
  },

  tryParse(buf, state) {
    const accumulator = state as F1StateAccumulator;
    const header = parseF1Header(buf);
    return accumulator.feed(header, buf);
  },

  createParserState() {
    return new F1StateAccumulator();
  },

  toRaceEventObservation(packet, context) {
    const observation = baseRaceEventObservation(packet, context);
    const f1 = packet.f1;
    if (!f1) return observation;
    const classification: ResultClassification | null =
      f1.resultStatus === 3 ? "finished" : f1.resultStatus === 4 ? "dnf" : f1.resultStatus === 5 ? "disqualified" : f1.resultStatus === 6 ? "not-classified" : f1.resultStatus === 7 ? "retired" : null;
    const classificationSource = classification == null ? null : f1.resultSource === "final-classification" ? ("final-classification" as const) : ("lap-data" as const);
    const finishingPosition = Number.isInteger(packet.RacePosition) && packet.RacePosition > 0 ? packet.RacePosition : null;
    const gridPosition = f1.gridPosition;
    const qualifyingPosition = typeof gridPosition === "number" && Number.isInteger(gridPosition) && gridPosition > 0 ? gridPosition : null;
    let isFastestLap: boolean | null = null;
    if (Number.isFinite(packet.BestLap) && packet.BestLap > 0 && f1.grid) {
      let gridBest: number | null = null;
      for (const entry of f1.grid) {
        if (Number.isFinite(entry.bestLapTime) && entry.bestLapTime > 0 && (gridBest == null || entry.bestLapTime < gridBest)) {
          gridBest = entry.bestLapTime;
        }
      }
      if (gridBest != null) isFastestLap = packet.BestLap <= gridBest;
    }
    observation.raceResult = {
      ...observation.raceResult,
      sessionType: f1.sessionType && f1.sessionType !== "unknown" ? f1.sessionType : null,
      classification,
      classificationSource,
      finishingPosition,
      finishingPositionSource: classificationSource === "final-classification" ? "final-classification" : "lap-data",
      qualifyingPosition,
      qualifyingPositionSource: qualifyingPosition == null ? null : classificationSource === "final-classification" ? "final-classification" : "lap-data",
      isFastestLap,
      fastestLapSource: isFastestLap == null ? null : "f1-grid",
      resultReason: classificationSource === "final-classification" ? (f1.resultReason ?? null) : null,
      observedAtMs: Number.isFinite(packet.TimestampMS) ? packet.TimestampMS : context.receivedAtMs,
      sourcePaths: {
        sessionType: "f1.sessionType",
        classification: "f1.resultStatus",
        finishingPosition: "race.race-position",
        qualifyingPosition: "timing.grid-position",
        isFastestLap: "player-vs-f1.grid.bestLapTime",
        resultReason: "f1.finalClassification.resultReason",
      },
    };
    // Native F1 reports signed pre-grid distance; shared event coordinates are
    // non-negative, while grid detection below still uses signed magnitude.
    if (packet.DistanceTraveled < 0) observation.trackDistanceM = null;

    observation.gridStart =
      packet.LapNumber === 1 && qualifyingPosition !== null && packet.RacePosition > 0 && packet.CurrentRaceTime >= 0 && packet.CurrentRaceTime <= 5 && Math.abs(packet.DistanceTraveled) >= 25;

    observation.nativeRaceControlCode = f1.resultSource === "final-classification" ? (f1.resultStatus ?? null) : (f1.safetyCarStatus ?? f1.vehicleFIAFlags ?? null);
    if (f1.resultSource === "final-classification") {
      observation.terminalObserved = true;
    }

    const localWear = normalizedTireWear(packet);
    const damageEntries: [string, number][] = [];
    for (const [component, value] of [
      ["front-left-wing", f1.frontLeftWingDamage],
      ["front-right-wing", f1.frontRightWingDamage],
      ["rear-wing", f1.rearWingDamage],
      ["floor", f1.floorDamage],
      ["diffuser", f1.diffuserDamage],
      ["sidepod", f1.sidepodDamage],
      ["front-left-tire", f1.tyresDamageFL],
      ["front-right-tire", f1.tyresDamageFR],
      ["rear-left-tire", f1.tyresDamageRL],
      ["rear-right-tire", f1.tyresDamageRR],
      ["front-left-brake", f1.brakesDamageFL],
      ["front-right-brake", f1.brakesDamageFR],
      ["rear-left-brake", f1.brakesDamageRL],
      ["rear-right-brake", f1.brakesDamageRR],
      ["gearbox", f1.gearBoxDamage],
      ["engine", f1.engineDamage],
    ] as const) {
      if (typeof value === "number" && Number.isFinite(value)) {
        damageEntries.push([component, Math.max(0, Math.min(100, value))]);
      }
    }
    const localDamage = f1.damageAvailable !== false && damageEntries.length > 0 ? Object.fromEntries(damageEntries) : null;
    const localFuelLitres = normalizedFuelLitres(packet, f1Adapter.telemetry.fuel.packetUnit);
    const localRetirementStatus =
      f1.resultSource !== "final-classification"
        ? "unknown"
        : f1.resultStatus === 3
          ? "finished"
          : f1.resultStatus === 4 || f1.resultStatus === 7
            ? "retired"
            : f1.resultStatus === 5
              ? "disqualified"
              : f1.resultStatus === 2
                ? "active"
                : "unknown";
    const sourceDriverId = (value: number | null | undefined) => (typeof value === "number" && value >= 0 && value !== 255 ? `f1-driver:${value}` : null);
    const sourceTeamId = (value: number | null | undefined) => (typeof value === "number" && value >= 0 && value !== 255 ? `f1-team:${value}` : null);

    observation.participants = (f1.grid ?? []).map((entry) => {
      const player = entry.isPlayer;
      const nativePitCode = Number.isFinite(entry.pitStatus) ? entry.pitStatus : null;
      return {
        participantId: `f1-car:${entry.carIndex}`,
        participantKind: player ? "player" : "opponent",
        sourceId: String(entry.carIndex),
        identityState: "session-scoped",
        driverId: sourceDriverId(entry.driverId),
        teamId: sourceTeamId(entry.teamId),
        displayName: entry.name || null,
        vehicleId: `f1-car:${entry.carIndex}`,
        pitState: "unknown",
        nativePitCode,
        position: entry.position > 0 ? entry.position : null,
        speedMps: player && Number.isFinite(packet.Speed) ? packet.Speed : null,
        fuelLitres: player ? localFuelLitres : null,
        tireCompound: entry.tyreCompound && entry.tyreCompound !== "unknown" ? entry.tyreCompound : null,
        tireWear: player ? localWear : null,
        damage: player ? localDamage : null,
        penaltyValue: player ? (f1.penalties ?? null) : null,
        incidentCount: null,
        retirementStatus: player ? localRetirementStatus : "unknown",
        nativeRetirementCode: player && f1.resultSource === "final-classification" ? (f1.resultStatus ?? null) : null,
      } satisfies RaceParticipantObservation;
    });
    if (observation.participants.length === 0) {
      const nativePitCode = Number.isFinite(f1.pitStatus) ? f1.pitStatus : null;
      observation.participants = [
        {
          participantId: `f1-car:${f1.playerCarIndex}`,
          participantKind: "player",
          sourceId: String(f1.playerCarIndex),
          identityState: "session-scoped",
          driverId: null,
          teamId: null,
          displayName: null,
          vehicleId: `f1-car:${f1.playerCarIndex}`,
          pitState: "unknown",
          nativePitCode,
          position: packet.RacePosition > 0 ? packet.RacePosition : null,
          speedMps: Number.isFinite(packet.Speed) ? packet.Speed : null,
          fuelLitres: localFuelLitres,
          tireCompound: f1.tyreCompound && f1.tyreCompound !== "unknown" ? f1.tyreCompound : null,
          tireWear: localWear,
          damage: localDamage,
          penaltyValue: f1.penalties ?? null,
          incidentCount: null,
          retirementStatus: localRetirementStatus,
          nativeRetirementCode: f1.resultSource === "final-classification" ? (f1.resultStatus ?? null) : null,
        },
      ];
    }
    observation.rosterAuthoritative = f1.packetId === 4 && f1.grid != null && f1.grid.length > 0;
    return observation;
  },

  lapDetectorId: LAP_DETECTOR_ID,

  createLapDetector: (opts) => new LapDetector(opts),
};
