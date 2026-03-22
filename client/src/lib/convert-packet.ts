import type { TelemetryPacket } from "@shared/types";
import { convertSpeed } from "./speed";
import { convertTemp } from "./temperature";

export interface DisplayPacket extends TelemetryPacket {
  /** Speed in user's unit (mph or km/h) */
  DisplaySpeed: number;
  /** Tire temps in user's unit (°F or °C) */
  DisplayTireTempFL: number;
  DisplayTireTempFR: number;
  DisplayTireTempRL: number;
  DisplayTireTempRR: number;
}

/**
 * Convert a raw telemetry packet's display fields to the user's preferred units.
 * Raw fields are preserved unchanged for calculations (slip, suspension, etc.).
 * Display* fields are added for UI rendering.
 */
export function convertPacket(
  raw: TelemetryPacket,
  speedUnit: "mph" | "kmh",
  tempUnit: "F" | "C"
): DisplayPacket {
  return {
    ...raw,
    DisplaySpeed: convertSpeed(raw.Speed, speedUnit),
    DisplayTireTempFL: convertTemp(raw.TireTempFL, tempUnit),
    DisplayTireTempFR: convertTemp(raw.TireTempFR, tempUnit),
    DisplayTireTempRL: convertTemp(raw.TireTempRL, tempUnit),
    DisplayTireTempRR: convertTemp(raw.TireTempRR, tempUnit),
  };
}

/**
 * Convert an array of telemetry packets (for historical lap data).
 */
export function convertPackets(
  packets: TelemetryPacket[],
  speedUnit: "mph" | "kmh",
  tempUnit: "F" | "C"
): DisplayPacket[] {
  return packets.map((p) => convertPacket(p, speedUnit, tempUnit));
}
