import type { TelemetryPacket } from "./types";

/**
 * Minimal packet projection consumed by lap detection. Canonical parsers may
 * return this shape during metadata scans without materializing live-only
 * telemetry fields.
 */
export type LapIndexPacket = Pick<
  TelemetryPacket,
  | "gameId"
  | "acEvoIdentity"
  | "carModelName"
  | "sessionUID"
  | "IsRaceOn"
  | "TimestampMS"
  | "carId"
  | "trackId"
  | "CarPerformanceIndex"
  | "CarClass"
  | "LapNumber"
  | "CurrentLap"
  | "LastLap"
  | "PositionX"
  | "PositionZ"
  | "BestLap"
  | "DistanceTraveled"
  | "Yaw"
  | "Fuel"
  | "TireWearFL"
  | "TireWearFR"
  | "TireWearRL"
  | "TireWearRR"
  | "RacePosition"
  | "WheelOnRumbleStripFL"
  | "WheelOnRumbleStripFR"
  | "WheelOnRumbleStripRL"
  | "WheelOnRumbleStripRR"
  | "f1"
  | "acc"
  | "iracing"
> & Partial<Pick<TelemetryPacket, "PositionY" | "Speed">>;
