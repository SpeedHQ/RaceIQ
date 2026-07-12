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
 *
 * Forza sends temps in °F, F1/ACC send in °C — source unit is game-aware.
 */
export function convertPacket(raw: TelemetryPacket, speedUnit: "mph" | "kmh", tempUnit: "F" | "C"): DisplayPacket {
  // Forza temps are Fahrenheit, F1 and ACC are Celsius
  const srcTemp = raw.gameId === "fm-2023" ? ("F" as const) : ("C" as const);
  return {
    ...raw,
    DisplaySpeed: convertSpeed(raw.Speed, speedUnit),
    DisplayTireTempFL: convertTemp(raw.TireTempFL, tempUnit, srcTemp),
    DisplayTireTempFR: convertTemp(raw.TireTempFR, tempUnit, srcTemp),
    DisplayTireTempRL: convertTemp(raw.TireTempRL, tempUnit, srcTemp),
    DisplayTireTempRR: convertTemp(raw.TireTempRR, tempUnit, srcTemp),
  };
}

/**
 * Convert an array of telemetry packets (for historical lap data).
 */
export function convertPackets(packets: TelemetryPacket[], speedUnit: "mph" | "kmh", tempUnit: "F" | "C"): DisplayPacket[] {
  return packets.map((p) => convertPacket(p, speedUnit, tempUnit));
}
