import type { TelemetryPacket } from "../telemetry/types";
import type { TelemetryModel } from "./types";

export const WATTS_PER_HORSEPOWER = 745.7;

export interface FuelAmount {
  amount: number;
  unit: "%" | "L";
}

export interface FuelDisplay extends FuelAmount {
  /** Tank fill from 0 to 1 when the packet carries a real capacity. */
  fillRatio?: number;
}

function clampRatio(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function getFuelAmount(value: number, spec: TelemetryModel["fuel"]): FuelAmount {
  if (spec.packetUnit === "fraction") {
    return { amount: value * 100, unit: "%" };
  }
  return { amount: value, unit: "L" };
}

export function getFuelDisplay(packet: Pick<TelemetryPacket, "Fuel" | "FuelCapacity">, spec: TelemetryModel["fuel"]): FuelDisplay {
  const display = getFuelAmount(packet.Fuel, spec);
  if (spec.packetUnit === "fraction") {
    return { ...display, fillRatio: clampRatio(packet.Fuel) };
  }
  if (packet.FuelCapacity !== undefined && Number.isFinite(packet.FuelCapacity) && packet.FuelCapacity > 0) {
    return {
      ...display,
      fillRatio: clampRatio(packet.Fuel / packet.FuelCapacity),
    };
  }
  return display;
}

export function getFuelDisplaySemantic(fuel: number, capacity: number | undefined, spec: TelemetryModel["fuel"]): FuelDisplay {
  return getFuelDisplay({ Fuel: fuel, FuelCapacity: capacity }, spec);
}

export function getTireTemperatureSourceUnit(spec: TelemetryModel["tireTemperature"]): "C" | "F" {
  return spec.packetUnit === "fahrenheit" ? "F" : "C";
}

/**
 * Resolve display power in HP from the game's declared power channel.
 * Every power channel emits canonical watts (see `ScalarTelemetrySpec`);
 * display consumers own the horsepower conversion. Returns 0 when the
 * game provides no power telemetry.
 */
export function getDisplayPower(packet: Pick<TelemetryPacket, "Power">, spec: TelemetryModel["power"]): number {
  return spec ? packet.Power / WATTS_PER_HORSEPOWER : 0;
}

/**
 * Resolve display torque in Nm from the game's declared torque channel.
 * Torque channels are canonical newton-metres. Returns 0 when the game
 * provides no torque telemetry.
 */
export function getDisplayTorque(packet: Pick<TelemetryPacket, "Torque">, spec: TelemetryModel["torque"]): number {
  return spec ? packet.Torque : 0;
}

/**
 * Whether a sample is eligible for power-curve accumulation under the
 * game's declared `gearing` validity rules. Games without declared rules
 * accept every sample.
 */
export function isGearingSampleValid(packet: Pick<TelemetryPacket, "IsRaceOn" | "Gear">, telemetry: TelemetryModel): boolean {
  const rules = telemetry.gearing;
  if (!rules) return true;
  if (rules.requireRaceOn && packet.IsRaceOn <= 0) return false;
  if (rules.neutralGear !== undefined && packet.Gear === rules.neutralGear) return false;
  if (rules.reverseGear !== undefined && packet.Gear === rules.reverseGear) return false;
  return true;
}
