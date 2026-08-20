import { getGame } from "@shared/games/registry";
import { getTireTemperatureSourceUnit } from "@shared/games/telemetry";
import type { TelemetryPacket } from "../../../shared/telemetry/types";
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
  /** Power in HP (game-normalized). 0 if game does not provide power telemetry. */
  DisplayPower: number;
  /** Torque in Nm. 0 if game does not provide torque telemetry. */
  DisplayTorque: number;
}

/**
 * Convert a raw telemetry packet's display fields to the user's preferred units.
 * Raw fields are preserved unchanged for calculations (slip, suspension, etc.).
 * Display* fields are added for UI rendering.
 *
 * The game adapter declares the packet's tire-temperature unit.
 */
export function convertPacket(raw: TelemetryPacket, speedUnit: "mph" | "kmh", tempUnit: "F" | "C"): DisplayPacket {
  const srcTemp = getTireTemperatureSourceUnit(getGame(raw.gameId).telemetry.tireTemperature);
  return {
    ...raw,
    DisplaySpeed: convertSpeed(raw.Speed, speedUnit),
    DisplayTireTempFL: convertTemp(raw.TireTempFL, tempUnit, srcTemp),
    DisplayTireTempFR: convertTemp(raw.TireTempFR, tempUnit, srcTemp),
    DisplayTireTempRL: convertTemp(raw.TireTempRL, tempUnit, srcTemp),
    DisplayTireTempRR: convertTemp(raw.TireTempRR, tempUnit, srcTemp),
    DisplayPower: raw.gameId === "fm-2023" ? raw.Power / 745.7
                : raw.gameId === "f1-2025" ? raw.Power
                : 0,
    DisplayTorque: raw.gameId === "fm-2023" ? raw.Torque : 0,
  };
}

/**
 * Convert an array of telemetry packets (for historical lap data).
 */
export function convertPackets(packets: TelemetryPacket[], speedUnit: "mph" | "kmh", tempUnit: "F" | "C"): DisplayPacket[] {
  return packets.map((p) => convertPacket(p, speedUnit, tempUnit));
}
