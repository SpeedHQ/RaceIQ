import type { PacketUnit } from "../../shared/games/types";
import { packetSequences } from "../../shared/telemetry/source-sequence";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import type {
  FourCornerRaceEventValue,
  RaceEventObservation,
  RaceEventObservationContext,
  RaceParticipantObservation,
} from "./types";

function finite(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function nonNegative(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function normalizedFuelLitres(
  packet: TelemetryPacket,
  packetUnit: PacketUnit,
): number | null {
  if (packetUnit === "litre") return nonNegative(packet.Fuel);
  if (
    packetUnit === "fraction" &&
    Number.isFinite(packet.Fuel) &&
    packet.Fuel >= 0 &&
    packet.FuelCapacity != null &&
    Number.isFinite(packet.FuelCapacity) &&
    packet.FuelCapacity > 0
  ) {
    return packet.Fuel * packet.FuelCapacity;
  }
  return null;
}

export function normalizedTireWear(
  packet: TelemetryPacket,
): FourCornerRaceEventValue | null {
  const values = [
    packet.TireWearFL,
    packet.TireWearFR,
    packet.TireWearRL,
    packet.TireWearRR,
  ];
  if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
    return null;
  }
  return {
    fl: packet.TireWearFL,
    fr: packet.TireWearFR,
    rl: packet.TireWearRL,
    rr: packet.TireWearRR,
  };
}

export function normalizedWorldPosition(
  packet: TelemetryPacket,
): RaceEventObservation["worldPosition"] {
  return Number.isFinite(packet.PositionX) &&
    Number.isFinite(packet.PositionY) &&
    Number.isFinite(packet.PositionZ)
    ? { x: packet.PositionX, y: packet.PositionY, z: packet.PositionZ }
    : null;
}

export function baseRaceEventObservation(
  packet: TelemetryPacket,
  context: RaceEventObservationContext,
): RaceEventObservation {
  return {
    gameId: packet.gameId,
    sessionUid: packet.sessionUID ?? null,
    receivedAtMs: context.receivedAtMs,
    sourceTimeMs: packet.TimestampMS,
    sourceSequences: packetSequences(packet),
    lapNumber:
      Number.isInteger(packet.LapNumber) && packet.LapNumber >= 0
        ? packet.LapNumber
        : null,
    currentLapTimeMs:
      Number.isFinite(packet.CurrentLap) && packet.CurrentLap >= 0
        ? packet.CurrentLap * 1000
        : null,
    lastLapTimeMs:
      Number.isFinite(packet.LastLap) && packet.LastLap >= 0
        ? packet.LastLap * 1000
        : null,
    trackDistanceM: finite(packet.DistanceTraveled),
    trackDistancePct: null,
    worldPosition: normalizedWorldPosition(packet),
    sessionPhase: packet.IsRaceOn === 0 ? "inactive" : "unknown",
    nativeRaceControlCode: null,
    cautionKind: "unknown",
    gridStart: null,
    terminalObserved: null,
    participants: [],
    rosterAuthoritative: false,
  };
}

export function localPlayerObservation(
  packet: TelemetryPacket,
  input: Pick<
    RaceParticipantObservation,
    | "pitState"
    | "nativePitCode"
    | "fuelLitres"
    | "tireCompound"
    | "tireWear"
    | "damage"
    | "penaltyValue"
    | "incidentCount"
  > &
    Partial<
      Pick<
        RaceParticipantObservation,
        | "driverId"
        | "teamId"
        | "displayName"
        | "vehicleId"
        | "retirementStatus"
        | "nativeRetirementCode"
      >
    >,
): RaceParticipantObservation {
  return {
    participantId: "local-player",
    participantKind: "player",
    sourceId: null,
    identityState: "stable",
    driverId: input.driverId ?? null,
    teamId: input.teamId ?? null,
    displayName: input.displayName ?? null,
    vehicleId: input.vehicleId ?? `${packet.gameId}-car:${packet.CarOrdinal}`,
    pitState: input.pitState,
    nativePitCode: input.nativePitCode,
    position:
      Number.isInteger(packet.RacePosition) && packet.RacePosition > 0
        ? packet.RacePosition
        : null,
    speedMps: nonNegative(packet.Speed),
    fuelLitres: input.fuelLitres,
    tireCompound: input.tireCompound,
    tireWear: input.tireWear,
    damage: input.damage,
    penaltyValue: input.penaltyValue,
    incidentCount: input.incidentCount,
    retirementStatus: input.retirementStatus ?? "unknown",
    nativeRetirementCode: input.nativeRetirementCode ?? null,
  };
}

export function kunosDamagePercent(
  packet: TelemetryPacket,
): Readonly<Record<string, number>> | null {
  const damage = packet.acc?.carDamage;
  if (!damage) return null;
  return Object.fromEntries(
    Object.entries(damage).map(([component, value]) => [
      component,
      Math.max(0, Math.min(100, value * 100)),
    ] as const),
  );
}
